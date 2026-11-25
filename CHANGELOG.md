# Changelog

## 0.1.3 (2026-11-25)

- A screen counts as changed only when it looks different, not when its bytes differ. JPEG and anti-aliasing
  noise made PR comments cry wolf: on one pull request, 10 of 13 desktop screens listed as changed differed
  only by faint pixels along a sidebar edge. Both pictures are now decoded and compared pixel by pixel. A screen
  is changed when more than `maxPixels` pixels differ by more than `threshold` out of 255. Set this under
  `"changes"` in `journeyboard.config.json`. The defaults are `{"threshold": 40, "maxPixels": 0}`: a decimal point
  turning into a comma still reads as changed.
- When a run on the base branch differs from the baseline only by noise, the baseline keeps its existing picture
  and nothing is committed.
- JPEG decoding uses the dependency-free decoder from jpeg-js 0.4.4, vendored in `src/vendor/`, so the GitHub
  Action still runs without `npm install`. PNG decoding uses Node's own zlib.

## 0.1.2 (2026-11-25)

- The board gives phone platforms (`mobile`, `phone`, `ios`, `android`, `iphone`) tall cards, so a phone screen
  shows whole instead of cropped to its top. Before, only a platform called `mobile` got them. A platform's
  `"shape"` in the config overrides this.
- Fitting the board shows the pictures when a card's longer side is at least 100 px on screen. Before, it was
  the card's width against 110 px, which hid every picture on a fitted board of twenty-odd desktop screens.

## 0.1.1 (2026-11-25)

- `journeyboard design` asks the data repository to rebuild its board after pushing (through the GitHub CLI when
  it's logged in), so mockups show up without waiting for the next build.
- README links the live demo board.
- `init` writes workflows on the current majors of GitHub's own actions (checkout and setup-node v7, Pages
  upload and deploy v5), which run on Node 24 instead of the deprecated Node 20.

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
