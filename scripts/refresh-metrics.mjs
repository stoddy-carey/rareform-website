#!/usr/bin/env node
// Refreshes data/metrics.json by calling Apify (Instagram + TikTok) and
// Phantombuster (LinkedIn) — the two services we already pay for.
//
// Substack pulls live via RSS client-side, so we don't touch it here.
//
// Required env (set as GitHub repo secrets, surfaced by the workflow):
//   APIFY_TOKEN                         – single Apify token, covers all actors
//   APIFY_IG_ACTOR                      – optional, defaults to apify/instagram-profile-scraper
//   APIFY_TIKTOK_ACTOR                  – optional, defaults to clockworks/tiktok-scraper
//   PHANTOMBUSTER_API_KEY               – your Phantombuster API key
//   PHANTOMBUSTER_LI_AGENT_ID           – the agent ID of your "LinkedIn Profile Scraper" phantom
//   PHANTOMBUSTER_LI_SESSION_COOKIE     – the li_at session cookie (PB needs one to scrape)
//
// Missing creds for a backend → that backend is skipped (others still run).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = join(__dirname, '..', 'data', 'metrics.json');
const HISTORY_LIMIT = 12;

const {
  APIFY_TOKEN,
  APIFY_IG_ACTOR = 'apify/instagram-profile-scraper',
  APIFY_TIKTOK_ACTOR = 'clockworks/tiktok-scraper',
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_LI_AGENT_ID,
  PHANTOMBUSTER_LI_SESSION_COOKIE
} = process.env;

