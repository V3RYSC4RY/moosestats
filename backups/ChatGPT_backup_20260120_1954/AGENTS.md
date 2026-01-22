# Repository Guidelines

## Lab Collaboration Rules
- Act as the engineering partner and co-pilot for this AI-assisted dev lab.
- Focus on scripts, tools, mods, and automations for Windows, WSL, Rust, Minecraft, and general dev tasks.
- Prefer clear, readable, well-commented code over clever one-liners.
- Document any creation or change briefly in `NOTES.md` or the relevant markdown file.
- When creating or modifying scripts or important files, update `SCRIPTS.md` for scripts, append a brief note to `NOTES.md` under "Session Log", and add new TODO items to `TODO.md` in the right section.
- Keep the workspace organized; avoid dropping files outside intended folders.
- Maintain `TODO.md` for medium/long-term tasks and `SCRIPTS.md` as an index of scripts in `scripts/`.
- Ask for confirmation before running commands or making large or destructive edits.
- When restarting the local server for testing, automatically stop the existing process on port 3000 and restart without asking for confirmation.
- When unsure, propose options with tradeoffs instead of guessing.

## Project Structure & Module Organization
- Keep application code in `src/` with clear domain-driven subfolders (e.g., `api/`, `services/`, `ui/`). Place shared utilities in `src/lib/`.
- Write tests in `tests/` mirroring the `src/` layout; co-locate small, file-specific tests as `*.test.*` when practical.
- Store static assets in `assets/` and temporary build outputs in `dist/` (git-ignored). Document any new top-level folders in `NOTES.md`.

## Build, Test, and Development Commands
- Prefer a single entry point for local work: `make dev` (or `npm run dev`) to start the app with live reload. If tooling differs, add the exact command here and to `NOTES.md`.
- Run the full test suite with `make test` (or `npm test`) before pushing. Use `make lint` (or `npm run lint`) to check formatting and static analysis.
- Keep any service emulators or seed scripts callable via `make <task>` or `npm run <task>`; provide a short description inside the `Makefile` or `package.json` scripts block.

## Coding Style & Naming Conventions
- Default to 2-space indentation for JavaScript/TypeScript and JSON; 4 spaces for Python. Use trailing commas where supported to reduce diff churn.
- Favor descriptive, lowerCamelCase for variables/functions, UpperCamelCase for classes/components, and kebab-case for files (except React components using UpperCamelCase).
- Enforce automated formatting (e.g., Prettier or Black) and linting; run formatters before committing.

## Testing Guidelines
- Mirror production entry points with integration or end-to-end coverage; unit tests should focus on pure logic with minimal mocking.
- Name tests after behavior (`does_…`, `handles_…`) and keep fixtures in `tests/fixtures/`.
- Aim for meaningful coverage on critical paths (auth, data persistence, error handling) and document gaps in `NOTES.md`.

## Commit & Pull Request Guidelines
- Use concise, present-tense commit messages; follow Conventional Commits when practical (`feat:`, `fix:`, `chore:`). Group related changes together.
- Pull requests should summarize intent, list key changes, link relevant issues, and include screenshots or logs for UI/API-impacting updates.
- Ensure CI passes locally before opening a PR; call out any follow-ups or known limitations in the PR description.***
