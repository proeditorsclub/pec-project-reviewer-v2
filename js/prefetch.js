// Background video prefetcher.
//
// Tally's storage serves ~300 KB/s per connection and ignores seek
// (Range) requests — too slow to stream high-bitrate videos live. So
// while one video plays, we quietly download the NEXT ones (a few in
// parallel) into the browser's Cache Storage (on disk, survives
// refresh). A cached video starts instantly and is fully seekable.

// The bottleneck is total bandwidth (~300 KB/s to Tally, shared across
// connections), so more parallelism doesn't download faster — it only
// delays the FIRST video from becoming ready. 2 keeps the next video
// arriving soonest without one giant file blocking the whole queue.
const CACHE_NAME = "pec-videos-v1";
const CONCURRENCY = 2;

const keyFor = (fileId) => `https://pec.video.cache/${encodeURIComponent(fileId)}`;

export function fileIdOf(url) {
  const m = String(url).match(/[?&]id=([^&]+)/);
  return m ? m[1] : url.split("?")[0].split("/").pop();
}

// fileId -> { status: 'queued'|'downloading'|'ready'|'error', bytes }
const state = new Map();
const controllers = new Map(); // fileId -> AbortController for in-flight downloads
let queue = [];          // [{fileId, url}] in priority order
let active = 0;
let onChange = () => {};

// Stop a background download (used when the player wants to stream this
// exact file directly — two downloads of it would halve each other).
export function abortDownload(url) {
  const id = fileIdOf(url);
  controllers.get(id)?.abort();
}

export function subscribe(fn) { onChange = fn; }

export function statusOf(url) {
  return state.get(fileIdOf(url)) || null;
}

async function openCache() {
  try { return await caches.open(CACHE_NAME); }
  catch { return null; } // e.g. private browsing quota — degrade to plain streaming
}

// Returns a blob: URL if this video is already fully cached, else null.
const blobUrls = new Map();
export async function getCached(url) {
  const id = fileIdOf(url);
  if (blobUrls.has(id)) return blobUrls.get(id);
  const cache = await openCache();
  if (!cache) return null;
  const hit = await cache.match(keyFor(id));
  if (!hit) return null;
  const blobUrl = URL.createObjectURL(await hit.blob());
  blobUrls.set(id, blobUrl);
  state.set(id, { status: "ready", bytes: 0 });
  return blobUrl;
}

// Re-point the download queue: candidates after `currentIndex` first.
// Call whenever the visible list or selection changes.
export async function schedulePrefetch(candidates, currentIndex) {
  const cache = await openCache();
  if (!cache) return;

  const ordered = [
    ...candidates.slice(currentIndex + 1),
    ...candidates.slice(0, Math.max(currentIndex, 0)),
  ].filter((c) => c.is_video);

  // Bandwidth is one shared pipe: an in-flight download for a video far
  // from the user's new position starves the ones they'll watch next.
  // Abort actives that fell out of the near-future window (>= 6 away).
  const position = new Map(ordered.map((c, i) => [fileIdOf(c.video_url), i]));
  for (const [fileId, ctrl] of controllers) {
    const pos = position.get(fileId);
    if (pos === undefined || pos >= 6) ctrl.abort();
  }

  queue = [];
  for (const c of ordered) {
    const id = fileIdOf(c.video_url);
    const s = state.get(id);
    if (s && (s.status === "ready" || s.status === "downloading")) continue;
    if (await cache.match(keyFor(id))) {
      state.set(id, { status: "ready", bytes: 0 });
      continue;
    }
    state.set(id, { status: "queued", bytes: 0 });
    queue.push({ fileId: id, url: c.video_url });
  }
  onChange();
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const task = queue.shift();
    active++;
    download(task).finally(() => { active--; pump(); });
  }
}

async function download({ fileId, url }) {
  const cache = await openCache();
  if (!cache) return;
  const ctrl = new AbortController();
  controllers.set(fileId, ctrl);
  try {
    state.set(fileId, { status: "downloading", bytes: 0 });
    onChange();
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

    let bytes = 0;
    let lastPing = 0;
    const progress = new TransformStream({
      transform(chunk, ctrl) {
        bytes += chunk.byteLength;
        const now = Date.now();
        if (now - lastPing > 700) {
          lastPing = now;
          state.set(fileId, { status: "downloading", bytes });
          onChange();
        }
        ctrl.enqueue(chunk);
      },
    });

    // cache.put streams straight to disk; resolves when fully stored
    await cache.put(keyFor(fileId), new Response(res.body.pipeThrough(progress), {
      headers: { "Content-Type": res.headers.get("content-type") || "video/mp4" },
    }));
    state.set(fileId, { status: "ready", bytes });
  } catch (err) {
    // aborted = intentional (player took over); forget it so a later
    // schedulePrefetch can re-queue it. Anything else = real error.
    if (ctrl.signal.aborted) state.delete(fileId);
    else state.set(fileId, { status: "error", bytes: 0 });
  }
  controllers.delete(fileId);
  onChange();
}
