import { store, isShared } from "./store.js";
import {
  parseCSV, detectMapping, loadSavedMapping, saveMapping, candidatesFromMapping,
} from "./importers/csv.js";
import { buildMessage } from "./message.js";
import { abortDownload, getCached, schedulePrefetch, statusOf, subscribe } from "./prefetch.js";

// ---------------- state ----------------

let rows = [];         // all candidates (all weeks)
let week = localStorage.getItem("pec_week") || null;
let currentKey = null;
let pending = null;    // in-flight import: {headers, records, mapping}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ---------------- data helpers ----------------

const byWeek = () => rows
  .filter((r) => r.week === week)
  .sort((a, b) => (a.submitted_at || "").localeCompare(b.submitted_at || ""));

const current = () => rows.find((r) => r.key === currentKey) || null;

function weekSortVal(w) {
  const m = String(w).match(/(\d+)/);
  return m ? Number(m[1]) : 999;
}

async function reload() {
  rows = await store.fetchAll();
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => weekSortVal(a) - weekSortVal(b));
  if (!weeks.includes(week)) week = weeks[weeks.length - 1] || null;
  renderWeekSelect(weeks);
  renderAll();
  updatePrefetch();
}

// keep downloading upcoming videos in the background, closest-first
function updatePrefetch() {
  const list = byWeek();
  const i = list.findIndex((r) => r.key === currentKey);
  schedulePrefetch(list, i === -1 ? -1 : i);
}

// ---------------- rendering ----------------

function renderWeekSelect(weeks) {
  const sel = $("weekSelect");
  sel.innerHTML = weeks.length
    ? weeks.map((w) => `<option value="${esc(w)}" ${w === week ? "selected" : ""}>${esc(w)}</option>`).join("")
    : `<option value="">No weeks imported</option>`;
}

function renderAll() {
  renderList();
  renderReviewControls();
  renderTop3();
  renderMessage();
}

