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
const APIFY_LI_POSTS_PERSONAL_ACTOR = process.env.APIFY_LI_POSTS_PERSONAL_ACTOR || 'apimaestro/linkedin-profile-posts';
const APIFY_LI_POSTS_COMPANY_ACTOR  = process.env.APIFY_LI_POSTS_COMPANY_ACTOR  || 'apimaestro/linkedin-company-posts';
const LINKEDIN_SESSION_COOKIE      = process.env.LINKEDIN_SESSION_COOKIE      || '';

const RECENT_POSTS_LIMIT = 20;  // per channel, in metrics.json

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

// ─── Engagement helpers ────────────────────────────────
// Every platform's `recentPosts[]` uses this shape so the dashboard can
// reason about engagement uniformly regardless of source.
function normalizePost({ id, caption, url, date, type, likes, comments, views, shares, saves, platform }) {
  return {
    id: id || null,
    platform: platform || null,
    type: type || null,
    caption: (caption || '').slice(0, 280),
    url: url || null,
    date: date || null,
    likes:    likes    ?? null,
    comments: comments ?? null,
    views:    views    ?? null,
    shares:   shares   ?? null,
    saves:    saves    ?? null
  };
}

function sumEngagement(posts, sinceDays) {
  const cutoff = Date.now() - sinceDays * 86400e3;
  const inWindow = posts.filter(p => p.date && Date.parse(p.date) > cutoff);
  return {
    posts:    inWindow.length,
    likes:    inWindow.reduce((s, p) => s + (p.likes    || 0), 0),
    comments: inWindow.reduce((s, p) => s + (p.comments || 0), 0),
    views:    inWindow.reduce((s, p) => s + (p.views    || 0), 0),
    shares:   inWindow.reduce((s, p) => s + (p.shares   || 0), 0),
    saves:    inWindow.reduce((s, p) => s + (p.saves    || 0), 0)
  };
}

function computeEngagement(posts, followers) {
  const last7d  = sumEngagement(posts, 7);
  const last30d = sumEngagement(posts, 30);
  // Avg engagement rate = (likes + comments + shares) / followers, averaged across posts in window.
  // Falls back to null if we don't have followers or no posts in window.
  let avgEngagementRate = null;
  if (followers && last30d.posts > 0) {
    const interactions = last30d.likes + last30d.comments + last30d.shares;
    avgEngagementRate = +((interactions / last30d.posts / followers) * 100).toFixed(2);
  }
  return { last7d, last30d, avgEngagementRate };
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
    const rawPosts = item.latestPosts || [];
    const posts = rawPosts.map(p => normalizePost({
      platform: 'instagram',
      id:       p.id || p.shortCode,
      caption:  p.caption,
      url:      p.url || (p.shortCode ? `https://instagram.com/p/${p.shortCode}` : null),
      date:     isoDay(p.timestamp || p.takenAtTimestamp),
      type:     p.type,                       // Image / Video / Sidecar
      likes:    p.likesCount,
      comments: p.commentsCount,
      views:    p.videoViewCount ?? p.videoPlayCount,  // videos only
      shares:   null,                          // IG doesn't expose shares
      saves:    null                           // IG doesn't expose saves
    })).slice(0, RECENT_POSTS_LIMIT);
    const followers = item.followersCount ?? item.followers ?? null;
    out[handle] = {
      followers,
      postsThisWeek: posts.filter(p => p.date && Date.parse(p.date) > Date.now() - 7 * 86400e3).length,
      latestPost: posts[0] ? { caption: posts[0].caption.slice(0, 140), url: posts[0].url, date: posts[0].date } : null,
      recentPosts: posts,
      engagement: computeEngagement(posts, followers),
      recentDates: posts.map(p => p.date).filter(Boolean)
    };
  }
  const missing = handles.filter(h => !out[h.toLowerCase()]);
  if (missing.length) console.warn(`  ⚠ IG returned no data for: ${missing.join(', ')} — handle probably doesn't exist`);
  return out;
}

