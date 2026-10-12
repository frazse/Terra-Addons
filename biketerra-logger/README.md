# Biketerra Universal Logger (Terra addon)

Port of the Tampermonkey userscript v8.15.2: live graphs, rowing (FTMS) or cycling (Biketerra's broadcast channel),
FIT recording, Intervals.icu / Strava upload, social follow. It runs on /ride* pages.

## First run
1. Cog next to the theme toggle (or the gear on the overlay while riding) > **Biketerra Universal Logger > Settings**.
2. Fill in what you use: Intervals.icu athlete ID + API key, Strava client ID / secret / refresh token, and the
   fallback FTP / heart-rate zones. Each field saves when you leave it. API keys and secrets are write-only.
3. Rowing: press **Connect** once and pick the machine in Terra's chooser. It is remembered and reconnects by itself.

## What is different from the userscript
- No credentials in the code; zones from Intervals.icu still override the fallbacks when it answers.
- Uploads go through Terra (`terra.http`): the keys are filled in by Terra and never read by the page.
- The FIT file is saved to `~/Downloads/Terra/` (the webview can't download files) and the path is shown in the summary.
- Removed the per-message follow-mode `console.log` spam (set `DEBUG = true` in logger.js to get it back).
- Switching the addon off in the cog menu removes the overlay and stops everything.
- Strava refresh tokens that rotate are stored again automatically.
