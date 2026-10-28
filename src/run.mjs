import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, updateRow, ensureHeaderRow } from "./sheets.mjs";
import { firstLetterLabel } from "./dedup.mjs";
import { publishPost } from "./blogger.mjs";

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Single daily window -- this project only ever has one post/day, so
// "already handled today" is enough. Only a terminal "posted" status blocks
// the rest of today's slots -- a "failed" row (e.g. a transient Gemini 503
// overload spell during generation) must NOT block retries. "published" is
// legacy (pre-queue) terminology; "done" is the current queue-consumed
// terminal state -- both mean "today is handled".
function alreadyHandledToday(pastLog, timeZone) {
  const today = dateStringInTz(new Date(), timeZone);
  return pastLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "done")) return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

// No Gemini call at all -- pulls the oldest `ready` row out of the queue
// (written by generate.mjs's weekly batch) and posts it.
async function main() {
  const config = loadConfig();
  const auth = getOAuthClient(config.google);

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);

  const windowId = config.publishWindow.id;
  if (process.env.FORCE_RUN === "true") {
    console.log("FORCE_RUN=true — skipping the already-handled-today guard (manual test only, never set this in the scheduled workflow).");
  } else if (windowId === "manual") {
    console.log('PUBLISH_WINDOW_ID is "manual" (workflow_dispatch or local run) — dedup guard skipped, this is an intentional extra run.');
  } else if (alreadyHandledToday(pastLog, config.publishWindow.timezone)) {
    console.log("Today already has a published/done row — skipping (prevents double-posting if slots ever overlap).");
    return;
  }

  const readyRows = pastLog.filter((row) => row.status === "ready").sort((a, b) => a.rowIndex - b.rowIndex);
  if (readyRows.length === 0) {
    console.log('No "ready" rows in the queue — nothing to publish. Run the generate workflow (or "Run workflow" on generate.yml) to top up the queue.');
    return;
  }

  const row = readyRows[0];
  console.log(`Picked queued story (row ${row.rowIndex}): ${row.artistNames} [${row.genre}/${row.origin}] — "${row.titleId}"`);

  const artistNames = row.artistNames.split(",").map((s) => s.trim()).filter(Boolean);
  const letterLabel = firstLetterLabel(artistNames[0]);
  const labels = [...artistNames, row.genre, row.origin, letterLabel];

  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: row.titleEn,
    contentHtml: row.contentHtml,
    labels,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);
  console.log(`Labels: ${labels.join(", ")}`);

  await updateRow(auth, config.sheetId, row.rowIndex, {
    ...row,
    date: new Date().toISOString(),
    status: "done",
    postUrl: published.url,
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
