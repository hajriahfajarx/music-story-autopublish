import { google } from "googleapis";

const SHEET_NAME = "Sheet1";
const HEADER = ["date", "status", "title_id", "title_en", "artist_names", "genre", "origin", "post_url", "reason", "content_html"];

export async function ensureHeaderRow(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:J1`,
  });
  const firstRow = data.values?.[0];
  if (!firstRow || firstRow.join("|") !== HEADER.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A1:J1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

function rowToValues(row) {
  return [
    row.date,
    row.status,
    row.titleId,
    row.titleEn,
    row.artistNames,
    row.genre || "",
    row.origin || "",
    row.postUrl || "",
    row.reason || "",
    row.contentHtml || "",
  ];
}

export async function readLogRows(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:J`,
  });
  const rows = data.values || [];
  return rows.map((row, i) => ({
    // 1-based sheet row number (row 1 is the header, data starts at row 2).
    rowIndex: i + 2,
    date: row[0] || "",
    status: row[1] || "",
    titleId: row[2] || "",
    titleEn: row[3] || "",
    // Comma-separated in the sheet; callers that need an array should split it.
    artistNames: row[4] || "",
    genre: row[5] || "",
    origin: row[6] || "",
    postUrl: row[7] || "",
    reason: row[8] || "",
    contentHtml: row[9] || "",
  }));
}

export async function appendLogRow(auth, sheetId, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowToValues(row)] },
  });
}

/**
 * Updates an existing row in place (identified by its absolute sheet row
 * number, from readLogRows' `rowIndex`) instead of appending a new one --
 * used to flip a queued `ready` row to `done` once it's actually published,
 * without disturbing any other row.
 */
export async function updateRow(auth, sheetId, rowIndex, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A${rowIndex}:J${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [rowToValues(row)] },
  });
}
