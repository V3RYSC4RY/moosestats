# SCRIPTS.md

Helper scripts live in `scripts/`. Add a new row when you create a script and keep run instructions up to date.

| Name | Language | Description | How to Run |
| --- | --- | --- | --- |
| moose_compare.js | Node.js (Playwright) | Scrapes Moose stats, pulls Steam avatars, samples dominant avatar colors, syncs Steam display names, and renders a Steam-styled, zoomable Chart.js comparison with selectable server (Monthly/Biweekly). | From Windows PowerShell (with Playwright installed): `node .\scripts\moose_compare.js --server "US Biweekly (Premium)"` |
| moose_scraper.js | Node.js (Playwright) | Scraper module used by the dashboard API to pull Moose stats per player and resolve Steam profiles. | Runs via `npm start` (required by `server.js`) |
| hello.ps1 | PowerShell | Prints a green greetings message to verify the toolchain is online. | From Windows PowerShell: `powershell.exe -ExecutionPolicy Bypass -File .\scripts\hello.ps1` |
| server.js | Node.js (Express + Playwright) | Runs the Moose stats dashboard API/UI (add/remove players, refresh stats, render chart at `/`). | In WSL: `npm start` then open `http://localhost:3000/` |
| _Add new scripts below_ | — | Document purpose and inputs here. | `scripts/<name> <args>` |
