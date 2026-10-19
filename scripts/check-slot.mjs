// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping.
//
// How it works: there's a single daily window, targeting a real-world
// landing around 12:00-14:00 WIB, with 8 fixed cron triggers spread across
// it (one every 15 min, uncommon minute offsets). Each day, a deterministic
// hash of today's date + window name picks exactly one slot as "today's
// real slot". Every trigger checks the cron expression GitHub says fired it
// (github.event.schedule) against a static map; only the one matching
// today's chosen slot proceeds. This spreads the post across the window
// without ever sleeping in the runner.
//
// Keep this file dependency-free (Node builtins only) so it can run before
// `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
//
// COMPENSATED: configured 00:37-02:22 UTC for a real-world landing around
// 05:00-07:00 UTC = 12:00-14:00 WIB. Observed in practice: GitHub was
// delivering this account's scheduled triggers ~4-4.5h late (likely queuing
// congestion on common :00/:15/:30/:45 marks), so this is shifted earlier +
// uses uncommon minute offsets. Re-tune if the delay pattern changes.
const CRON_MAP = {
  "37 0 * * *": { window: "daily", slot: 0 },
  "52 0 * * *": { window: "daily", slot: 1 },
  "7 1 * * *": { window: "daily", slot: 2 },
  "22 1 * * *": { window: "daily", slot: 3 },
  "37 1 * * *": { window: "daily", slot: 4 },
  "52 1 * * *": { window: "daily", slot: 5 },
  "7 2 * * *": { window: "daily", slot: 6 },
  "22 2 * * *": { window: "daily", slot: 7 },
};
const SLOTS_PER_WINDOW = { daily: 8 };

function todayDateString(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function chosenSlotForWindow(dateStr, windowName) {
  const hash = createHash("sha256").update(`${dateStr}:${windowName}`).digest();
  return hash[0] % SLOTS_PER_WINDOW[windowName];
}

function writeOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(outFile, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

const eventName = process.env.EVENT_NAME || "";
const scheduleCron = process.env.SCHEDULE_CRON || "";
const timezone = process.env.PUBLISH_TIMEZONE || "Asia/Jakarta";

if (eventName !== "schedule") {
  console.log(`Event is "${eventName}" (not a scheduled cron) — always proceeding immediately.`);
  writeOutput("proceed", "true");
  writeOutput("window", "manual");
} else {
  const entry = CRON_MAP[scheduleCron];
  const dateStr = todayDateString(timezone);

  if (!entry) {
    console.log(`Unrecognized schedule cron "${scheduleCron}" — proceeding to be safe.`);
    writeOutput("proceed", "true");
    writeOutput("window", "unknown");
  } else {
    const chosenSlot = chosenSlotForWindow(dateStr, entry.window);
    const proceed = entry.slot === chosenSlot;
    console.log(`Date ${dateStr}, window "${entry.window}": chosen slot is ${chosenSlot}/${SLOTS_PER_WINDOW[entry.window] - 1}, this trigger is slot ${entry.slot} ("${scheduleCron}"). Proceed: ${proceed}`);
    writeOutput("proceed", String(proceed));
    writeOutput("window", entry.window);
  }
}
