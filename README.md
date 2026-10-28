# music-story-autopublish

Third sibling auto-publish pipeline (after `hajriahfajar-autopublish` and `novel-autopublish`), same Google account (`hajriahfajar@gmail.com`). Publishes **one bilingual (ID/EN) true-story article per day about a real musician/band** — emotional narrative (Hook → Setup → Konflik → Turning Point → Payoff), not a review or news piece. No images, no lyrics, no video embeds.

## Two-phase model: generate weekly, publish daily from a queue

Publishing **no longer calls Gemini at all**. Instead:

1. **Generate** (`src/generate.mjs`, run via `.github/workflows/generate.yml`) picks real, identifiable musicians/bands with a strong, **widely-documented** emotional story and writes several (default 10) complete, validated, ready-to-publish bilingual articles in one batch run — once a week, off-peak (Wednesday 10:00 UTC / 17:00 WIB) — and queues them in the Sheet with `status = ready` (full HTML included, artist/genre/origin already resolved).
2. **Publish** (`src/run.mjs`, the existing daily workflow) just pulls the oldest `ready` row, computes its labels (artist name(s) + genre + origin + a first-letter index label computed in code, never asked from Gemini, so it can't mismatch), posts it, and flips the row to `done`. No Gemini call in this path at all.

This exists because calling Gemini at every single daily publish moment was exactly what caused a string of failures: Gemini's free tier occasionally has multi-minute 503/429 overload spells that exhaust both the primary and fallback model mid-publish. Batching means Gemini is only invoked during one deliberate weekly window, and a publish-time failure becomes nearly impossible since there's no Gemini call left to fail.

**Manual "dashboard"**: Actions tab → **Weekly batch generate** → **Run workflow** to generate on demand (optional custom count). The Google Sheet is the visual queue — filter by `status` to see `ready`/`done`/`failed`.

If the queue runs dry, `run.mjs` logs a warning and does nothing that run (no on-the-fly fallback generation) — re-run the generate workflow manually if the queue ever looks low (10/week generated vs 7/week consumed gives a few days of buffer).

**Content guardrail, not a technical check**: the style guide explicitly tells Gemini to only use widely-documented public facts about the real musicians it names, and never invent new serious unverifiable claims. This can't be automatically verified (no search grounding on the free tier) — it's a prompt-level instruction, so spot-check queued/published posts periodically.

## How it works

1. GitHub Actions fires 8 small cron triggers spread across a single daily window, targeting a real-world landing around **12:00–14:00 WIB** (configured cron times are shifted earlier in UTC to compensate for observed GitHub scheduling delay — see `scripts/check-slot.mjs`) — deliberately non-overlapping with the other two projects sharing the same Gemini API key (`hajriahfajar-autopublish`: targeting ~07:00–09:30 & ~19:00–20:30 WIB; `novel-autopublish`: targeting ~22:00–23:30 WIB). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one slot per day via a deterministic hash of today's date — the others exit in a few seconds without installing anything.
2. Reads the Sheet, skips if today's already been handled (a `published`/`done` row today).
3. Pulls the oldest `ready` row from the queue (see "Two-phase model" above), computes labels, publishes to Blogger (`isDraft: false`), and flips that row to `done`.

## One-time setup

### 1. Credentials — reused, not re-created
Since this blog lives under the same Google account as `hajriahfajar-autopublish`, you don't need a new Google Cloud project, OAuth client, or Gemini key — just copy 4 values straight from `hajriahfajar-autopublish/.env`:
`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

### 2. New Blogger blog
Create it manually at blogger.com (blog creation isn't available via API).

### 3. Run the local settings UI
```bash
npm install
npm run setup
```
Opens `http://localhost:5579`. Paste in the 4 copied values (or go through "Connect Google Account" to mint a fresh refresh token the same way — either works, it's the same account). The page auto-detects the new Blog ID from the blog URL and creates a new 1-tab Google Sheet log.

### 4. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create music-story-autopublish --public --source=. --remote=origin
git push -u origin main
```
**Public, not private** — unlimited free Actions minutes. Re-run `npm run setup` (check "push to GitHub Actions secrets") or add manually under **Settings → Secrets and variables → Actions**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `PUBLISH_TIMEZONE`. The same secrets are reused by `generate.yml` — no separate set needed.

GitHub Actions then runs daily (`.github/workflows/daily-post.yml`) — **but first, top up the queue**: Actions tab → "Weekly batch generate" → **Run workflow** once, so there's something `ready` to publish immediately.

## Local test run
```bash
npm run test:validate
DRAFT_MODE=true FORCE_RUN=true npm run run
```
`DRAFT_MODE=true` saves as a Blogger draft instead of publishing live. `FORCE_RUN=true` bypasses the same-day dedup guard. Both are local-only — never set as GitHub secrets, so the real scheduled runs always publish for real.

To generate a batch locally (writes real `ready`/`failed` rows to the Sheet, no Blogger calls at all):
```bash
GENERATE_COUNT=3 npm run generate
```

## Notes / known tradeoffs
- Labels per post: 1–2 artist/band name(s) + genre (free-form, decided per-post by Gemini) + origin (`Indonesia`/`International`) + 1 first-letter index label (A–Z, computed in code).
- Dedup is by artist name (normalized), not by category — there is no fixed topic/category list in this project.
- The single daily window (6 cron entries) is controlled by **two places that must stay in sync**: `.github/workflows/daily-post.yml` and `CRON_MAP`/`SLOTS_PER_WINDOW` in `scripts/check-slot.mjs`.
- No images, no R2, no thumbnails at all — simplest of the three sibling pipelines.
