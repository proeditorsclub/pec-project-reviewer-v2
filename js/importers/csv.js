// CSV importer for Tally exports.
//
// This is the only module that knows about Tally's CSV shape. A future
// live importer (Tally API / webhook) just needs to produce the same
// candidate objects — see `candidatesFromMapping` for the shape — and
// the rest of the app works unchanged.

// ---------- CSV parsing (RFC 4180: quoted fields, commas, newlines) ----------

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };

  // Tally exports can repeat the same question label (e.g. one
  // "Upload your project" column per week) — make duplicates unique so
  // no column shadows another.
  const seen = new Map();
  const headers = rows[0].map((h) => {
    h = h.trim();
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const records = rows.slice(1).map((r) => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = (r[i] ?? "").trim(); });
    return rec;
  });
  return { headers, records };
}

// ---------- column auto-detection ----------

const URL_RE = /https?:\/\/[^\s,"']+/g;

function columnHasFileUrls(records, header) {
  return records.some((r) => /storage\.tally\.so|\/private\//.test(r[header] || ""));
}

export function detectMapping(headers, records) {
  const find = (...patterns) =>
    headers.find((h) => patterns.some((p) => p.test(h))) || "";

  const videoCols = headers.filter((h) => columnHasFileUrls(records, h));

  // Week: prefer an explicit "current week" question; otherwise any column
  // whose values look like W1 / Week 1.
  let week = find(/current\s*week/i);
  if (!week) {
    week = headers.find(
      (h) => !/revised/i.test(h) &&
        records.some((r) => /^w(eek)?\s*-?\s*\d+$/i.test(r[h] || ""))
    ) || find(/^week\b/i);
  }

  return {
    name: find(/pro\s*code/i, /\bname\b/i, /student/i),
    week,
    submitted: find(/submitted/i, /^date$/i, /timestamp/i),
    email: find(/e-?mail/i),
    squad: find(/squad/i, /^group/i, /^team/i),
    videoCols,
  };
}

// ---------- mapping memory (remembered per CSV header signature) ----------

const MAP_STORE_KEY = "pec_csv_mappings_v1";

export function headerSignature(headers) {
  return headers.join("");
}

export function loadSavedMapping(headers) {
  try {
    const all = JSON.parse(localStorage.getItem(MAP_STORE_KEY) || "{}");
    return all[headerSignature(headers)] || null;
  } catch { return null; }
}

export function saveMapping(headers, mapping) {
  const all = JSON.parse(localStorage.getItem(MAP_STORE_KEY) || "{}");
  all[headerSignature(headers)] = mapping;
  localStorage.setItem(MAP_STORE_KEY, JSON.stringify(all));
}

// ---------- records → candidates ----------

function normalizeWeek(raw) {
  const m = String(raw || "").trim().match(/^w(?:eek)?\s*-?\s*(\d+)$/i);
  return m ? `W${Number(m[1])}` : String(raw || "").trim();
}

function fileIdFromUrl(url) {
  const m = url.match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

function fileNameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").pop() || "");
  } catch { return ""; }
}

function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return "h" + h.toString(36);
}

const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)(\?|$)/i;

// Produces the app-wide candidate shape. `key` is stable across
// re-exports: Tally keeps the same Submission ID and file id even though
// the signed part of the URL changes — so re-imports upsert onto the same
// row (refreshing expired links) instead of duplicating or wiping state.
export function candidatesFromMapping(records, mapping) {
  const candidates = [];
  const subIdCol = Object.keys(records[0] || {}).find((h) => /submission\s*id/i.test(h));

  for (const rec of records) {
    const name = (rec[mapping.name] || "").trim();
    const week = normalizeWeek(rec[mapping.week]);
    if (!name) continue;

    for (const col of mapping.videoCols) {
      const urls = (rec[col] || "").match(URL_RE) || [];
      for (const url of urls) {
        const fid = fileIdFromUrl(url);
        const subId = subIdCol ? rec[subIdCol] : "";
        const key = subId && fid
          ? `${subId}::${fid}`
          : hashKey(`${name}|${week}|${fid || url.split("?")[0]}`);
        const fileName = fileNameFromUrl(url);
        candidates.push({
          key,
          submission_id: subId || null,
          name,
          week,
          video_url: url,
          file_name: fileName,
          is_video: VIDEO_EXT_RE.test(fileName) || VIDEO_EXT_RE.test(url.split("?")[0]),
          submitted_at: parseWhen(rec[mapping.submitted]),
          email: (rec[mapping.email] || "").trim() || null,
          squad: (rec[mapping.squad] || "").trim() || null,
        });
      }
    }
  }
  return candidates;
}

function parseWhen(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d)) return d.toISOString();
  // Tally sometimes exports "DD/MM/YYYY HH:mm:ss"
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d2 = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    if (!isNaN(d2)) return d2.toISOString();
  }
  return null;
}
