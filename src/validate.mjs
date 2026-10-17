const PLACEHOLDER_PATTERNS = [
  /\{\{.*?\}\}/,
  /\{JUDUL\}/i,
  /\{URL\}/i,
  /\[nama\s/i,
  /\[disamarkan\]/i,
  /lorem ipsum/i,
  /\bTODO\b/,
  /example\.com/i,
  /<!--\s*Indonesian content here\s*-->/i,
  /<!--\s*English content here\s*-->/i,
];

const MIN_WORDS_PER_LANGUAGE = 450;
const VALID_ORIGINS = new Set(["indonesia", "international"]);

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function extractDiv(html, id) {
  const re = new RegExp(`<div[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</div>\\s*(?=<div|<script|$)`, "i");
  const match = html.match(re);
  return match ? match[1] : "";
}

export function validateStory({ meta, html }) {
  const issues = [];

  if (!meta.titleId?.trim()) issues.push('Field BAGIAN A "titleId" kosong — wajib diisi.');
  if (!meta.titleEn?.trim()) issues.push('Field BAGIAN A "titleEn" kosong — wajib diisi.');
  if (!meta.artistNames?.length) issues.push('Field BAGIAN A "Musisi Band" kosong — wajib diisi minimal 1 nama.');
  if (!meta.genre?.trim()) issues.push('Field BAGIAN A "Genre" kosong — wajib diisi.');

  if (!meta.origin?.trim()) {
    issues.push('Field BAGIAN A "Asal" kosong — wajib diisi.');
  } else if (!VALID_ORIGINS.has(meta.origin.trim().toLowerCase())) {
    issues.push(`Field BAGIAN A "Asal" harus persis "Indonesia" atau "International", ditemukan: "${meta.origin}".`);
  }

  for (const [field, value] of [
    ["titleId", meta.titleId],
    ["titleEn", meta.titleEn],
    ["artistNamesRaw", meta.artistNamesRaw],
    ["genre", meta.genre],
    ["origin", meta.origin],
  ]) {
    if (value && PLACEHOLDER_PATTERNS.some((p) => p.test(value))) {
      issues.push(`Field BAGIAN A "${field}" masih mengandung placeholder yang belum diisi: "${value}".`);
    }
    if (value && (/^\s*\(/.test(value) || /WAJIB menggunakan/i.test(value))) {
      issues.push(`Field BAGIAN A "${field}" sepertinya berisi instruksi/catatan format yang ikut ter-copy: "${value}".`);
    }
  }

  if (!html || !html.trim()) {
    issues.push("BAGIAN B (HTML artikel) kosong atau tidak ditemukan di dalam fenced code block.");
    return { ok: false, issues };
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(html)) {
      issues.push(`HTML artikel masih mengandung placeholder yang belum diisi (pola: ${pattern}).`);
    }
  }

  if (!/window\.__setLang/i.test(html)) {
    issues.push("Script toggle bahasa (window.__setLang) tidak ditemukan di HTML.");
  }
  if (!/window\.__toggleLang/i.test(html)) {
    issues.push("Fungsi toggle satu-tombol (window.__toggleLang) tidak ditemukan di HTML.");
  }

  const buttonCount = (html.match(/<button[^>]*>/gi) || []).length;
  if (buttonCount < 1) {
    issues.push("Tombol toggle bahasa tidak ditemukan (seharusnya ada 1 tombol \"Switch language\").");
  }

  const idDiv = extractDiv(html, "indonesian-version");
  const enDiv = extractDiv(html, "english-version");

  if (!idDiv) {
    issues.push('Div id="indonesian-version" tidak ditemukan.');
  } else {
    const words = wordCount(stripHtml(idDiv));
    if (words < MIN_WORDS_PER_LANGUAGE) {
      issues.push(`Konten versi Indonesia terlalu pendek (${words} kata, minimal ${MIN_WORDS_PER_LANGUAGE}).`);
    }
  }

  if (!enDiv) {
    issues.push('Div id="english-version" tidak ditemukan.');
  } else {
    const words = wordCount(stripHtml(enDiv));
    if (words < MIN_WORDS_PER_LANGUAGE) {
      issues.push(`Konten versi Inggris terlalu pendek (${words} kata, minimal ${MIN_WORDS_PER_LANGUAGE}).`);
    }
  }

  return { ok: issues.length === 0, issues };
}
