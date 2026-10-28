import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, appendLogRow, ensureHeaderRow } from "./sheets.mjs";
import { createGeminiClient, pickStory, writeStory, fixStoryHtml } from "./gemini.mjs";
import { parseStoryResponse } from "./parse.mjs";
import { validateStory } from "./validate.mjs";
import { isLikelyDuplicateArtist } from "./dedup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;
const MAX_WRITE_ATTEMPTS = 2;

// Batch-writes several bilingual stories in one run (once a week, off-peak)
// and queues them as `ready` rows in the Sheet, instead of calling Gemini at
// every single daily publish moment. The daily publish job (run.mjs) then
// just pulls the oldest `ready` row and posts it -- no Gemini call at
// publish time at all.
async function main() {
  const config = loadConfig();
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "music-story-style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);
  // Grows as the batch picks artists, so later iterations in this same run
  // also avoid duplicating earlier ones -- not just past Sheet history.
  const combinedLog = [...pastLog];

  const count = parseInt(process.env.GENERATE_COUNT || "10", 10);
  console.log(`Generating ${count} article(s) into the queue...`);

  let readyCount = 0;
  let failedCount = 0;

  for (let i = 1; i <= count; i++) {
    console.log(`\n--- Article ${i}/${count} ---`);

    let story = await pickStory(ai, config.gemini.models, { pastLog: combinedLog });
    if (isLikelyDuplicateArtist(story, combinedLog)) {
      console.log("Pick looked like a duplicate artist, asking Gemini again with an explicit nudge...");
      story = await pickStory(ai, config.gemini.models, {
        pastLog: combinedLog,
        extraAvoid: [`- ${story.artistNames.join(" & ")}`],
      });
    }

    console.log(`Story chosen: ${story.artistNames.join(" & ")} [${story.genre}/${story.origin}] — "${story.titleId}"`);

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
      }
    }

    combinedLog.push({ artistNames: story.artistNames.join(", "), titleId: story.titleId, titleEn: story.titleEn });

    if (!parsed) {
      console.error(`Could not get a parseable story after ${MAX_WRITE_ATTEMPTS} attempt(s). Logging as failed, moving on to the next one.`);
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
      failedCount++;
      continue;
    }

    let result = validateStory(parsed);
    let attempt = 1;
    while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
      attempt += 1;
      console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
      result.issues.forEach((issue) => console.log(`  - ${issue}`));

      const fixedHtmlResponse = await fixStoryHtml(ai, config.gemini.models, parsed.html, result.issues);
      const fixedHtmlMatch = fixedHtmlResponse.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
      if (fixedHtmlMatch) {
        parsed = { ...parsed, html: fixedHtmlMatch[1].trim() };
      }
      result = validateStory(parsed);
    }

    if (!result.ok) {
      console.error(`Story failed validation after ${attempt} attempt(s). Logging as failed, moving on to the next one.`);
      result.issues.forEach((issue) => console.error(`  - ${issue}`));
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
      failedCount++;
      continue;
    }

    const finalArtistNames = parsed.meta.artistNames.length ? parsed.meta.artistNames : story.artistNames;
    const finalGenre = parsed.meta.genre || story.genre;
    const finalOrigin = parsed.meta.origin || story.origin;

    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "ready",
      titleId: parsed.meta.titleId || story.titleId,
      titleEn: parsed.meta.titleEn || story.titleEn,
      artistNames: finalArtistNames.join(", "),
      genre: finalGenre,
      origin: finalOrigin,
      contentHtml: parsed.html,
    });
    readyCount++;
    console.log(`Queued as ready: ${finalArtistNames.join(" & ")} — "${parsed.meta.titleId}"`);
  }

  console.log(`\nDone. ${readyCount} article(s) queued as ready, ${failedCount} failed.`);
}

main().catch((err) => {
  console.error("Generate batch failed with an unexpected error:", err);
  process.exitCode = 1;
});
