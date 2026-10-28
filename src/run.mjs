import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, appendLogRow, ensureHeaderRow } from "./sheets.mjs";
import { createGeminiClient, pickStory, writeStory, fixStoryHtml } from "./gemini.mjs";
import { parseStoryResponse } from "./parse.mjs";
import { validateStory } from "./validate.mjs";
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;
const MAX_WRITE_ATTEMPTS = 2;

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Single daily window (unlike the tech blog's per-window tracking) — this
// project only ever has one post/day, so "already handled today" is enough.
// Only "published" blocks the rest of today's slots -- a "failed" row (e.g.
// a transient Gemini 503 overload spell) must NOT block retries, otherwise
// a single bad slot wastes the whole day's redundancy and nothing goes out
// at all that day.
function alreadyHandledToday(pastLog, timeZone) {
  const today = dateStringInTz(new Date(), timeZone);
  return pastLog.some((row) => {
    if (!row.date || row.status !== "published") return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLikelyDuplicateArtist(story, pastLog) {
  const normNames = new Set(story.artistNames.map(normalize));
  return pastLog.some((row) => {
    const rowNames = (row.artistNames || "").split(",").map(normalize);
    return rowNames.some((n) => n && normNames.has(n));
  });
}

// Computed in code, not asked from Gemini, so it can never mismatch the
// artist name it actually wrote (e.g. label "D" next to "The Calling").
function firstLetterLabel(name) {
  const match = (name || "").match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : "#";
}

async function main() {
  const config = loadConfig();
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "music-story-style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);

  const windowId = config.publishWindow.id;
  if (process.env.FORCE_RUN === "true") {
    console.log("FORCE_RUN=true — skipping the already-handled-today guard (manual test only, never set this in the scheduled workflow).");
  } else if (windowId === "manual") {
    console.log('PUBLISH_WINDOW_ID is "manual" (workflow_dispatch or local run) — dedup guard skipped, this is an intentional extra run.');
  } else if (alreadyHandledToday(pastLog, config.publishWindow.timezone)) {
    console.log("Today already has a published row — skipping (prevents double-posting if slots ever overlap).");
    return;
  }

  console.log(`Loaded ${pastLog.length} past log row(s). Picking a musician/band...`);

  let story = await pickStory(ai, config.gemini.models, { pastLog });
  if (isLikelyDuplicateArtist(story, pastLog)) {
    console.log("First pick looked like a duplicate artist, asking Gemini again with an explicit nudge...");
    story = await pickStory(ai, config.gemini.models, {
      pastLog,
      extraAvoid: [`- ${story.artistNames.join(" & ")}`],
    });
  }

  console.log(`Story chosen: ${story.artistNames.join(" & ")} [${story.genre}/${story.origin}] — "${story.titleId}"`);

  console.log("Writing full bilingual story...");
  let parsed = null;
  let writeFailureReason = null;
  for (let writeAttempt = 1; writeAttempt <= MAX_WRITE_ATTEMPTS; writeAttempt++) {
    let rawResponse;
    try {
      rawResponse = await writeStory(ai, config.gemini.models, styleGuideTemplate, story);
      parsed = parseStoryResponse(rawResponse);
      writeFailureReason = null;
      break;
    } catch (err) {
      writeFailureReason = err.message;
      console.log(`Gemini's response (attempt ${writeAttempt}/${MAX_WRITE_ATTEMPTS}) didn't parse: ${err.message}`);
      if (rawResponse) {
        console.log(`--- Raw response length: ${rawResponse.length} chars ---`);
        console.log(`--- Last 500 chars (to check for truncation) ---\n${rawResponse.slice(-500)}`);
      } else {
        console.log("--- No raw response at all (the Gemini call itself threw) ---");
      }
    }
  }

  if (!parsed) {
    console.error(`Could not get a parseable story from Gemini after ${MAX_WRITE_ATTEMPTS} attempt(s). NOT publishing.`);
    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      titleId: story.titleId,
      titleEn: story.titleEn,
      artistNames: story.artistNames.join(", "),
      genre: story.genre,
      origin: story.origin,
      reason: `Unparseable response: ${writeFailureReason}`,
    });
    process.exitCode = 1;
    return;
  }

  let result = validateStory(parsed);

  let attempt = 1;
  while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
    attempt += 1;
    console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
    result.issues.forEach((i) => console.log(`  - ${i}`));

    const fixedHtmlResponse = await fixStoryHtml(ai, config.gemini.models, parsed.html, result.issues);
    const fixedHtmlMatch = fixedHtmlResponse.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
    if (fixedHtmlMatch) {
      parsed = { ...parsed, html: fixedHtmlMatch[1].trim() };
    }
    result = validateStory(parsed);
  }

  if (!result.ok) {
    console.error(`Story failed validation after ${attempt} attempt(s). NOT publishing. Issues:`);
    result.issues.forEach((i) => console.error(`  - ${i}`));

    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      titleId: parsed.meta.titleId || story.titleId,
      titleEn: parsed.meta.titleEn || story.titleEn,
      artistNames: (parsed.meta.artistNames.length ? parsed.meta.artistNames : story.artistNames).join(", "),
      genre: parsed.meta.genre || story.genre,
      origin: parsed.meta.origin || story.origin,
      reason: result.issues.join(" | "),
    });

    process.exitCode = 1;
    return;
  }

  // Labels: artist name(s) + genre + origin (as Gemini settled on them after
  // any repair cycle) + a first-letter index label computed from the
  // primary artist name.
  const finalArtistNames = parsed.meta.artistNames.length ? parsed.meta.artistNames : story.artistNames;
  const finalGenre = parsed.meta.genre || story.genre;
  const finalOrigin = parsed.meta.origin || story.origin;
  const letterLabel = firstLetterLabel(finalArtistNames[0]);
  const labels = [...finalArtistNames, finalGenre, finalOrigin, letterLabel];

  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: parsed.meta.titleEn || story.titleEn,
    contentHtml: parsed.html,
    labels,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);
  console.log(`Labels: ${labels.join(", ")}`);

  await appendLogRow(auth, config.sheetId, {
    date: new Date().toISOString(),
    status: "published",
    titleId: parsed.meta.titleId || story.titleId,
    titleEn: parsed.meta.titleEn || story.titleEn,
    artistNames: finalArtistNames.join(", "),
    genre: finalGenre,
    origin: finalOrigin,
    postUrl: published.url,
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