// ─── Apify ──────────────────────────────────────────────
// Run an actor synchronously and get the dataset items in one call.
// Docs: https://docs.apify.com/api/v2#tag/Actor-runs/operation/act_runs_post
async function runApifyActor(actorId, input) {
  const url = `https://api.apify.com/v2/acts/${actorId.replace('/', '~')}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=180`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Apify ${actorId} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchInstagramBatch(handles) {
  if (!APIFY_TOKEN || handles.length === 0) return {};
  console.log(`[Apify] Instagram → ${handles.join(', ')}`);
  const items = await runApifyActor(APIFY_IG_ACTOR, {
    usernames: handles,
    resultsType: 'details',
    resultsLimit: 1
  });
  const out = {};
  for (const item of (items || [])) {
    const handle = (item.username || '').toLowerCase();
    if (!handle) continue;
    const latest = (item.latestPosts || item.latestIgtvs || [])[0];
    out[handle] = {
      followers:    item.followersCount ?? item.followers ?? null,
      postsThisWeek: countRecent(item.latestPosts, 7, p => p.timestamp || p.takenAtTimestamp),
      latestPost: latest ? {
        caption: (latest.caption || '').slice(0, 140),
        url:     latest.url || latest.shortCode ? `https://instagram.com/p/${latest.shortCode}` : `https://instagram.com/${handle}`,
        date:    isoDay(latest.timestamp || latest.takenAtTimestamp)
      } : null,
      recentDates: (item.latestPosts || []).map(p => isoDay(p.timestamp || p.takenAtTimestamp)).filter(Boolean)
    };
  }
  return out;
}

async function fetchTikTokBatch(handles) {
  if (!APIFY_TOKEN || handles.length === 0) return {};
  console.log(`[Apify] TikTok → ${handles.join(', ')}`);
  const items = await runApifyActor(APIFY_TIKTOK_ACTOR, {
    profiles: handles,
    resultsPerPage: 5,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false
  });
  // clockworks/tiktok-scraper returns one item per video, grouped under
  // authorMeta. Roll them up by author.
  const grouped = new Map();
  for (const item of (items || [])) {
    const author = item.authorMeta || item.author || {};
    const handle = (author.name || author.uniqueId || '').toLowerCase();
    if (!handle) continue;
    if (!grouped.has(handle)) {
      grouped.set(handle, {
        followers: author.fans ?? author.followerCount ?? null,
        videos: []
      });
    }
    grouped.get(handle).videos.push(item);
  }
  const out = {};
  for (const [handle, data] of grouped) {
    const latest = data.videos[0];
    const weekAgoSec = Math.floor((Date.now() - 7 * 86400e3) / 1000);
    out[handle] = {
      followers: data.followers,
      postsThisWeek: data.videos.filter(v => (v.createTime || v.createTimeISO ? Date.parse(v.createTimeISO || 0) / 1000 : 0) > weekAgoSec).length,
      viewsLast30d: data.videos.reduce((s, v) => s + (v.playCount || v.views || 0), 0),
      latestPost: latest ? {
        caption: (latest.text || latest.title || '').slice(0, 140),
        url:     latest.webVideoUrl || latest.shareUrl || `https://tiktok.com/@${handle}`,
        date:    isoDay(latest.createTimeISO || (latest.createTime ? latest.createTime * 1000 : null))
      } : null,
      recentDates: data.videos.map(v => isoDay(v.createTimeISO || (v.createTime ? v.createTime * 1000 : null))).filter(Boolean)
    };
  }
  return out;
}

// ─── Phantombuster ──────────────────────────────────────
// Launch an agent and poll until done, then fetch output.
// Docs: https://hub.phantombuster.com/reference/post_agents-launch-1
async function launchPhantom(agentId, args) {
  const res = await fetch('https://api.phantombuster.com/api/v2/agents/launch', {
    method: 'POST',
    headers: {
      'X-Phantombuster-Key': PHANTOMBUSTER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ id: agentId, argument: args })
  });
  if (!res.ok) throw new Error(`PB launch ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.containerId;
}

async function waitForPhantom(containerId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`https://api.phantombuster.com/api/v2/containers/fetch?id=${containerId}`, {
      headers: { 'X-Phantombuster-Key': PHANTOMBUSTER_API_KEY }
    });
    if (!res.ok) throw new Error(`PB fetch ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.status === 'finished' || body.status === 'finished_with_errors') return body;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('PB container timed out');
}

async function fetchPhantomResult(containerId) {
  const res = await fetch(`https://api.phantombuster.com/api/v2/containers/fetch-result-object?id=${containerId}`, {
    headers: { 'X-Phantombuster-Key': PHANTOMBUSTER_API_KEY }
  });
  if (!res.ok) throw new Error(`PB result ${res.status}: ${await res.text()}`);
  const body = await res.json();
  try { return JSON.parse(body.resultObject || '[]'); } catch { return []; }
}

