// Shared by run.mjs (queue-consume) and generate.mjs (the weekly batch) --
// both need to check a freshly-picked artist against everything already
// covered (past Sheet rows, plus whatever's already been chosen earlier in
// the same generate batch, when the caller passes a combined/growing list).
export function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isLikelyDuplicateArtist(story, pastLog) {
  const normNames = new Set(story.artistNames.map(normalize));
  return pastLog.some((row) => {
    const rowNames = (row.artistNames || "").split(",").map(normalize);
    return rowNames.some((n) => n && normNames.has(n));
  });
}

// Computed in code, not asked from Gemini, so it can never mismatch the
// artist name it actually wrote (e.g. label "D" next to "The Calling").
export function firstLetterLabel(name) {
  const match = (name || "").match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : "#";
}
