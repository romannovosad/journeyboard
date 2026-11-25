---
name: journeyboard
description: Sets up and works with journeyboard, which keeps a versioned picture of every screen of an app by user flow from Playwright tests (PR comments with before/after, a board site, per-screen history). Use when someone wants to "set up journeyboard", "add the journey map", "show screens in PRs", add or rename a screen in the journeys, add snap() calls to a new flow, hide personal data in screenshots, or publish design mockups for a branch.
---

# journeyboard

journeyboard turns screenshots taken during Playwright tests into a map of the product: a comment on each
pull request with the screens it changes, and a board of every flow with each screen's history. The pictures
live on a `journeyboard-data` branch of the repository. Full docs: https://github.com/romannovosad/journeyboard

## Set a repository up

1. Check that the repository has Playwright tests (`playwright.config.*`). If not, stop and say so: journeyboard
   needs them, and setting up Playwright is a separate piece of work.
2. From the repository root run `npx github:romannovosad/journeyboard init`, then
   `npm i -D github:romannovosad/journeyboard#v0` in the package that runs Playwright. `init` writes
   `.github/workflows/journeyboard.yml`, `.github/workflows/journeyboard-site.yml` and `journeyboard.config.json`
   and never overwrites existing files.
3. Choose a capture mode (ask if unclear):
   - **Reporter, no code changes:** add `['journeyboard/reporter']` to `reporter` and `screenshot: 'on'` to `use`
     in the Playwright config. Each passing test's last screen becomes a step; the file is the flow.
   - **`snap`, named screens:** import `test` from `journeyboard/playwright` (or wrap an existing fixture-extended
     `test` with `withSnap(base, options)`) and call `await snap('flow/step', { title })` at each screen a user
     stops at.
4. Check the generated workflow's install and test commands match how the project really runs its tests
   (package manager, working directory, a web server the tests need, environment variables). Adjust the
   workflow, not the project.
5. The board needs GitHub Pages turned on once: Settings → Pages → Source: GitHub Actions, or
   `gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow`. That changes a repository setting, so ask
   before running it. On a private repository, Pages is public unless the plan is GitHub Enterprise Cloud with
   private Pages; say so rather than publishing a private product's screens publicly.
6. Open a pull request. The comment appears when the tests finish.

## Add screens to a flow

- Names are `flow/step`, lower-case words joined by hyphens: `signup/email`, `invoicing/list`. Name screens by
  what the user is doing, not by component or route.
- One test walks one flow in order. Snap where a user would stop and look, not after every click.
- `from: 'other-flow/step'` draws an arrow from a screen in another flow (where users arrive from).
- Renaming a screen removes the old name from the board and adds the new one; its history starts over.
- Make pictures stable: fix the clock in `prepare` (`page.clock.setFixedTime(...)`), wait for fonts in
  `beforeSnap`, use fixed test data.

## Hide personal data

Add `data-journeyboard-mask` to elements showing names, emails, account numbers, balances, or pass `mask`
selectors to `withSnap` or a single `snap` call. Masked areas are painted a solid dark gray. Screenshots go
into the repository, so anything a reader of the repository should not see must be masked or faked.

## Publish design mockups for a branch

Put mockups in a folder with a `design.json`:

```json
{
  "options": [{ "id": "a", "title": "Short name", "html": "a/index.html" }],
  "targets": [{ "platform": "web", "flow": "invoicing", "step": "list", "option": "a", "image": "a/list.png" }]
}
```

Render each target image with `npx playwright screenshot --viewport-size=1440,900 a/index.html a/list.png`,
then run `npx journeyboard design --dir <folder>` on the branch. It pushes to the data branch with the
developer's own git credentials, so confirm before running it. The PR comment and board show each option next
to the screen it targets.

## When something looks wrong

- No comment on the PR: look at the workflow run. "No screenshots in …" means the tests ran without
  `JOURNEYBOARD_SHOTS` set, or no test called `snap` or produced a screenshot.
- A pull request from a fork publishes nothing, by design: its token is read-only.
- The board is not updating: check the `journeyboard site` workflow ran and that Pages is set to GitHub Actions.
