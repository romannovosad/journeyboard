import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

test('action.yml: plain values never contain ": ", which YAML reads as a nested mapping', () => {
  const bad = action
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const m = /^\s*[\w-]+: (.*)$/.exec(line);

      return m && !/^["'|>]/.test(m[1]) && !m[1].startsWith('${{') && m[1].includes(': ');
    });

  assert.deepEqual(bad, []);
});

test('action.yml: every input reaches the CLI as a JB_ variable', () => {
  const block = action.slice(action.indexOf('\ninputs:'), action.indexOf('\nruns:'));
  const inputs = [...block.matchAll(/^ {2}([a-z-]+):\s*$/gm)].map((m) => m[1]);

  assert.ok(inputs.length > 10);

  for (const input of inputs) {
    const env = `JB_${input.toUpperCase().replaceAll('-', '_')}`;

    assert.match(action, new RegExp(`${env}: \\$\\{\\{ inputs\\.${input} \\}\\}`), input);
  }
});
