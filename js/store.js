// Storage adapter. Two implementations behind one interface:
//
//   SHARED mode — Supabase (when js/config.js is filled in). Every
//   reviewer sees the same data.
//   LOCAL mode  — this browser's localStorage. Survives refresh but is
//   not shared. Lets the app be used before Supabase is set up.
//
// Candidate row shape (also the Supabase table shape):
//   key, submission_id, name, week, video_url, file_name, is_video,
//   submitted_at, email, squad,
//   reviewed, shortlisted, notes, rank, reason

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const isShared = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const IMPORT_FIELDS = [
  "key", "submission_id", "name", "week", "video_url",
  "file_name", "is_video", "submitted_at", "email", "squad",
];

const REVIEW_DEFAULTS = { reviewed: false, shortlisted: false, notes: "", rank: null, reason: "" };

// ---------------- Supabase implementation ----------------

let sb = null;

async function client() {
  if (!sb) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return sb;
}

const sharedStore = {
  async fetchAll() {
    const db = await client();
    const { data, error } = await db.from("candidates").select("*")
      .order("submitted_at", { ascending: true });
    if (error) throw new Error("Supabase read failed: " + error.message);
    return data;
  },

  async upsertCandidates(cands) {
    const db = await client();
    const keys = cands.map((c) => c.key);
    const { data: existing, error: e1 } = await db.from("candidates")
      .select("key").in("key", keys);
    if (e1) throw new Error("Supabase read failed: " + e1.message);
    const existingKeys = new Set((existing || []).map((r) => r.key));

    // Only import fields in the payload → review columns are never touched
    // on rows that already exist.
    const payload = cands.map((c) => {
      const row = {};
      for (const f of IMPORT_FIELDS) row[f] = c[f];
      return row;
    });
    const { error: e2 } = await db.from("candidates")
      .upsert(payload, { onConflict: "key" });
    if (e2) throw new Error("Supabase write failed: " + e2.message);

    return {
      added: keys.filter((k) => !existingKeys.has(k)).length,
      updated: keys.filter((k) => existingKeys.has(k)).length,
    };
  },

  async saveReview(key, patch) {
    const db = await client();
    const { error } = await db.from("candidates").update(patch).eq("key", key);
    if (error) throw new Error("Supabase write failed: " + error.message);
  },

  async setRank(week, key, rank) {
    const db = await client();
    if (rank !== null) {
      // free the slot if another candidate in this week holds it
      const { error } = await db.from("candidates").update({ rank: null })
        .eq("week", week).eq("rank", rank).neq("key", key);
      if (error) throw new Error("Supabase write failed: " + error.message);
    }
    await this.saveReview(key, { rank });
  },
};

// ---------------- localStorage implementation ----------------

const LS_KEY = "pec_candidates_v1";

function lsLoad() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
  catch { return {}; }
}
function lsSave(map) { localStorage.setItem(LS_KEY, JSON.stringify(map)); }

const localStore = {
  async fetchAll() {
    return Object.values(lsLoad())
      .sort((a, b) => (a.submitted_at || "").localeCompare(b.submitted_at || ""));
  },

  async upsertCandidates(cands) {
    const map = lsLoad();
    let added = 0, updated = 0;
    for (const c of cands) {
      const existing = map[c.key];
      const row = existing ? { ...existing } : { ...REVIEW_DEFAULTS };
      for (const f of IMPORT_FIELDS) row[f] = c[f];
      map[c.key] = row;
      existing ? updated++ : added++;
    }
    lsSave(map);
    return { added, updated };
  },

  async saveReview(key, patch) {
    const map = lsLoad();
    if (map[key]) { Object.assign(map[key], patch); lsSave(map); }
  },

  async setRank(week, key, rank) {
    const map = lsLoad();
    if (rank !== null) {
      for (const row of Object.values(map)) {
        if (row.week === week && row.rank === rank && row.key !== key) row.rank = null;
      }
    }
    if (map[key]) map[key].rank = rank;
    lsSave(map);
  },
};

export const store = isShared ? sharedStore : localStore;
