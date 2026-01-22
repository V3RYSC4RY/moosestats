## Working With This Project (Quick Start)

Use these steps next time you want to edit or run the Rusty Moose stats app.

### Launch the app
- Easiest: Use the Start Menu shortcut **Rusty Moose Stats** (Start Menu > Programs). It opens PowerShell in `C:\Users\Dubz\dev\ChatGPT`, starts the server, and opens `http://localhost:3000`.
- Manual: Open PowerShell, run:
  1) `cd C:\Users\Dubz\dev\ChatGPT`
  2) `npm install` (first time only) and `npx playwright install chromium` if browsers are missing
  3) `npm start`
  4) Open `http://localhost:3000` in a browser

### Editing with Codex
- Point Codex at `C:\Users\Dubz\dev\ChatGPT` and the files listed in `AGENTS.md`/`NOTES.md`.
- Make small changes with `apply_patch` and log notable edits in `NOTES.md`.
- Keep scripts in `scripts/`, list them in `SCRIPTS.md`, and update `TODO.md` for new follow-ups.

### Playwright notes
- If Playwright complains about missing deps on WSL, install host deps (`sudo npx playwright install-deps`) and browsers (`npx playwright install chromium`).
- Prefer running from Windows (PowerShell) for fewer permission issues with Playwright.

### Testing
- Current commands: `npm start` (serve UI + scraper). No automated tests yet; add via npm scripts when ready.

### Useful paths
- App root: `C:\Users\Dubz\dev\ChatGPT`
- Start Menu shortcut: `C:\Users\Dubz\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Rusty Moose Stats.lnk`
