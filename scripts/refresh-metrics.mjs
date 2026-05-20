#!/usr/bin/env node
// Refreshes data/metrics.json with live numbers from Instagram Graph + TikTok Display APIs,
// for every IG/TikTok channel listed under properties[].channels[] in the JSON.
//
// Substack is fetched live client-side via RSS, so we don't touch it here.
// LinkedIn personal-profile followers have no public API; those stay manual.
// LinkedIn *company* pages can be wired up later via the Marketing API.
//
// Env conventions (set as GitHub repo secrets, surfaced via the workflow):
//   IG_ACCESS_TOKEN              – long-lived Page token w/ instagram_basic. One token can
//                                   cover every IG Business account the token's owner admins.
//   IG_USER_ID_<HANDLE>          – numeric IG Business account ID, per handle. e.g.
//                                   IG_USER_ID_OUTCURVEHEALTH, IG_USER_ID_RAREFORM030,
//                                   IG_USER_ID_STODDYCAREY
//   TT_TOKEN_<HANDLE>            – TikTok Display API user access token, per handle.
//
// Handle → env-var rule: uppercase, non-alphanumeric replaced with `_`.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = join(__dirname, '..', 'data', 'metrics.json');
const HISTORY_LIMIT = 12;

const { IG_ACCESS_TOKEN } = process.env;
const envKey = (handle) => handle.toUpperCase().replace(/[^A-Z0-9]/g, '_');

async function fetchInstagram(handle) {
  const userId = process.env[`IG_USER_ID_${envKey(handle)}`];
  if (!userId || !IG_ACCESS_TOKEN) {
    console.log(`⏭  Instagram @${handle}: missing IG_ACCESS_TOKEN or IG_USER_ID_${envKey(handle)}`);
    return null;
  }
  const profile = await (await fetch(
    `https://graph.facebook.com/v19.0/${userId}?fields=followers_count,media_count&access_token=${IG_ACCESS_TOKEN}`
  )).json();
  if (profile.error) throw new Error(`IG @${handle} profile: ${profile.error.message}`);

  const media = await (await fetch(
    `https://graph.facebook.com/v19.0/${userId}/media?fields=caption,permalink,timestamp&limit=10&access_token=${IG_ACCESS_TOKEN}`
  )).json();
  if (media.error) throw new Error(`IG @${handle} media: ${media.error.message}`);

  const items = media.data || [];
  const latest = items[0];
  const weekAgo = Date.now() - 7 * 86400e3;
  const postsThisWeek = items.filter(m => new Date(m.timestamp).getTime() > weekAgo).length;

  return {
    followers: profile.followers_count,
    postsThisWeek,
    latestPost: latest ? {
      caption: (latest.caption || '').slice(0, 140),
      url: latest.permalink,
      date: latest.timestamp.slice(0, 10)
    } : null,
    recentDates: items.map(m => m.timestamp.slice(0, 10))
  };
}

async function fetchTikTok(handle) {
  const token = process.env[`TT_TOKEN_${envKey(handle)}`];
  if (!token) {
    console.log(`⏭  TikTok @${handle}: missing TT_TOKEN_${envKey(handle)}`);
    return null;
  }
  const info = await (await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=follower_count,video_count',
    { headers: { Authorization: `Bearer ${token}` } }
  )).json();
  if (info.error?.code && info.error.code !== 'ok') throw new Error(`TT @${handle} info: ${info.error.message}`);
  const user = info.data?.user;

  const list = await (await fetch(
    'https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,share_url,view_count',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: 10 })
    }
  )).json();
  if (list.error?.code && list.error.code !== 'ok') throw new Error(`TT @${handle} list: ${list.error.message}`);

  const videos = list.data?.videos || [];
  const latest = videos[0];
  const weekAgo = Math.floor((Date.now() - 7 * 86400e3) / 1000);
  const postsThisWeek = videos.filter(v => v.create_time > weekAgo).length;

  return {
    followers: user?.follower_count,
    postsThisWeek,
    viewsLast30d: videos.reduce((s, v) => s + (v.view_count || 0), 0),
    latestPost: latest ? {
      caption: (latest.title || '').slice(0, 140),
      url: latest.share_url,
      date: new Date(latest.create_time * 1000).toISOString().slice(0, 10)
    } : null,
    recentDates: videos.map(v => new Date(v.create_time * 1000).toISOString().slice(0, 10))
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
  (dates || []).forEach(d => { out[d] = (out[d] || 0) + 1; });
  return out;
}

async function main() {
  const raw = await readFile(METRICS_PATH, 'utf8');
  const metrics = JSON.parse(raw);

  let refreshed = 0, skipped = 0, errors = 0;

  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      const fetcher = channel.platform === 'instagram' ? fetchInstagram
                    : channel.platform === 'tiktok'    ? fetchTikTok
                    : null;
      if (!fetcher) { skipped++; continue; }

      try {
        const fresh = await fetcher(channel.handle);
        if (!fresh) { skipped++; continue; }

        const prevFollowers = channel.followers || 0;
        channel.followers   = fresh.followers ?? channel.followers;
        channel.weeklyDelta = (fresh.followers ?? prevFollowers) - prevFollowers;
        channel.postsThisWeek = fresh.postsThisWeek;
        if (fresh.viewsLast30d != null) channel.viewsLast30d = fresh.viewsLast30d;
        channel.history = appendHistory(channel.history, fresh.followers);
        if (fresh.latestPost) channel.latestPost = fresh.latestPost;
        metrics.shipsByDay = bumpShipsByDay(metrics.shipsByDay, fresh.recentDates);
        refreshed++;
        console.log(`✓ ${channel.platform} @${channel.handle}: ${fresh.followers} followers`);
      } catch (err) {
        errors++;
        console.error(`✗ ${channel.platform} @${channel.handle}: ${err.message}`);
      }
    }
  }

  if (refreshed > 0) {
    metrics.lastUpdated = new Date().toISOString();
    metrics.source = errors === 0 ? 'api' : 'partial';
    await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`\nDone. Refreshed=${refreshed}, Skipped=${skipped}, Errors=${errors}`);
  } else {
    console.log(`\nNo channels refreshed (Skipped=${skipped}, Errors=${errors}). metrics.json untouched.`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
