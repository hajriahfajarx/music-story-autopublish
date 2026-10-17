import { GoogleGenAI } from "@google/genai";

export function createGeminiClient({ apiKey }) {
  return new GoogleGenAI({ apiKey });
}

function isRetryableStatus(err) {
  const status = err?.status || err?.response?.status;
  return status === 503 || status === 429 || status === 500;
}

async function generateContentWithRetry(ai, params, { retries = 4, baseDelayMs = 5000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableStatus(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.log(`Gemini call failed (${err?.status || "unknown status"}), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Tries each model in `models` (in order) with its own retry-with-backoff
 * cycle, falling through to the next model only once the current one has
 * exhausted its retries. Same resilience pattern as the sibling projects.
 */
async function generateContentWithFallback(ai, models, paramsWithoutModel, retryOpts) {
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await generateContentWithRetry(ai, { ...paramsWithoutModel, model: models[i] }, retryOpts);
    } catch (err) {
      lastErr = err;
      if (i < models.length - 1) {
        console.log(`Model "${models[i]}" exhausted its retries, falling back to "${models[i + 1]}"...`);
      }
    }
  }
  throw lastErr;
}

/**
 * Asks Gemini (JSON mode) to pick ONE new, non-duplicate real musician/band
 * (or two, for a comparison piece) to write a true-story article about.
 * Dedup is by artist name, not by category/keyword (there is no fixed
 * category list in this project — genre is free-form per post).
 */
export async function pickStory(ai, models, { pastLog, extraAvoid = [] }) {
  const pastList = pastLog.length
    ? pastLog.map((r) => `- ${r.artistNames} [${r.genre}/${r.origin}] — "${r.titleId}"`).join("\n")
    : "(belum ada artikel sebelumnya)";
  const avoidExtra = extraAvoid.length ? `\n\nMusisi/band ini JUGA sudah dicoba dan harus dihindari lagi:\n${extraAvoid.join("\n")}` : "";

  const prompt = `Kamu membantu memilih SATU musisi/band nyata (boleh dua, kalau ceritanya memang membandingkan/menyinggung dua musisi/band) untuk jadi subjek artikel storytelling blog musik bilingual (Indonesia & Inggris).

Daftar musisi/band yang SUDAH PERNAH dibahas di blog ini (jangan pilih yang sama lagi):
${pastList}${avoidExtra}

Kriteria pemilihan:
- Harus musisi/band NYATA yang jelas identitasnya (bukan anonim, bukan fiksi).
- Punya kisah yang kuat secara emosi: hampir bubar, konflik internal, depresi, ditolak label, lagu yang gagal lalu sukses, comeback setelah jatuh, momen tragis atau perubahan besar, dsb.
- PENTING: hanya pilih insiden/fakta yang memang WIDELY DOCUMENTED — sudah banyak diberitakan media/dikenal publik. JANGAN memilih sudut cerita yang mengandalkan detail privat yang tidak bisa diverifikasi.
- Variasikan asal: campur antara musisi Indonesia dan internasional dari hari ke hari (jangan selalu pilih yang sama dengan daftar di atas).
- Genre bebas, sebutkan genre spesifik apa adanya (misal "Hard Rock", "Pop Rock", "Electropop", "Balada Rock", "Indonesian Pop", dst) — bukan dari daftar tetap.

Balas HANYA dalam format JSON valid (tanpa markdown, tanpa penjelasan tambahan) dengan skema persis seperti ini:
{
  "artistNames": ["<nama musisi/band utama>"],
  "genre": "<genre spesifik>",
  "origin": "Indonesia atau International (persis salah satu dari dua kata ini)",
  "titleId": "<judul draft Bahasa Indonesia, menarik/clickable>",
  "titleEn": "<judul draft Bahasa Inggris>",
  "angle": "<2-4 kalimat: peristiwa/konflik spesifik yang sudah banyak diketahui publik, yang akan jadi fokus cerita (hook, konflik, turning point)>"
}`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini pickStory returned invalid JSON: ${text?.slice(0, 500)}`);
  }

  if (!Array.isArray(parsed.artistNames) || !parsed.artistNames.length) {
    throw new Error(`Gemini pickStory returned no artistNames: ${text?.slice(0, 500)}`);
  }

  return parsed;
}

/**
 * Fills the style-guide template's INPUT PENGGUNA placeholders and asks
 * Gemini to write the full BAGIAN A + BAGIAN B bilingual story.
 */
export async function writeStory(ai, models, styleGuideTemplate, story) {
  const filled = styleGuideTemplate
    .replaceAll("{{ARTIST_NAMES}}", story.artistNames.join(" & "))
    .replaceAll("{{GENRE}}", story.genre)
    .replaceAll("{{ORIGIN}}", story.origin)
    .replaceAll("{{TITLE_ID}}", story.titleId)
    .replaceAll("{{TITLE_EN}}", story.titleEn)
    .replaceAll("{{ANGLE}}", story.angle);

  const response = await generateContentWithFallback(ai, models, {
    contents: filled,
  });

  return response.text;
}

/**
 * Sends back a list of concrete problems found in the generated HTML and
 * asks Gemini to return a corrected fenced HTML block only.
 */
export async function fixStoryHtml(ai, models, brokenHtml, issues) {
  const prompt = `Berikut adalah HTML artikel blog yang perlu diperbaiki. Ditemukan masalah berikut:

${issues.map((i) => `- ${i}`).join("\n")}

HTML yang perlu diperbaiki (perbaiki HANYA bagian yang bermasalah, jangan ubah konten lain yang sudah benar):

\`\`\`html
${brokenHtml}
\`\`\`

Balas HANYA dengan HTML yang sudah diperbaiki, dalam SATU fenced code block \`\`\`html ... \`\`\`, tanpa penjelasan tambahan, tanpa BAGIAN A, tanpa teks lain di luar code block.`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
  });

  return response.text;
}
