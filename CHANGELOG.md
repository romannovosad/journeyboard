# Changelog

## 0.1.1 (2026-11-25)

- `journeyboard design` asks the data repository to rebuild its board after pushing (through the GitHub CLI when
  it's logged in), so mockups show up without waiting for the next build.
- README links the live demo board.

## 0.1.0 (2026-11-25)

First public release, extracted from the journey map built for Jurnie.

- `journeyboard init` writes the GitHub workflows and config in one go.
- Two ways to capture: the `journeyboard/reporter` Playwright reporter (no code changes) and the
  `snap('flow/step')` fixture from `journeyboard/playwright` (named screens, cross-flow arrows, masking).
- GitHub Action (`romannovosad/journeyboard@v0`) with `pr`, `baseline`, `cleanup` and `build` commands. By default
  the pictures go to a `journeyboard-data` branch of the same repository, created on first use. A separate data
  repository works for products that span several repositories.
- PR comments with before/after images that render on private repositories for anyone with read access.
- Board site: flows as lanes, branches highlighted, side by side, per-screen history, design mockups. Works from
  GitHub Pages, any static host, or straight from disk.
- `journeyboard design` publishes design mockups for a branch.
- Claude Code plugin with a setup skill.