async function fetchTikTokBatch(handles) {
  if (!APIFY_TOKEN || handles.length === 0) return {};
  console.log(`[Apify · TikTok] ${handles.join(', ')}`);
  const items = await runApifyActor(APIFY_TIKTOK_ACTOR, {
    profiles: handles,
    resultsPerPage: RECENT_POSTS_LIMIT,
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
    const posts = data.videos.map(v => normalizePost({
      platform: 'tiktok',
      id:       v.id,
      caption:  v.text || v.title,
      url:      v.webVideoUrl || v.shareUrl || `https://tiktok.com/@${handle}`,
      date:     isoDay(v.createTimeISO || (v.createTime ? v.createTime * 1000 : null)),
      type:     'video',
      likes:    v.diggCount,
      comments: v.commentCount,
      views:    v.playCount,
      shares:   v.shareCount,
      saves:    v.collectCount
    })).slice(0, RECENT_POSTS_LIMIT);
    out[handle] = {
      followers: data.followers,
      postsThisWeek: posts.filter(p => p.date && Date.parse(p.date) > Date.now() - 7 * 86400e3).length,
      viewsLast30d: sumEngagement(posts, 30).views,
      latestPost: posts[0] ? { caption: posts[0].caption.slice(0, 140), url: posts[0].url, date: posts[0].date } : null,
      recentPosts: posts,
      engagement: computeEngagement(posts, data.followers),
      recentDates: posts.map(p => p.date).filter(Boolean)
    };
  }
  const missing = handles.filter(h => !out[h.toLowerCase()]);
  if (missing.length) console.warn(`  ⚠ TikTok returned no data for: ${missing.join(', ')} — account may not exist or has no public videos`);
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
  // Diagnostic: dump the top-level keys of the first item so we can see what
  // shape this actor returns and fix the parser when it inevitably drifts.
  if (items && items.length) {
    console.log(`  [LI company] received ${items.length} item(s). First item keys: ${Object.keys(items[0]).join(', ')}`);
  } else {
    console.warn(`  ⚠ LI company actor returned 0 items`);
  }
  const out = {};
  for (const item of (items || [])) {
    const basic = item.basic_info || item.basicInfo || item || {};
    const stats = item.stats || item || {};
    const echoedUrl = item.url || basic.url || basic.linkedinUrl || basic.companyUrl
      || (basic.universal_name ? `https://www.linkedin.com/company/${basic.universal_name}/` : '')
      || (basic.universalName ? `https://www.linkedin.com/company/${basic.universalName}/` : '');
    if (!echoedUrl) {
      console.warn(`  ⚠ LI company item missing URL field. Item keys: ${Object.keys(item).join(', ')}`);
      continue;
    }
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

// ─── LinkedIn engagement (per-post) ──────────────────────
// apimaestro/linkedin-profile-posts — pulls recent posts + reactions/comments/reposts
// for personal LinkedIn URLs.
async function fetchLinkedInPersonalPosts(urls) {
  if (!APIFY_TOKEN || urls.length === 0) return {};
  console.log(`[Apify · LinkedIn personal posts] ${urls.length} profile(s)`);
  let items = [];
  try {
    items = await runApifyActor(APIFY_LI_POSTS_PERSONAL_ACTOR, {
      urls,
      profileUrls: urls,
      total: RECENT_POSTS_LIMIT
    });
  } catch (e) {
    console.error(`  ⚠ LinkedIn posts (personal) failed: ${e.message}`);
    return {};
  }
  if (items?.length) console.log(`  received ${items.length} post(s). First item keys: ${Object.keys(items[0]).join(', ')}`);
  // Group by profile URL
  const grouped = {};
  for (const item of items || []) {
    const authorUrl = item.authorUrl || item.profileUrl || item.author_url || item.profile_url || item.url || '';
    const norm = normalizeUrl(authorUrl);
    if (!norm) continue;
    if (!grouped[norm]) grouped[norm] = [];
    grouped[norm].push(normalizePost({
      platform: 'linkedin',
      id:       item.id || item.urn || item.activityUrn,
      caption:  item.text || item.commentary || item.content || item.postContent,
      url:      item.url || item.postUrl || item.activityUrl,
      date:     isoDay(item.postedAt || item.publishedAt || item.date || item.timestamp),
      type:     item.type || item.contentType || 'post',
      likes:    item.likesCount ?? item.reactionsCount ?? item.numReactions ?? item.likes,
      comments: item.commentsCount ?? item.numComments ?? item.comments,
      views:    item.viewsCount ?? item.numImpressions ?? item.impressions,
      shares:   item.sharesCount ?? item.repostsCount ?? item.reposts ?? item.shares,
      saves:    null
    }));
  }
  return grouped;
}

// apimaestro/linkedin-company-posts — same idea for company pages.
async function fetchLinkedInCompanyPosts(urls) {
  if (!APIFY_TOKEN || urls.length === 0) return {};
  console.log(`[Apify · LinkedIn company posts] ${urls.length} page(s)`);
  let items = [];
  try {
    items = await runApifyActor(APIFY_LI_POSTS_COMPANY_ACTOR, {
      urls,
      companyUrls: urls,
      companies: urls,
      total: RECENT_POSTS_LIMIT
    });
  } catch (e) {
    console.error(`  ⚠ LinkedIn posts (company) failed: ${e.message}`);
    return {};
  }
  if (items?.length) console.log(`  received ${items.length} post(s). First item keys: ${Object.keys(items[0]).join(', ')}`);
  const grouped = {};
  for (const item of items || []) {
    const companyUrl = item.companyUrl || item.authorUrl || item.company_url || item.author_url || item.url || '';
    const norm = normalizeUrl(companyUrl);
    if (!norm) continue;
    if (!grouped[norm]) grouped[norm] = [];
    grouped[norm].push(normalizePost({
      platform: 'linkedin',
      id:       item.id || item.urn || item.activityUrn,
      caption:  item.text || item.commentary || item.content,
      url:      item.url || item.postUrl,
      date:     isoDay(item.postedAt || item.publishedAt || item.date || item.timestamp),
      type:     item.type || 'post',
      likes:    item.likesCount ?? item.reactionsCount ?? item.numReactions,
      comments: item.commentsCount ?? item.numComments,
      views:    item.viewsCount ?? item.numImpressions,
      shares:   item.sharesCount ?? item.repostsCount ?? item.reposts,
      saves:    null
    }));
  }
  return grouped;
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

  const [igData, ttData, liPersonalData, liCompanyData, liPersonalPosts, liCompanyPosts] = await Promise.all([
    fetchInstagramBatch(igHandles).catch(e => { console.error('IG batch failed:', e.message); return {}; }),
    fetchTikTokBatch(tiktokHandles).catch(e => { console.error('TT batch failed:', e.message); return {}; }),
    fetchLinkedInProfilesBatch([...liPersonalUrls]).catch(e => { console.error('LI personal batch failed:', e.message); return {}; }),
    fetchLinkedInCompaniesBatch([...liCompanyUrls]).catch(e => { console.error('LI company batch failed:', e.message); return {}; }),
    fetchLinkedInPersonalPosts([...liPersonalUrls]).catch(e => { console.error('LI personal posts failed:', e.message); return {}; }),
    fetchLinkedInCompanyPosts([...liCompanyUrls]).catch(e => { console.error('LI company posts failed:', e.message); return {}; })
  ]);

  let updated = 0;

  // Apply to property channels
  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      let fresh = null;
      if (channel.platform === 'instagram')      fresh = igData[channel.handle.toLowerCase()];
      else if (channel.platform === 'tiktok')    fresh = ttData[channel.handle.toLowerCase()];
      else if (channel.platform === 'linkedin')  fresh = (isCompanyUrl(channel.url) ? liCompanyData : liPersonalData)[normalizeUrl(channel.url)];

      // LinkedIn posts (engagement) come from a separate actor and need to be
      // merged onto the channel after the profile data lands.
      let liPosts = null;
      if (channel.platform === 'linkedin') {
        liPosts = (isCompanyUrl(channel.url) ? liCompanyPosts : liPersonalPosts)[normalizeUrl(channel.url)];
      }

      if (!fresh || fresh.followers == null) {
        // LinkedIn profile actor may have failed but posts actor succeeded — still capture posts.
        if (liPosts && liPosts.length) {
          channel.recentPosts = liPosts.slice(0, RECENT_POSTS_LIMIT);
          channel.engagement  = computeEngagement(liPosts, channel.followers);
          updated++;
          console.log(`✓ linkedin @${channel.handle}: ${liPosts.length} posts (profile follower count unavailable)`);
        }
        continue;
      }

      const prev = channel.followers || 0;
      channel.followers = fresh.followers;
      channel.weeklyDelta = fresh.followers - prev;
      if (fresh.postsThisWeek != null) channel.postsThisWeek = fresh.postsThisWeek;
      if (fresh.viewsLast30d != null) channel.viewsLast30d = fresh.viewsLast30d;
      channel.history = appendHistory(channel.history, fresh.followers);
      if (fresh.latestPost) channel.latestPost = fresh.latestPost;

      // Engagement — merge posts from the appropriate source
      if (channel.platform === 'linkedin' && liPosts && liPosts.length) {
        channel.recentPosts = liPosts.slice(0, RECENT_POSTS_LIMIT);
        channel.engagement  = computeEngagement(liPosts, fresh.followers);
        metrics.shipsByDay  = bumpShipsByDay(metrics.shipsByDay, liPosts.map(p => p.date));
      } else if (fresh.recentPosts) {
        channel.recentPosts = fresh.recentPosts;
        channel.engagement  = fresh.engagement;
      }
      if (fresh.recentDates) metrics.shipsByDay = bumpShipsByDay(metrics.shipsByDay, fresh.recentDates);

      updated++;
      const eng = channel.engagement?.last7d;
      const engStr = eng ? ` · 7d: ${eng.posts} posts, ${eng.likes} likes, ${eng.views} views` : '';
      console.log(`✓ ${channel.platform} @${channel.handle}: ${fresh.followers} followers${engStr}`);
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

  // Compute cross-channel "top posts this week" so the dashboard can
  // celebrate the highest-engagement content without re-aggregating in JS.
  const allRecent = [];
  for (const property of metrics.properties || []) {
    for (const channel of property.channels || []) {
      for (const p of (channel.recentPosts || [])) {
        if (!p.date) continue;
        if (Date.parse(p.date) < Date.now() - 7 * 86400e3) continue;
        allRecent.push({
          ...p,
          property: property.name,
          handle: channel.handle,
          score: (p.likes || 0) + (p.comments || 0) * 3 + (p.shares || 0) * 5 + (p.views || 0) * 0.001
        });
      }
    }
  }
  allRecent.sort((a, b) => b.score - a.score);
  metrics.topPostsThisWeek = allRecent.slice(0, 10);

  if (updated > 0) {
    metrics.lastUpdated = new Date().toISOString();
    metrics.source = 'api';
    await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`\nDone. Updated ${updated} record(s). Top posts this week: ${metrics.topPostsThisWeek.length}`);
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