function renderList() {
  const list = byWeek();
  const videos = list.filter((r) => r.is_video);
  const ready = videos.filter((r) => statusOf(r.video_url)?.status === "ready").length;
  $("listCount").textContent = list.length
    ? `${list.filter((r) => r.reviewed).length}/${list.length} reviewed · ${ready}/${videos.length} ready` : "";
  $("emptyState").classList.toggle("hidden", list.length > 0);

  $("candidateList").innerHTML = list.map((r) => {
    const when = r.submitted_at
      ? new Date(r.submitted_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : "";
    const st = r.is_video ? statusOf(r.video_url) : null;
    const cacheBadge =
      st?.status === "ready" ? `<span class="cache-badge ready" title="Downloaded — plays instantly, fully seekable">▶ ready</span>` :
      st?.status === "downloading" ? `<span class="cache-badge dl" title="Downloading in background">⬇</span>` : "";
    return `
    <div class="candidate-item ${r.key === currentKey ? "active" : ""} ${r.reviewed ? "is-reviewed" : ""}" data-key="${esc(r.key)}">
      <div class="c-name">
        ${esc(r.name)}
        <span class="c-flags">
          ${r.rank ? `<span class="rank-chip">#${r.rank}</span>` : ""}
          ${r.shortlisted ? `<span class="flag-star">★</span>` : ""}
          ${r.reviewed ? `<span class="flag-reviewed">✓</span>` : ""}
          ${r.is_video ? "" : `<span class="flag-warn" title="Not a video file">⚠</span>`}
        </span>
      </div>
      <div class="c-meta"><span>${esc(when)}</span><span>${esc(r.file_name || "")}</span>${cacheBadge}</div>
    </div>`;
  }).join("");

  for (const el of document.querySelectorAll(".candidate-item")) {
    el.onclick = () => selectCandidate(el.dataset.key);
  }
}

async function selectCandidate(key, autoplay = true) {
  currentKey = key;
  const r = current();
  const player = $("player");
  $("playerPlaceholder").classList.add("hidden");

  if (r) {
    $("nameOverlay").textContent = r.name;
    $("nameOverlay").classList.remove("hidden");
    $("openRawLink").href = r.video_url;
    if (r.is_video) {
      $("notVideoNotice").classList.add("hidden");
      // play from the local cache when the prefetcher has it (instant +
      // seekable); otherwise stream straight from Tally storage
      const cached = await getCached(r.video_url).catch(() => null);
      if (currentKey !== key) return; // user already clicked elsewhere
      if (!cached) abortDownload(r.video_url); // don't compete with the player for bandwidth
      const rate = player.playbackRate;
      player.src = cached || r.video_url;
      player.playbackRate = rate;
      if (autoplay) player.play().catch(() => {});
    } else {
      player.removeAttribute("src");
      player.load();
      $("notVideoNotice").innerHTML =
        `<span>⚠ ${esc(r.name)} uploaded <strong>${esc(r.file_name || "a non-video file")}</strong></span>
         <a href="${esc(r.video_url)}" target="_blank" rel="noopener">open it in a new tab ↗</a>`;
      $("notVideoNotice").classList.remove("hidden");
    }
  }
  renderList();
  renderReviewControls();
  updatePrefetch();
}

function renderReviewControls() {
  const r = current();
  $("reviewControls").classList.toggle("hidden", !r);
  if (!r) return;
  $("reviewedToggle").checked = !!r.reviewed;
  $("shortlistToggle").checked = !!r.shortlisted;
  if (document.activeElement !== $("notesInput")) $("notesInput").value = r.notes || "";
}

// ---------------- review state writes ----------------

async function patchCurrent(patch, { rerender = true } = {}) {
  const r = current();
  if (!r) return;
  Object.assign(r, patch);
  if (rerender) { renderList(); renderReviewControls(); renderTop3(); renderMessage(); }
  try {
    await store.saveReview(r.key, patch);
    flash($("saveStatus"), "Saved ✓");
  } catch (err) {
    toast(err.message, true);
  }
}

function flash(el, text) {
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ""; }, 1600);
}

const saveNotes = debounce(() => {
  patchCurrent({ notes: $("notesInput").value }, { rerender: false });
}, 500);

// ---------------- top 3 + message ----------------

function renderTop3() {
  const shortlisted = byWeek().filter((r) => r.shortlisted);
  $("top3Empty").classList.toggle("hidden", shortlisted.length > 0);

  $("shortlistGrid").innerHTML = shortlisted.map((r) => `
    <div class="shortlist-card ${r.rank ? "ranked" : ""}" data-key="${esc(r.key)}">
      <div class="sc-head">
        <span class="sc-name">${r.rank ? `${["", "🥇", "🥈", "🥉"][r.rank]} ` : ""}${esc(r.name)}</span>
        <button class="sc-play" data-key="${esc(r.key)}">▶ watch</button>
        <div class="rank-btns">
          ${[1, 2, 3].map((n) =>
            `<button class="rank-btn ${r.rank === n ? "active" : ""}" data-key="${esc(r.key)}" data-rank="${n}">${n}</button>`
          ).join("")}
        </div>
      </div>
      ${r.notes ? `<div class="sc-notes">📝 ${esc(r.notes)}</div>` : ""}
      ${r.rank ? `
        <textarea class="sc-reason" data-key="${esc(r.key)}"
          placeholder="Why did ${esc(r.name)} win #${r.rank}? (goes into the message)">${esc(r.reason || "")}</textarea>` : ""}
    </div>`).join("");

  for (const btn of document.querySelectorAll(".rank-btn")) {
    btn.onclick = () => toggleRank(btn.dataset.key, Number(btn.dataset.rank));
  }
  for (const btn of document.querySelectorAll(".sc-play")) {
    btn.onclick = () => { showView("review"); selectCandidate(btn.dataset.key); };
  }
  for (const ta of document.querySelectorAll(".sc-reason")) {
    ta.oninput = debounce(async () => {
      const row = rows.find((x) => x.key === ta.dataset.key);
      if (!row) return;
      row.reason = ta.value;
      renderMessage();
      try { await store.saveReview(row.key, { reason: ta.value }); }
      catch (err) { toast(err.message, true); }
    }, 500);
  }
}

async function toggleRank(key, rank) {
  const row = rows.find((x) => x.key === key);
  if (!row) return;
  const newRank = row.rank === rank ? null : rank;
  // mirror store.setRank locally
  if (newRank !== null) {
    for (const other of rows) {
      if (other.week === week && other.rank === newRank && other.key !== key) other.rank = null;
    }
  }
  row.rank = newRank;
  renderTop3(); renderMessage(); renderList();
  try { await store.setRank(week, key, newRank); }
  catch (err) { toast(err.message, true); }
}

function renderMessage() {
  const winners = byWeek()
    .filter((r) => r.shortlisted && r.rank)
    .sort((a, b) => a.rank - b.rank);
  const out = $("messageOutput");
  const hint = $("messageHint");

  if (winners.length < 3) {
    hint.textContent = `Set ranks 1, 2 and 3 to generate the message (${winners.length}/3 ranked).`;
    out.value = "";
    $("copyBtn").disabled = true;
    return;
  }
  const missing = winners.filter((w) => !(w.reason || "").trim());
  hint.textContent = missing.length
    ? `Tip: add a reason for ${missing.map((m) => m.name).join(", ")} — the message reads better with one.`
    : "Ready to share. You can still edit the text below before copying.";
  out.readOnly = false;
  out.value = buildMessage(week, winners);
  $("copyBtn").disabled = false;
}

// ---------------- import flow ----------------

function openImport() {
  pending = null;
  $("importModal").classList.remove("hidden");
  $("importStepFile").classList.remove("hidden");
  $("importStepMap").classList.add("hidden");
  $("importStepDone").classList.add("hidden");
  $("csvFileInput").value = "";
}

async function handleCsvText(text) {
  const { headers, records } = parseCSV(text);
  if (!headers.length || !records.length) {
    toast("That file looks empty — is it the right CSV export?", true);
    return;
  }
  const saved = loadSavedMapping(headers);
  if (saved) {
    // Upload columns differ per week and start out empty, so a column
    // that held no videos when the mapping was saved (e.g. W4's) must
    // still be picked up once it has files: merge fresh detection in.
    const detected = detectMapping(headers, records);
    saved.videoCols = [...new Set([...(saved.videoCols || []), ...detected.videoCols])];
  }
  pending = { headers, records, mapping: saved || detectMapping(headers, records) };
  if (saved) {
    await runImport(); // mapping confirmed before — skip straight to import
  } else {
    renderMappingUI();
    $("importStepFile").classList.add("hidden");
    $("importStepMap").classList.remove("hidden");
  }
}

function renderMappingUI() {
  const { headers, records, mapping } = pending;
  const opts = (selected) =>
    `<option value="">— none —</option>` +
    headers.map((h) => `<option value="${esc(h)}" ${h === selected ? "selected" : ""}>${esc(h)}</option>`).join("");

  $("mapName").innerHTML = opts(mapping.name);
  $("mapWeek").innerHTML = opts(mapping.week);
  $("mapSubmitted").innerHTML = opts(mapping.submitted);
  $("mapEmail").innerHTML = opts(mapping.email);
  $("mapSquad").innerHTML = opts(mapping.squad);

  $("mapVideoCols").innerHTML = headers.map((h, i) => `
    <label><input type="checkbox" data-header="${esc(h)}" ${mapping.videoCols.includes(h) ? "checked" : ""}>
    ${esc(h) || `(untitled column ${i + 1})`}</label>`).join("");

  const refresh = () => {
    pending.mapping = {
      name: $("mapName").value,
      week: $("mapWeek").value,
      submitted: $("mapSubmitted").value,
      email: $("mapEmail").value,
      squad: $("mapSquad").value,
      videoCols: [...document.querySelectorAll("#mapVideoCols input:checked")].map((c) => c.dataset.header),
    };
    const cands = candidatesFromMapping(records, pending.mapping);
    $("mapPreview").innerHTML = cands.slice(0, 4).map((c) => `
      <div class="preview-row">
        <strong>${esc(c.name)}</strong>
        <span>${esc(c.week)}</span>
        <span class="pv-dim">${esc(c.file_name)}</span>
      </div>`).join("") +
      `<div class="preview-row pv-dim">${cands.length} submissions found in total</div>`;
  };
  for (const el of document.querySelectorAll("#importStepMap select, #mapVideoCols input")) {
    el.onchange = refresh;
  }
  refresh();
}

async function runImport() {
  const { headers, records, mapping } = pending;
  const cands = candidatesFromMapping(records, mapping);
  if (!cands.length) {
    toast("No candidates found — check the name and video columns.", true);
    return;
  }
  try {
    const { added, updated } = await store.upsertCandidates(cands);
    saveMapping(headers, mapping);
    // jump to the most recently submitted week in this import
    const latest = [...cands].sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""))[0];
    week = latest.week;
    localStorage.setItem("pec_week", week);
    await reload();
    $("importSummary").innerHTML =
      `<strong>${added}</strong> new submission${added === 1 ? "" : "s"} added, ` +
      `<strong>${updated}</strong> updated with fresh links.<br>` +
      `Existing review state (reviewed / shortlist / notes / ranks) was preserved.`;
    $("importStepFile").classList.add("hidden");
    $("importStepMap").classList.add("hidden");
    $("importStepDone").classList.remove("hidden");
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- views ----------------

function showView(name) {
  $("reviewView").classList.toggle("hidden", name !== "review");
  $("top3View").classList.toggle("hidden", name !== "top3");
  $("tabReview").classList.toggle("active", name === "review");
  $("tabTop3").classList.toggle("active", name === "top3");
  if (name === "top3") { renderTop3(); renderMessage(); }
}

// ---------------- events ----------------

function wireEvents() {
  $("tabReview").onclick = () => showView("review");
  $("tabTop3").onclick = () => showView("top3");

  $("weekSelect").onchange = (e) => {
    week = e.target.value || null;
    localStorage.setItem("pec_week", week || "");
    currentKey = null;
    $("player").removeAttribute("src");
    $("player").load();
    $("nameOverlay").classList.add("hidden");
    $("playerPlaceholder").classList.remove("hidden");
    $("notVideoNotice").classList.add("hidden");
    renderAll();
    updatePrefetch();
  };

  // play an arbitrary pasted link without importing anything
  $("playLinkBtn").onclick = () => {
    const url = (window.prompt("Paste a video link to play:") || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { toast("That doesn't look like a link.", true); return; }
    currentKey = null;
    const player = $("player");
    $("playerPlaceholder").classList.add("hidden");
    $("notVideoNotice").classList.add("hidden");
    $("reviewControls").classList.add("hidden");
    $("nameOverlay").textContent = "Pasted link";
    $("nameOverlay").classList.remove("hidden");
    const rate = player.playbackRate;
    player.src = url;
    player.playbackRate = rate;
    player.play().catch(() => {});
    renderList();
  };

  // remove the selected week's data from this browser
  $("clearWeekBtn").onclick = async () => {
    if (!week) return;
    const n = byWeek().length;
    if (!window.confirm(`Remove all ${n} ${week} candidates and their review marks? This cannot be undone.`)) return;
    try {
      await store.deleteWeek(week);
      currentKey = null;
      $("player").removeAttribute("src");
      $("player").load();
      $("nameOverlay").classList.add("hidden");
      $("playerPlaceholder").classList.remove("hidden");
      await reload();
      toast(`${week} data removed.`);
    } catch (err) { toast(err.message, true); }
  };

  // import modal
  $("importBtn").onclick = openImport;
  $("importClose").onclick = () => $("importModal").classList.add("hidden");
  $("importDone").onclick = () => $("importModal").classList.add("hidden");
  $("importConfirm").onclick = runImport;
  $("csvFileInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (f) await handleCsvText(await f.text());
  };
  const dz = $("dropZone");
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("dragover"); };
  dz.ondragleave = () => dz.classList.remove("dragover");
  dz.ondrop = async (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) await handleCsvText(await f.text());
  };

  // review controls
  $("reviewedToggle").onchange = (e) => patchCurrent({ reviewed: e.target.checked });
  $("shortlistToggle").onchange = (e) => patchCurrent({ shortlisted: e.target.checked });
  $("notesInput").oninput = saveNotes;
  $("prevBtn").onclick = () => step(-1);
  $("nextBtn").onclick = () => step(1);

  const player = $("player");
  for (const b of document.querySelectorAll(".speed")) {
    b.onclick = () => {
      player.playbackRate = Number(b.dataset.speed);
      markSpeed();
    };
  }
  player.onratechange = markSpeed;
  markSpeed();

  // copy message
  $("copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("messageOutput").value);
      flash($("copyStatus"), "Copied ✓");
    } catch {
      $("messageOutput").select();
      document.execCommand("copy");
      flash($("copyStatus"), "Copied ✓");
    }
  };

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!$("importModal").classList.contains("hidden")) return;

    if (e.code === "Space") { e.preventDefault(); player.paused ? player.play() : player.pause(); }
    else if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); player.currentTime = Math.max(0, player.currentTime - 5); }
    else if (e.key === "ArrowRight") { e.preventDefault(); player.currentTime += 5; }
    else if (e.key.toLowerCase() === "s") { patchCurrent({ shortlisted: !current()?.shortlisted }); }
    else if (e.key.toLowerCase() === "d") { patchCurrent({ reviewed: !current()?.reviewed }); }
  });

  // pick up teammates' changes when coming back to the tab (shared mode)
  window.addEventListener("focus", () => {
    if (isShared) reload().catch(() => {});
  });
}

function markSpeed() {
  const rate = $("player").playbackRate;
  for (const b of document.querySelectorAll(".speed")) {
    b.classList.toggle("active", Number(b.dataset.speed) === rate);
  }
}

function step(dir) {
  const list = byWeek();
  if (!list.length) return;
  const i = list.findIndex((r) => r.key === currentKey);
  const next = list[(i === -1 ? 0 : i + dir + list.length) % list.length];
  selectCandidate(next.key);
}

// ---------------- boot ----------------

const badge = $("modeBadge");
if (isShared) {
  badge.textContent = "● Team sync";
  badge.classList.add("shared");
  badge.title = "Connected to Supabase — all reviewers see the same data.";
} else {
  badge.textContent = "● Local mode";
  badge.classList.add("local");
  badge.title = "Saved in this browser only. Paste Supabase keys in js/config.js to sync with the team (see README).";
}

subscribe(debounce(renderList, 300)); // live download badges in the list
wireEvents();
reload().catch((err) => toast(err.message, true));
