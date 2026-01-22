# TODO

## Now
- [ ] Verify drag-and-drop order persistence across refresh and reload.
- [ ] Compare scrape timing for per-tab vs per-player strategy and log results.
- [ ] Identify the first automation target (Windows/WSL bootstrap, Rust project scaffold, or Minecraft mod helper).
- [ ] Draft the first helper script in `scripts/` and register it in `SCRIPTS.md`.
- [ ] Resolve Playwright install on WSL NTFS path (`npm install playwright` failed with EPERM chmod); options: move repo to ext4, remount with metadata, or install from Windows side.
- [ ] Confirm Farming tab column labels on Moose stats and adjust scraper patterns if needed.
- [ ] Confirm PvE/Building tab column labels on Moose stats and adjust scraper patterns if needed.
- [ ] Capture the correct PvE tab id from Moose stats to lock the scraper selection.
- [ ] Verify the server dropdown switches between US Monthly and US Biweekly in the dashboard and `scripts/moose_compare.js`.
- [ ] Verify add/remove works with new SteamID64 resolution and missing-player handling.
- [ ] Verify deletion down to zero players and refresh gating at two players.
- [ ] Use server debug info to confirm the selected server label and list items when missing stats occur.
- [x] Fix `scripts/moose_compare.js` server selection: updated to click the dropdown button and select option by role to avoid strict-mode collision.
- [ ] Inspect server dropdown DOM after click to find the actual selector/role/text for “US Monthly (Premium)” so Playwright can click it; prior attempt timed out waiting for `.mud-popover` text match.
- [x] Re-run Moose script with updated search input selector and 10s timeout; succeeded and wrote chart.
- [ ] Install Playwright host dependencies on WSL for browser runs (`sudo npx playwright install-deps` or apt libs) if running the script headlessly in WSL.
- [ ] Fix chart spacing.
- [ ] Fix bar label positioning.
- [ ] Verify CSS conflicts.
- [ ] Verify barValuePlugin math.
- [ ] Finalize UI layout polish.

## Soon
- [ ] Define standard build/test commands and document them in `AGENTS.md`.
- [ ] Add initial unit/integration test coverage for the first tooling feature.

## Someday
- [ ] Set up CI to run linting, formatting, and tests.
- [ ] Package reusable templates or starter kits for common workflows.
