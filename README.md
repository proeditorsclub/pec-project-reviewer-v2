# PEC Project Reviewer v2

One tool for the whole weekly review: **import the Tally CSV → watch every project (streams instantly, no downloading) → shortlist → pick the Top 3 with reasons → copy a ready-to-share message.** Everything is saved to a shared database, so the whole team sees the same state and nothing is lost on refresh.

---

## 1. One-time setup: the shared database (Supabase, free)

Until this step is done the app still works in **"Local mode"** — your marks are saved in your own browser only. Doing this step turns on **"Team sync"** for everyone.

1. Go to [supabase.com](https://supabase.com) and sign up (free).
2. Click **New project**. Name it `pec-reviewer`, set any strong database password (you won't need it day-to-day), pick the region closest to you (Mumbai), and create it.
3. In the left sidebar open **SQL Editor** → **New query**. Open the file [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy ALL of it, paste it into the query box and press **Run**. You should see "Success".
4. In the left sidebar open **Settings → API**. You'll see two things you need:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string starting with `eyJ...`)
5. Open [`js/config.js`](js/config.js) in this repo and paste them between the quotes:

   ```js
   export const SUPABASE_URL = "https://abcdefgh.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```

6. Save, commit, and deploy (next section). The badge in the top-right of the app switches from **"Local mode"** to **"Team sync"**.

> **Is it safe to commit the anon key?** Yes — the anon key is designed to be public (every visitor's browser gets it anyway). What must **never** be committed is the `service_role` key — don't copy that one. Note that anyone who has the app's URL and the anon key can read/write review data, so share the app link only with your team.

## 2. Deploying the app (GitHub Pages)

The app is 100% static files, so GitHub Pages works perfectly — same setup as v1. Supabase is called directly from the browser; no server needed. (Netlify/Vercel would also work, but they add nothing here — Pages is the simplest since you already use it.)

1. Push this folder to a GitHub repository (e.g. `pec-project-reviewer-v2` under the `proeditorsclub` account).
2. In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/ (root)`** → Save.
3. After a minute the app is live at `https://proeditorsclub.github.io/pec-project-reviewer-v2/`.
4. Share that link with the review team. That's it — future updates deploy automatically on every push.

## 3. Every week: the review flow

1. **Export the CSV from Tally**: open the form (e.g. *B14 - Project Submission HUB*) → **Submissions** → **Export** → CSV.
2. Open the app → **⬆ Import CSV** → drop the file in.
   - The **first time** you'll be asked to confirm which columns are the student name, week, and video uploads (the app pre-detects them). It remembers this — future imports are one click.
   - **Re-importing is always safe.** Already-imported submissions are matched by their Tally IDs: your reviewed marks, shortlists, notes and ranks are kept, and the video links are refreshed to the newest ones. Nothing is wiped.
3. Pick the week in the top bar (e.g. **W3**). Only that week's submissions show.
4. Click a candidate — the video **streams immediately** in the player with the student's name shown on top. Use:
   - **Space** play/pause · **← →** seek 5s · **Shift+← / Shift+→** previous/next student
   - **S** shortlist · **D** mark reviewed · speed buttons 1× – 2×
   - Notes save automatically as you type.
5. Open the **Top 3 & Message** tab. Your shortlist is there — click **1 / 2 / 3** on the winners and type a short reason for each.
6. The WhatsApp-ready message appears on the right (week, winners, reasons, links). Tweak it if you like, hit **📋 Copy message**, and paste it into the group.

## 4. For developers

- No build step, no dependencies to install: plain HTML/CSS/JS ES modules. The only external code is the Supabase client, loaded from a CDN **only when keys are configured**.
- Run locally: any static server, e.g. `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. (Opening `index.html` directly via `file://` won't work — ES modules need http.)
- Message wording lives in [`js/message.js`](js/message.js) — edit the template there.
- **Import seam**: all Tally-CSV knowledge is isolated in [`js/importers/csv.js`](js/importers/csv.js), which turns a CSV into candidate objects and hands them to `store.upsertCandidates()`. A live Tally sync (API polling or webhook → Supabase edge function) can be added later as a second importer producing the same objects — no rewrite needed.
- Storage is abstracted in [`js/store.js`](js/store.js): Supabase when configured, localStorage otherwise, same interface.

## Notes & limits

- Tally's video links are signed URLs served with `Content-Disposition: inline` and CORS open to `proeditorsclub.github.io` — they play directly in the browser `<video>` tag (verified with real B14 submissions). The links embed an access token; if old links ever stop working, just re-import the latest CSV export — every import refreshes all links for free.
- Tally's storage is slow (~300 KB/s per connection) and ignores byte-range requests. The app works around this by **downloading upcoming videos in the background** (3 at a time, closest to your current position first) into the browser's disk cache. Items marked **⚡** play instantly and are fully seekable; the ⬇ badge shows a download in progress. The cache survives refresh, so a week you've already been through stays instant. Only the very first video you open in a session may need to buffer the old-fashioned way.
- Some students occasionally upload a screenshot instead of a video — those show a ⚠ marker and an "open file" link instead of the player.
