#!/usr/bin/env node
// Refreshes data/metrics.json by calling Apify actors for every platform.
// One service, one API token, one code pattern.
//
// Substack pulls live via RSS client-side, so we don't touch it here.
//
// Required env (set as GitHub repo secrets, surfaced by the workflow):
//   APIFY_TOKEN                       – the only secret you have to set
//
// Optional env (override the default actors if you want a different scraper):
//   APIFY_IG_ACTOR                    – default apify/instagram-profile-scraper
//   APIFY_TIKTOK_ACTOR                – default clockworks/tiktok-scraper
//   APIFY_LINKEDIN_PROFILE_ACTOR      – default dev_fusion/linkedin-profile-scraper
//   APIFY_LINKEDIN_COMPANY_ACTOR      – default apimaestro/linkedin-company-page-detail
//   LINKEDIN_SESSION_COOKIE           – only required if the LinkedIn actor you
//                                       picked needs a session cookie (the li_at
//                                       value from a logged-in LinkedIn browser
//                                       tab). Default actors don't need it.
//
// Adding a new platform = add one more actor ID and one more fetch helper.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = join(__dirname, '..', 'data', 'metrics.json');
const HISTORY_LIMIT = 12;

const APIFY_TOKEN                  = process.env.APIFY_TOKEN;
const APIFY_IG_ACTOR               = process.env.APIFY_IG_ACTOR               || 'apify/instagram-profile-scraper';
const APIFY_TIKTOK_ACTOR           = process.env.APIFY_TIKTOK_ACTOR           || 'clockworks/tiktok-scraper';
const APIFY_LINKEDIN_PROFILE_ACTOR = process.env.APIFY_LINKEDIN_PROFILE_ACTOR || 'dev_fusion/linkedin-profile-scraper';
const APIFY_LINKEDIN_COMPANY_ACTOR = process.env.APIFY_LINKEDIN_COMPANY_ACTOR || 'apimaestro/linkedin-company-detail';
const LINKEDIN_SESSION_COOKIE      = process.env.LINKEDIN_SESSION_COOKIE      || '';

// ─── Apify helper ──────────────────────────────────────
// Run an actor synchronously and get the dataset items in one call.
// Docs: https://docs.apify.com/api/v2#tag/Actor-runs/operation/act_runs_post
async function runApifyActor(actorId, input) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  const url = `https://api.apify.com/v2/acts/${actorId.replace('/', '~')}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=180`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Apify ${actorId} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Platform fetchers ─────────────────────────────────
async function fetchInstagramBatch(handles) {
  if (!APIFY_TOKEN || handles.length === 0) return {};
  console.log(`[Apify · IG] ${handles.join(', ')}`);
  const items = await runApifyActor(APIFY_IG_ACTOR, {
    usernames: handles,
    resultsType: 'details',
    resultsLimit: 1
  });
  const out = {};
  for (const item of (items || [])) {
    const handle = (item.username || '').toLowerCase();
    if (!handle) continue;
    const latest = (item.latestPosts || [])[0];
    out[handle] = {
      followers: item.followersCount ?? item.followers ?? null,
      postsThisWeek: countRecent(item.latestPosts, 7, p => p.timestamp || p.takenAtTimestamp),
      latestPost: latest ? {
        caption: (latest.caption || '').slice(0, 140),
        url:     latest.url || (latest.shortCode ? `https://instagram.com/p/${latest.shortCode}` : `https://instagram.com/${handle}`),
        date:    isoDay(latest.timestamp || latest.takenAtTimestamp)
      } : null,
      recentDates: (item.latestPosts || []).map(p => isoDay(p.timestamp || p.takenAtTimestamp)).filter(Boolean)
    };
  }
  return out;
}

