#!/usr/bin/env node
// Refreshes data/metrics.json with live numbers from Instagram Graph + TikTok Display APIs.
//
// Required env (set as repo secrets, surfaced via the workflow):
//   IG_USER_ID            – numeric Instagram Business/Creator account ID
//   IG_ACCESS_TOKEN       – long-lived Page access token w/ instagram_basic + instagram_manage_insights
//   TT_ACCESS_TOKEN       – TikTok Display API user access token
//
// Substack is fetched live client-side via RSS, so we don't touch it here.
// History arrays are appended to (kept to last 12 weekly snapshots) so sparklines stay continuous.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = join(__dirname, '..', 'data', 'metrics.json');
const HISTORY_LIMIT = 12;

const { IG_USER_ID, IG_ACCESS_TOKEN, TT_ACCESS_TOKEN } = process.env;

async function fetchInstagram() {
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) {
    console.log('⏭  Instagram: tokens missing, skipping');
    return null;
  }
  const fields = 'followers_count,media_count';
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}?fields=${fields}&access_token=${IG_ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IG profile fetch ${res.status}: ${await res.text()}`);
  const profile = await res.json();

  const mediaUrl = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media?fields=caption,permalink,timestamp&limit=5&access_token=${IG_ACCESS_TOKEN}`;
  const mediaRes = await fetch(mediaUrl);
  if (!mediaRes.ok) throw new Error(`IG media fetch ${mediaRes.status}`);
  const media = await mediaRes.json();
  const latest = media.data && media.data[0];

  const oneWeekAgo = Date.now() - 7 * 86400e3;
  const postsThisWeek = (media.data || []).filter(m => new Date(m.timestamp).getTime() > oneWeekAgo).length;

  return {
    followers: profile.followers_count,
    postsThisWeek,
    latestPost: latest ? {
      caption: (latest.caption || '').slice(0, 140),
      url: latest.permalink,
      date: latest.timestamp.slice(0, 10)
    } : null,
    recentMediaDates: (media.data || []).map(m => m.timestamp.slice(0, 10))
  };
}

async function fetchTikTok() {
  if (!TT_ACCESS_TOKEN) {
    console.log('⏭  TikTok: token missing, skipping');
    return null;
  }
  const infoRes = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count,video_count', {
    headers: { Authorization: `Bearer ${TT_ACCESS_TOKEN}` }
  });
  if (!infoRes.ok) throw new Error(`TikTok user info ${infoRes.status}: ${await infoRes.text()}`);
  const info = await infoRes.json();
  const user = info.data && info.data.user;

  const listRes = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,share_url,view_count', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ max_count: 10 })
  });
  if (!listRes.ok) throw new Error(`TikTok list ${listRes.status}`);
  const list = await listRes.json();
  const videos = (list.data && list.data.videos) || [];
  const latest = videos[0];

  const oneWeekAgo = Math.floor((Date.now() - 7 * 86400e3) / 1000);
  const postsThisWeek = videos.filter(v => v.create_time > oneWeekAgo).length;
  const viewsLast30d = videos.reduce((sum, v) => sum + (v.view_count || 0), 0);

  return {
    followers: user.follower_count,
    postsThisWeek,
    viewsLast30d,
    latestPost: latest ? {
      caption: (latest.title || '').slice(0, 140),
      url: latest.share_url,
      date: new Date(latest.create_time * 1000).toISOString().slice(0, 10)
    } : null,
    recentVideoDates: videos.map(v => new Date(v.create_time * 1000).toISOString().slice(0, 10))
  };
}

function appendHistory(existing, newValue) {
  if (newValue == null) return existing || [];
  const arr = (existing || []).slice();
  if (arr.length === 0 || arr[arr.length - 1] !== newValue) arr.push(newValue);
  return arr.slice(-HISTORY_LIMIT);
}

function bumpShipsByDay(shipsByDay, dates) {
  const out = Object.assign({}, shipsByDay || {});
  (dates || []).forEach(d => {
    out[d] = (out[d] || 0) + 1;
  });
  return out;
}

async function main() {
  const raw = await readFile(METRICS_PATH, 'utf8');
  const metrics = JSON.parse(raw);

  const [ig, tt] = await Promise.all([
    fetchInstagram().catch(e => { console.error('IG error:', e.message); return null; }),
    fetchTikTok().catch(e => { console.error('TT error:', e.message); return null; })
  ]);

  let changed = false;

  if (ig) {
    const prev = metrics.platforms.instagram || {};
    const prevFollowers = prev.followers || 0;
    metrics.platforms.instagram = {
      ...prev,
      followers: ig.followers,
      weeklyDelta: ig.followers - prevFollowers,
      postsThisWeek: ig.postsThisWeek,
      history: appendHistory(prev.history, ig.followers),
      latestPost: ig.latestPost || prev.latestPost
    };
    changed = true;
  }

  if (tt) {
    const prev = metrics.platforms.tiktok || {};
    const prevFollowers = prev.followers || 0;
    metrics.platforms.tiktok = {
      ...prev,
      followers: tt.followers,
      weeklyDelta: tt.followers - prevFollowers,
      postsThisWeek: tt.postsThisWeek,
      viewsLast30d: tt.viewsLast30d,
      history: appendHistory(prev.history, tt.followers),
      latestPost: tt.latestPost || prev.latestPost
    };
    changed = true;
  }

  if (changed) {
    metrics.lastUpdated = new Date().toISOString();
    metrics.source = (ig && tt) ? 'api' : 'partial';
    // Roll up post dates into shipsByDay so the heatmap stays accurate
    if (ig && ig.recentMediaDates) metrics.shipsByDay = bumpShipsByDay(metrics.shipsByDay, ig.recentMediaDates);
    if (tt && tt.recentVideoDates) metrics.shipsByDay = bumpShipsByDay(metrics.shipsByDay, tt.recentVideoDates);
    await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log('✓ metrics.json updated');
  } else {
    console.log('No tokens available; metrics.json untouched.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
