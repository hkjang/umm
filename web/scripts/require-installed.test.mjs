import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * The guard is reached through npm's pre* hook, so it is exercised through that
 * hook rather than by calling it directly: `npm run typecheck` is what a
 * developer and the runner's verification list both type, and whether npm runs
 * the hook, stops at it, and reports its exit code is part of what is under
 * test. Nothing here stands in for npm.
 *
 * Two inherited things have to be cleared or the child would not be the
 * situation being described. npm_config_* carries the outer `--prefix web`,
 * which would point this run back at the real checkout; and PATH, inside a
 * lifecycle script, already holds the real web/node_modules/.bin, which would
 * hand the temporary root a `tsc` it does not have installed. Dropping every
 * node_modules entry is the same rule run-on-supported-node.mjs applies for the
 * same reason -- a bin under node_modules belongs to some package's install,
 * never to the root being tested.
 */
const npmEntry = process.env.npm_execpath;
const runNpmScript = (root, script, scriptArgs = []) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('npm_')));
  const vendored = `${sep}node_modules${sep}`;
  env.PATH = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && !`${entry}${sep}`.includes(vendored))
    .join(delimiter);

  const args = ['--prefix', root, 'run', script];
  if (scriptArgs.length > 0) args.push('--', ...scriptArgs);
  return npmEntry
    ? spawnSync(process.execPath, [npmEntry, ...args], { encoding: 'utf8', cwd: root, env })
    : spawnSync('npm', args, { encoding: 'utf8', cwd: root, env });
};

/*
 * A copy of this package's real manifest and the real guard with no
 * node_modules beside them -- a fresh clone before `npm ci`. The files are
 * copied from the originals at run time, so they cannot drift from what ships;
 * the only difference is the missing install, which is the condition under test.
 */
const uninstalledRoots = [];
const checkoutWithoutInstall = () => {
  const root = mkdtempSync(join(tmpdir(), 'umm-web-uninstalled-'));
  uninstalledRoots.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(packageRoot, 'package.json'), join(root, 'package.json'));
  copyFileSync(join(packageRoot, 'scripts', 'require-installed.mjs'), join(root, 'scripts', 'require-installed.mjs'));
  return root;
};

const missingInstallSentence = (dependency, root) =>
  `${dependency} is not installed: nothing resolves ${dependency}/package.json from ` +
  `${join(root, 'package.json')}. Run \`npm ci --prefix ${root}\` first. This is a ` +
  'missing install, not an unsupported interpreter.';

afterAll(() => {
  for (const root of uninstalledRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('a frontend gate run in a checkout where npm ci has not run', () => {
  /*
   * One sentence per gate, naming the package rather than the bin: `tsc` is not
   * a package, and a developer told `tsc: not found` has to already know that
   * typescript provides it before the message helps.
   */
  it.each([
    ['typecheck', 'typescript'],
    ['lint', 'oxlint'],
    ['build', 'typescript'],
    ['dev', 'vite'],
    ['preview', 'vite'],
    ['e2e', '@playwright/test'],
  ])(
    'tells %s which dependency is missing, where it looked, and how to install',
    (script, dependency) => {
      const root = checkoutWithoutInstall();

      const run = runNpmScript(root, script);

      expect(run.stderr).toContain(missingInstallSentence(dependency, root));
    },
    120_000,
  );

  it.each(['typecheck', 'lint', 'build', 'dev', 'preview', 'e2e'])(
    'refuses %s with exit 1',
    (script) => {
      const run = runNpmScript(checkoutWithoutInstall(), script);

      expect(run.status).toBe(1);
    },
    120_000,
  );

  /*
   * The failures this replaces named neither the install nor anything a
   * developer could act on: `sh: 1: tsc: not found` with an exit code of 127,
   * or -- had the gates resolved through Node -- the MODULE_NOT_FOUND stack
   * ending in `Node.js v<version>` that read as the interpreter problem
   * run-on-supported-node.mjs exists to solve. Two release verifications of
   * `npm test` chased Node instead of the install, so the exact wording of that
   * misdiagnosis is pinned out of the output.
   */
  it.each(['typecheck', 'lint', 'build', 'dev', 'preview', 'e2e'])(
    'blames neither the interpreter nor a missing bin for %s',
    (script) => {
      const run = runNpmScript(checkoutWithoutInstall(), script);

      expect(run.stderr).not.toMatch(/Node\.js v\d/);
      expect(run.stderr).not.toContain('MODULE_NOT_FOUND');
      expect(run.stderr).not.toContain('Require stack');
      for (const bin of ['tsc', 'oxlint', 'prettier', 'vite', 'playwright']) {
        expect(run.stderr).not.toContain(`${bin}: not found`);
      }
    },
    120_000,
  );
});

/*
 * The control. A guard that refused everything would satisfy every assertion
 * above while breaking `npm run build`, which the release image runs -- so the
 * installed case has to be checked too, and checked for silence: a gate's log
 * should not grow a line per run for a condition that holds.
 */
describe('the same guard in this installed checkout', () => {
  it('passes every dependency the guarded scripts declare, and says nothing', () => {
    const run = spawnSync(
      process.execPath,
      [
        join(packageRoot, 'scripts', 'require-installed.mjs'),
        'typescript',
        'oxlint',
        'prettier',
        'vite',
        '@playwright/test',
      ],
      { encoding: 'utf8', cwd: packageRoot },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('');
  }, 30_000);

  // These flags reach the real CLIs without starting a server or a browser.
  it.each([
    ['dev', '--help', /Usage:\s+\$ vite \[root\]/],
    ['preview', '--help', /Usage:\s+\$ vite preview \[root\]/],
    ['e2e', '--list', /Total: [1-9]\d* tests? in [1-9]\d* files?/],
  ])(
    'lets npm run %s reach its installed CLI',
    (script, argument, cliOutput) => {
      const run = runNpmScript(packageRoot, script, [argument]);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toMatch(cliOutput);
      expect(run.stdout).not.toContain('require-installed:');
    },
    120_000,
  );
});
