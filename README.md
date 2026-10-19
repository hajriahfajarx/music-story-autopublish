# music-story-autopublish

Third sibling auto-publish pipeline (after `hajriahfajar-autopublish` and `novel-autopublish`), same Google account (`hajriahfajar@gmail.com`). Publishes **one bilingual (ID/EN) true-story article per day about a real musician/band** — emotional narrative (Hook → Setup → Konflik → Turning Point → Payoff), not a review or news piece. No images, no lyrics, no video embeds.

## How it works

1. GitHub Actions fires 8 small cron triggers spread across a single daily window, targeting a real-world landing around **12:00–14:00 WIB** (configured cron times are shifted earlier in UTC to compensate for observed GitHub scheduling delay — see `scripts/check-slot.mjs`) — deliberately non-overlapping with the other two projects sharing the same Gemini API key (`hajriahfajar-autopublish`: targeting ~07:00–09:30 & ~19:00–20:30 WIB; `novel-autopublish`: targeting ~22:00–23:30 WIB). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one slot per day via a deterministic hash of today's date — the others exit in a few seconds without installing anything.
2. Reads the Google Sheet log of previously covered musicians/bands, skips if today's already been handled.
3. Asks Gemini (JSON mode) to pick one real, identifiable musician/band (or two, for a comparison piece) with a strong, **widely-documented** emotional story — explicitly instructed not to invent new serious unverifiable claims about a real person. Retries once with an explicit nudge if the pick collides with an artist already covered.
4. Writes the full bilingual story using `prompts/music-story-style-guide.md` with the chosen artist/genre/origin/angle filled in.
5. Validates the result (leftover placeholders, missing/short language sections, missing toggle script, invalid `Asal` value). Repairs via Gemini up to 3 attempts total; if it still fails, the run **stops without publishing** and logs a `failed` row.
6. Computes labels: the artist name(s) + genre + origin (as Gemini settled on them) + a **first-letter index label** (A–Z) computed deterministically in code from the primary artist name — never asked from Gemini, so it can't mismatch.
7. Publishes to Blogger (`isDraft: false`) with all labels attached.
8. Logs the result to the Google Sheet.

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
**Public, not private** — unlimited free Actions minutes. Re-run `npm run setup` (check "push to GitHub Actions secrets") or add manually under **Settings → Secrets and variables → Actions**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `PUBLISH_TIMEZONE`.

## Local test run
```bash
npm run test:validate
DRAFT_MODE=true FORCE_RUN=true npm run run
```
`DRAFT_MODE=true` saves as a Blogger draft instead of publishing live. `FORCE_RUN=true` bypasses the same-day dedup guard. Both are local-only — never set as GitHub secrets, so the real scheduled runs always publish for real.

## Notes / known tradeoffs
- **Content guardrail, not a technical check**: the style guide explicitly tells Gemini to only use widely-documented public facts about the real musicians it names, and never invent new serious unverifiable claims. This can't be automatically verified (no search grounding on the free tier) — it's a prompt-level instruction, so spot-check published posts periodically.
- Labels per post: 1–2 artist/band name(s) + genre (free-form, decided per-post by Gemini) + origin (`Indonesia`/`International`) + 1 first-letter index label (A–Z, computed in code).
- Dedup is by artist name (normalized), not by category — there is no fixed topic/category list in this project.
- The single daily window (6 cron entries) is controlled by **two places that must stay in sync**: `.github/workflows/daily-post.yml` and `CRON_MAP`/`SLOTS_PER_WINDOW` in `scripts/check-slot.mjs`.
- No images, no R2, no thumbnails at all — simplest of the three sibling pipelines.
