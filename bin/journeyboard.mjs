#!/usr/bin/env node
// journeyboard: every screen of your app, by user flow, versioned. https://github.com/romannovosad/journeyboard
import { cli as buildCli } from '../src/build-site.mjs';
import { ci } from '../src/ci.mjs';
import { cli as commentCli } from '../src/comment.mjs';
import { design } from '../src/design.mjs';
import { init } from '../src/init.mjs';
import { cli as publishCli } from '../src/publish.mjs';

const HELP = `journeyboard <command>

  init                      set this repo up: GitHub workflow + config (run it from the repo root)
  design --dir <folder>     publish design mockups for the current branch (needs push access to the data repo)
  build --data D --out O    build the board site from a checkout of the data branch
  ci <pr|baseline|cleanup|build>
                            what the GitHub Action runs
  publish <mode> …          low level: write screens into a data checkout (see src/publish.mjs)
  comment …                 low level: print a PR comment (see src/comment.mjs)

Docs: https://github.com/romannovosad/journeyboard`;

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'init':
      init(rest);
      break;
    case 'design':
      await design(rest);
      break;
    case 'build':
      buildCli(rest);
      break;
    case 'ci':
      await ci(rest[0]);
      break;
    case 'publish':
      publishCli(rest);
      break;
    case 'comment':
      commentCli(rest);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`journeyboard ${command}: ${error.message}`);
  process.exitCode = 1;
}
