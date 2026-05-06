# Hook Tool

Internal Outcurve tool for generating social-media hooks (Substack subject lines, Instagram caption first-lines, Substack post intros) and reverse-engineering hook lines from video transcripts. Grounded in the 10 Outcurve ICPs and a curated corpus of viral health-content hooks.

Static, no build step, runs entirely in the browser. Anthropic API key lives in `localStorage`.

## Run locally

The app uses `fetch()` to load the JSON data and prompt templates, which means opening `index.html` directly from disk (`file://`) won't work in most browsers. Use any static server. Two easy options:

```bash
# from this directory
python3 -m http.server 8765
# then open http://localhost:8765/
```

```bash
npx serve .
```

On first load, paste your Anthropic API key (`sk-ant-...`). It is stored in `localStorage` only — never sent anywhere except `api.anthropic.com`. Use **Reset key** in the top-right to clear it.

## Modes

- **Subject lines** — Substack inbox openers (≤55 chars, punchy).
- **IG first-lines** — pre-"...more" scroll-stoppers (1–2 lines, ≤125 chars).
- **Post intros** — Substack opening paragraphs (60–110 words).
- **Extract from transcript** — paste a video transcript, get the hook line(s), shape, why-it-works, transferable template, and persona match.

For the three generation modes, pick a persona (1–10), a creative format (demo / story / problem / persona-led, or "any"), a topic / angle, optional tone modifiers, and a count.

## Refreshing the data

Two JSON files drive the tool:

- `data/icps.json` — the 10 Outcurve ICPs from Notion's *Persona × Trigger × Creative Format Matrix* doc. Edit by hand when the matrix evolves.
- `data/hooks-corpus.json` — example hooks pulled from Notion's *🔥 LinkedIn Viral Health Posts* database. Add new entries when you want to broaden the model's reference set. Each entry needs `hook`, `shape`, `persona_match` (one of the ICP `shape` values, or `null`), `topic`, and `notes`.

The model receives a randomly stratified subset of the corpus per generation (~12 hooks, 55% matched to the selected persona where possible). The full corpus is never sent.

## Cost / model

- Default: `claude-haiku-4-5-20251001` — fast, cheap, fine for iteration.
- Toggle to `claude-sonnet-4-6` when output quality matters (final ad copy, tougher persona matches).

The static portion of each prompt (system instructions + ICP + hooks corpus) is sent with `cache_control: { type: "ephemeral" }`, so repeat generations within ~5 minutes hit the prompt cache. The status line shows token counts (`in {input} + {cache_write} + {cache_read} · out {output}`) — non-zero `r` means the cache hit.

## Deploying to a separate gh-pages branch

The main rareform.health site is served from `main` via the existing CNAME. To keep this tool isolated, deploy it to a `gh-pages` branch which serves at the project-Pages URL (`https://stoddy-carey.github.io/rareform-website/`).

One-time setup:

1. Create the branch with only the `hook-tool/` folder contents at the root:
   ```bash
   git checkout --orphan gh-pages
   git rm -rf .
   git checkout claude/social-hook-research-tool-Qv0Aj -- hook-tool
   mv hook-tool/* hook-tool/.* . 2>/dev/null || true
   rmdir hook-tool
   git add .
   git commit -m "Initial gh-pages: hook tool"
   git push -u origin gh-pages
   ```
2. In GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `gh-pages` / root**. Save.
3. Wait ~1 min, then visit `https://stoddy-carey.github.io/rareform-website/`.

This will *not* affect the main rareform.health site, which continues to serve from `main`.

To update the deployed tool:
```bash
git checkout gh-pages
git checkout claude/social-hook-research-tool-Qv0Aj -- hook-tool
mv hook-tool/* hook-tool/.* . 2>/dev/null || true
rmdir hook-tool
git add . && git commit -m "Update hook tool" && git push
```

(Or use a `worktree`-based flow if you prefer; the goal is just: `gh-pages` branch contains the contents of `hook-tool/` at its root.)

## Files

```
hook-tool/
  index.html            # markup, mode tabs, form, output, key modal
  app.js                # state, API calls, prompt assembly, streaming UI
  styles.css            # light workspace theme matching Rareform fonts
  data/
    icps.json           # 10 Outcurve personas
    hooks-corpus.json   # ~26 curated example hooks
  prompts/
    subject-lines.txt
    ig-first-lines.txt
    post-intros.txt
    extract-hook.txt
  README.md
```

## Caveats

- Browser-side API calls require the `anthropic-dangerous-direct-browser-access: true` header (set automatically), which is fine for an internal tool but you should never share the deployed URL with anyone you don't want to also share your API key with (a savvy visitor can extract it from `localStorage` via DevTools, since by design it lives in their browser).
- The deployed tool is `noindex, nofollow` and isn't linked from the main site, but it's still publicly reachable. If you want stricter access control, host locally only or put it behind a Cloudflare-Access-protected subdomain.
- 10,000-char transcript cap is a soft guard against accidentally pasting a multi-hour podcast. Raise in `app.js` (`MAX_TRANSCRIPT_CHARS`) if you regularly work with longer source material.