async function fetchTikTokBatch(handles) {
  if (!APIFY_TOKEN || handles.length === 0) return {};
  console.log(`[Apify · TikTok] ${handles.join(', ')}`);
  const items = await runApifyActor(APIFY_TIKTOK_ACTOR, {
    profiles: handles,
    resultsPerPage: 5,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false
  });
  // clockworks/tiktok-scraper returns one item per video, grouped under
  // authorMeta. Roll them up by author handle.
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
      postsThisWeek: data.videos.filter(v => {
        const ts = v.createTimeISO ? Date.parse(v.createTimeISO) / 1000 : v.createTime;
        return ts && ts > weekAgoSec;
      }).length,
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

// dev_fusion/linkedin-profile-scraper
//   Input:  { profileUrls: ["https://www.linkedin.com/in/<slug>", ...] }
//   Output (per profile): { url, headline, followers, connections, ... }
//   No cookie required (the actor handles auth internally).
async function fetchLinkedInProfilesBatch(urls) {
  if (!APIFY_TOKEN || urls.length === 0) return {};
  console.log(`[Apify · LinkedIn personal] ${urls.length} profile(s)`);
  const input = {
    profileUrls: urls,
    ...(LINKEDIN_SESSION_COOKIE ? { cookie: [{ name: 'li_at', value: LINKEDIN_SESSION_COOKIE, domain: '.linkedin.com' }] } : {})
  };
  const items = await runApifyActor(APIFY_LINKEDIN_PROFILE_ACTOR, input);
  const out = {};
  for (const item of (items || [])) {
    // Match on the original input URL — most actors echo it back as `url` or
    // `linkedinUrl`. Fall back to building one from `publicIdentifier`.
    const echoedUrl = item.url || item.linkedinUrl || item.profileUrl
      || (item.publicIdentifier ? `https://www.linkedin.com/in/${item.publicIdentifier}/` : '');
    if (!echoedUrl) continue;
    out[normalizeUrl(echoedUrl)] = {
      followers: item.followers ?? item.followersCount ?? item.connections ?? null,
      headline:  item.headline || item.title || null
    };
  }
  return out;
}

// apimaestro/linkedin-company-detail
//   Input:  { companies: ["<url|slug|name>", ...] }
//   Output (per company): { basic_info: { name, ... }, stats: { follower_count, employee_count } }
//   No cookie required.
async function fetchLinkedInCompaniesBatch(urls) {
  if (!APIFY_TOKEN || urls.length === 0) return {};
  console.log(`[Apify · LinkedIn company] ${urls.length} page(s)`);
  const items = await runApifyActor(APIFY_LINKEDIN_COMPANY_ACTOR, {
    companies: urls
  });
  const out = {};
  for (const item of (items || [])) {
    // The actor returns either the input URL or a normalized one. Try both.
    const basic = item.basic_info || item.basicInfo || item || {};
    const stats = item.stats || item || {};
    const echoedUrl = item.url || basic.url || basic.linkedinUrl || basic.companyUrl
      || (basic.universal_name ? `https://www.linkedin.com/company/${basic.universal_name}/` : '')
      || (basic.universalName ? `https://www.linkedin.com/company/${basic.universalName}/` : '');
    if (!echoedUrl) continue;
    out[normalizeUrl(echoedUrl)] = {
      followers: stats.follower_count ?? stats.followerCount ?? item.followers ?? item.followersCount ?? null,
      headline:  basic.tagline || basic.description || null,
      name:      basic.name || null
    };
  }
  return out;
}

function normalizeUrl(u) {
  // Lower-case + strip trailing slash so matching is robust.
  return (u || '').toLowerCase().replace(/\/+$/, '');
}

// ─── helpers ───────────────────────────────────────────
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

function isCompanyUrl(u) { return /\/company\//i.test(u || ''); }

// ─── main ──────────────────────────────────────────────
async function main() {
  if (!APIFY_TOKEN) {
    console.error('FATAL: APIFY_TOKEN env var is missing. Set it as a repo secret.');
    process.exit(1);
  }
  console.log('Actors in use:');
  console.log(`  IG          : ${APIFY_IG_ACTOR}`);
  console.log(`  TikTok      : ${APIFY_TIKTOK_ACTOR}`);
  console.log(`  LI personal : ${APIFY_LINKEDIN_PROFILE_ACTOR}`);
  console.log(`  LI company  : ${APIFY_LINKEDIN_COMPANY_ACTOR}`);

  const raw = await readFile(METRICS_PATH, 'utf8');
  const metrics = JSON.parse(raw);

  // Group all the work by platform / type
  const igHandles      = [];
  const tiktokHandles  = [];
  const liPersonalUrls = new Set();
  const liCompanyUrls  = new Set();

  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      if (channel.platform === 'instagram') igHandles.push(channel.handle);
      else if (channel.platform === 'tiktok') tiktokHandles.push(channel.handle);
      else if (channel.platform === 'linkedin') {
        (isCompanyUrl(channel.url) ? liCompanyUrls : liPersonalUrls).add(channel.url);
      }
    }
  }
  for (const member of metrics.team || []) {
    if (member.linkedin) liPersonalUrls.add(member.linkedin);
  }

  const [igData, ttData, liPersonalData, liCompanyData] = await Promise.all([
    fetchInstagramBatch(igHandles).catch(e => { console.error('IG batch failed:', e.message); return {}; }),
    fetchTikTokBatch(tiktokHandles).catch(e => { console.error('TT batch failed:', e.message); return {}; }),
    fetchLinkedInProfilesBatch([...liPersonalUrls]).catch(e => { console.error('LI personal batch failed:', e.message); return {}; }),
    fetchLinkedInCompaniesBatch([...liCompanyUrls]).catch(e => { console.error('LI company batch failed:', e.message); return {}; })
  ]);

  let updated = 0;

  // Apply to property channels
  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      let fresh = null;
      if (channel.platform === 'instagram')      fresh = igData[channel.handle.toLowerCase()];
      else if (channel.platform === 'tiktok')    fresh = ttData[channel.handle.toLowerCase()];
      else if (channel.platform === 'linkedin')  fresh = (isCompanyUrl(channel.url) ? liCompanyData : liPersonalData)[normalizeUrl(channel.url)];

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
    const fresh = liPersonalData[normalizeUrl(member.linkedin)];
    if (!fresh || fresh.followers == null) continue;
    member.followers = fresh.followers;
    updated++;
    console.log(`✓ team ${member.name}: ${fresh.followers} followers`);
  }

  if (updated > 0) {
    metrics.lastUpdated = new Date().toISOString();
    metrics.source = 'api';
    await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`\nDone. Updated ${updated} record(s).`);
  } else {
    // Hard-fail so the workflow goes red and you get the GitHub failure email,
    // rather than a green-but-empty run that quietly leaves the dashboard stale.
    console.error('\nFAIL: zero records updated. Check actor IDs, APIFY_TOKEN, or whether the actors are added to your Apify account.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