async function fetchLinkedInBatch(profiles) {
  if (!PHANTOMBUSTER_API_KEY || !PHANTOMBUSTER_LI_AGENT_ID || !PHANTOMBUSTER_LI_SESSION_COOKIE || profiles.length === 0) {
    if (profiles.length > 0) console.log('[PB] LinkedIn: missing PHANTOMBUSTER_API_KEY / agent ID / session cookie — skipping');
    return {};
  }
  console.log(`[PB] LinkedIn → ${profiles.map(p => p.url).join(', ')}`);
  const containerId = await launchPhantom(PHANTOMBUSTER_LI_AGENT_ID, {
    sessionCookie: PHANTOMBUSTER_LI_SESSION_COOKIE,
    profileUrls: profiles.map(p => p.url),
    // The PB Profile Scraper agent often expects a CSV/spreadsheet input.
    // For modern versions it accepts an inline array; older agents may
    // need spreadsheetUrl. Adjust if your specific phantom needs different args.
    numberOfLinesPerLaunch: profiles.length
  });
  await waitForPhantom(containerId);
  const rows = await fetchPhantomResult(containerId);

  const out = {};
  for (const row of (rows || [])) {
    const url = (row.profileUrl || row.linkedinProfileUrl || row.url || '').toLowerCase();
    if (!url) continue;
    out[url] = {
      followers: row.followersCount ?? row.followers ?? row.connectionsCount ?? null,
      headline:  row.headline || row.title || null
    };
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────
function isoDay(ts) {
  if (!ts) return null;
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function countRecent(items, days, getTs) {
  if (!items) return 0;
  const cutoff = Date.now() - days * 86400e3;
  return items.filter(it => {
    const ts = getTs(it);
    if (!ts) return false;
    const n = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    return n > cutoff;
  }).length;
}

function appendHistory(existing, newValue) {
  if (newValue == null) return existing || [];
  const arr = (existing || []).slice();
  if (arr.length === 0 || arr[arr.length - 1] !== newValue) arr.push(newValue);
  return arr.slice(-HISTORY_LIMIT);
}

function bumpShipsByDay(shipsByDay, dates) {
  const out = Object.assign({}, shipsByDay || {});
  (dates || []).forEach(d => { if (d) out[d] = (out[d] || 0) + 1; });
  return out;
}

// ─── main ───────────────────────────────────────────────
async function main() {
  const raw = await readFile(METRICS_PATH, 'utf8');
  const metrics = JSON.parse(raw);

  // Collect handles to refresh per backend
  const igHandles = [];
  const tiktokHandles = [];
  const linkedinUrls = [];

  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      if (channel.platform === 'instagram') igHandles.push(channel.handle);
      else if (channel.platform === 'tiktok') tiktokHandles.push(channel.handle);
      else if (channel.platform === 'linkedin') linkedinUrls.push({ url: channel.url, channel });
    }
  }
  for (const member of metrics.team || []) {
    if (member.linkedin) linkedinUrls.push({ url: member.linkedin, member });
  }

  const [igData, tiktokData, linkedinData] = await Promise.all([
    fetchInstagramBatch(igHandles).catch(e => { console.error('IG batch failed:', e.message); return {}; }),
    fetchTikTokBatch(tiktokHandles).catch(e => { console.error('TT batch failed:', e.message); return {}; }),
    fetchLinkedInBatch(linkedinUrls).catch(e => { console.error('LI batch failed:', e.message); return {}; })
  ]);

  let updated = 0;

  // Apply to channels
  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      let fresh = null;
      if (channel.platform === 'instagram') fresh = igData[channel.handle.toLowerCase()];
      else if (channel.platform === 'tiktok') fresh = tiktokData[channel.handle.toLowerCase()];
      else if (channel.platform === 'linkedin') fresh = linkedinData[(channel.url || '').toLowerCase()];

      if (!fresh || fresh.followers == null) continue;
      const prev = channel.followers || 0;
      channel.followers = fresh.followers;
      channel.weeklyDelta = fresh.followers - prev;
      if (fresh.postsThisWeek != null) channel.postsThisWeek = fresh.postsThisWeek;
      if (fresh.viewsLast30d != null) channel.viewsLast30d = fresh.viewsLast30d;
      channel.history = appendHistory(channel.history, fresh.followers);
      if (fresh.latestPost) channel.latestPost = fresh.latestPost;
      if (fresh.recentDates) metrics.shipsByDay = bumpShipsByDay(metrics.shipsByDay, fresh.recentDates);
      updated++;
      console.log(`✓ ${channel.platform} @${channel.handle}: ${fresh.followers} followers`);
    }
  }

  // Apply to team LinkedIns
  for (const member of metrics.team || []) {
    const fresh = linkedinData[(member.linkedin || '').toLowerCase()];
    if (!fresh || fresh.followers == null) continue;
    member.followers = fresh.followers;
    if (fresh.headline) member.role = member.role || fresh.headline;
    updated++;
    console.log(`✓ team ${member.name}: ${fresh.followers} followers`);
  }

  if (updated > 0) {
    metrics.lastUpdated = new Date().toISOString();
    metrics.source = 'api';
    await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`\nDone. Updated ${updated} record(s).`);
  } else {
    console.log('\nNo records updated. metrics.json untouched.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
