import { validateStory } from "./validate.mjs";
import { parseStoryResponse } from "./parse.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// --- Case 1: broken response (empty genre, leftover placeholder, invalid Asal) ---
const brokenResponse = `
# BAGIAN A — DATA ARTIKEL

Judul Artikel ID: Kisah {JUDUL} yang Mengubah Segalanya
Judul Artikel EN: The Story That Changed Everything
Musisi Band: Dewa 19
Genre:
Asal: Indonesia-ish

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div style="text-align:center;"><button>ID</button><button>EN</button></div>
<div id="indonesian-version" style="display:none;">
  <!-- Indonesian content here -->
</div>
<div id="english-version" style="display:none;">
  <!-- English content here -->
</div>
<script>window.__setLang = function(){};</script>
\`\`\`
`;

const broken = parseStoryResponse(brokenResponse);
const brokenResult = validateStory(broken);
assert(brokenResult.ok === false, "broken response should fail validation");
assert(brokenResult.issues.length > 0, "broken response should report issues");
assert(
  brokenResult.issues.some((i) => i.toLowerCase().includes("genre")),
  "should flag the empty genre field"
);
assert(
  brokenResult.issues.some((i) => i.toLowerCase().includes("asal")),
  "should flag the invalid Asal value"
);

// --- Case 2: clean response ---
const longId = "Ini adalah paragraf contoh cerita yang cukup panjang untuk lolos validasi kata minimum. ".repeat(60);
const longEn = "This is a sufficiently long sample story paragraph to pass the minimum word count check. ".repeat(60);

const cleanResponse = `
# BAGIAN A — DATA ARTIKEL

Judul Artikel ID: Malam Ketika Dewa 19 Hampir Bubar
Judul Artikel EN: The Night Dewa 19 Almost Fell Apart
Musisi Band: Dewa 19
Genre: Pop Rock
Asal: Indonesia

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div style="text-align:center;"><button>ID</button><button>EN</button></div>
<div id="indonesian-version" style="display:none;">
  <p>${longId}</p>
</div>
<div id="english-version" style="display:none;">
  <p>${longEn}</p>
</div>
<script>window.__setLang = function(){}; window.__toggleLang = function(){};</script>
\`\`\`
`;

const clean = parseStoryResponse(cleanResponse);
const cleanResult = validateStory(clean);
if (!cleanResult.ok) {
  console.error("Clean response issues:", cleanResult.issues);
}
assert(cleanResult.ok === true, "clean, fully-filled response should pass validation");
assert(clean.meta.artistNames.length === 1 && clean.meta.artistNames[0] === "Dewa 19", "should parse a single artist name");

// --- Case 3: two artists (comparison piece) ---
const twoArtistResponse = cleanResponse.replace("Musisi Band: Dewa 19", "Musisi Band: Dewa 19, The Calling");
const twoArtists = parseStoryResponse(twoArtistResponse);
assert(
  twoArtists.meta.artistNames.length === 2 &&
    twoArtists.meta.artistNames[0] === "Dewa 19" &&
    twoArtists.meta.artistNames[1] === "The Calling",
  "should parse two comma-separated artist names"
);

if (process.exitCode === 1) {
  console.error("\nSome validate.mjs tests FAILED.");
} else {
  console.log("\nAll validate.mjs tests passed.");
}
