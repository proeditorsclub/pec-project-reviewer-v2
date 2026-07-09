# PEC Project Reviewer v2

One tool for the whole weekly review: **import the Tally CSV → watch every project → shortlist → pick the Top 3 with reasons → copy a ready-to-share message.**

---

## 1. How your work is saved

The app runs in **Local mode**: every mark (reviewed, shortlist, notes, ranks, reasons) is saved in your browser instantly and survives refresh and restarts. No account, no server, no setup. Downloaded videos are also kept in the browser, so a week you've prepared stays instant.

Two things to know:
- Your marks live in **your** browser. A teammate opening the link sees the same candidates only after importing the same CSV, and keeps their own marks.
- If you clear the browser's site data, marks and downloaded videos are gone. Don't clear it mid-week.

*(If you ever need several reviewers sharing one live set of marks, there's an optional Supabase mode — see [`js/config.js`](js/config.js) and [`supabase/schema.sql`](supabase/schema.sql).)*

## 2. Deploying the app (GitHub Pages)

The app is 100% static files, so GitHub Pages works perfectly — same setup as v1. Supabase is called directly from the browser; no server needed. (Netlify/Vercel would also work, but they add nothing here — Pages is the simplest since you already use it.)

1. Push this folder to a GitHub repository (e.g. `pec-project-reviewer-v2` under the `proeditorsclub` account).
2. In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/ (root)`** → Save.
3. After a minute the app is live at `https://proeditorsclub.github.io/pec-project-reviewer-v2/`.
4. That's it — future updates deploy automatically on every push. Already live at https://proeditorsclub.github.io/pec-project-reviewer-v2/.

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
- **Playback speed is limited by your internet connection**, not by the tool or by where it's hosted — the videos always travel from Tally's storage to your browser. Tally throttles each connection, so the app **downloads 3 videos in parallel in the background** (measured as the point that saturates a typical line), closest to your current position first, into the browser's disk cache. Items marked **▶ ready** play instantly and are fully seekable; the pulsing ⬇ shows what's downloading. The cache survives refresh. Practical tip: open the app and import 15–30 minutes before you start reviewing (or leave the tab open in the background) so videos are ready ahead of you — and review on the fastest network you have.
- Some students occasionally upload a screenshot instead of a video — those show a ⚠ marker and an "open file" link instead of the player.
