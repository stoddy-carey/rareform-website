# Growth Northstar — automation notes

The dashboard at `/growth.html` shows live numbers across Outcurve's Instagram, TikTok, LinkedIn, and Rareform Substack. This document explains how it stays fresh.

## How the data refreshes (set-and-forget)

Once a day at 07:00 UTC, a GitHub Action runs `scripts/refresh-metrics.mjs`. The script calls four Apify actors (one each for IG, TikTok, LinkedIn personal profiles, LinkedIn company pages) and writes the results back into `data/metrics.json`. If anything changed, the `rareform-bot` user commits and pushes to `main`. GitHub Pages then rebuilds the static site (~30s) and the dashboard picks up the new JSON on the next visitor load.

Substack is fetched live in the browser from the public RSS feed — no GitHub Action involvement.

LinkedIn personal follower counts that come from `metrics.team[]` (Stoddy / Uma / Sebastian) are also refreshed by the same Apify LinkedIn profile actor.

## When something breaks

GitHub emails the repo owner whenever a workflow fails. The most likely causes, in order of frequency:

1. **An Apify actor changed its output schema.** Look at the failed run's logs; the field name has probably shifted. Fix in `scripts/refresh-metrics.mjs` and push.
2. **An Apify actor was deprecated and removed from the store.** Find a replacement in the [Apify Store](https://apify.com/store), then set the appropriate repo *variable* (not secret) to the new actor ID. No code change needed.
3. **`APIFY_TOKEN` expired or was rotated.** Generate a fresh token in [Apify Console → Settings → API tokens](https://console.apify.com/settings/integrations), then update the GitHub secret.
4. **LinkedIn cracked down on the chosen actor.** Switch to a different LinkedIn actor. Same pattern as point 2.

## Configuration

### Required secret (set in [repo settings](https://github.com/stoddy-carey/rareform-website/settings/secrets/actions))
- `APIFY_TOKEN` — single Apify token covering all actors

### Optional secrets
- `LINKEDIN_SESSION_COOKIE` — only if you swap to a LinkedIn actor that requires the `li_at` cookie. The defaults don't.

### Optional repo variables (overrides — not secrets, since actor IDs aren't sensitive)
- `APIFY_IG_ACTOR` (default `apify/instagram-profile-scraper`)
- `APIFY_TIKTOK_ACTOR` (default `clockworks/tiktok-scraper`)
- `APIFY_LINKEDIN_PROFILE_ACTOR` (default `dev_fusion/linkedin-profile-scraper`)
- `APIFY_LINKEDIN_COMPANY_ACTOR` (default `apimaestro/linkedin-company-detail`)

## Manual changes

You can edit `data/metrics.json` directly via PR for anything the auto-refresh doesn't cover:
- **Substack subscriber count** (RSS doesn't expose it) — update the `subscribers` field on the Rareform substack channel weekly.
- **Milestones** — add to the `milestones` array. Show up immediately on the dashboard.
- **Manual ship dates** — bump entries in `shipsByDay` to reflect activity that doesn't show up in any feed (events, in-person meetups, etc.).
- **New channels** — add a new entry under the right `properties[].channels[]`; the auto-refresh will pick it up next run.

## Triggering a refresh manually

[Actions → Refresh growth metrics → Run workflow](https://github.com/stoddy-carey/rareform-website/actions/workflows/refresh-metrics.yml). Useful right after adding a new channel, or to verify a fix.

## Cost

At one refresh per day, expect ~$3/month in Apify usage. Most of that is the LinkedIn profile scraper ($10/1k results × ~4 profiles × 30 days). To cut further: drop the team LinkedIn refresh to once a week by editing the cron.
