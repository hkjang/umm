import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * The wrapper is the entry point of `npm test`, so it is exercised the way npm
 * exercises it: spawned as its own process against a package root, with
 * npm_node_execpath set the way a lifecycle script sees it. Nothing here stands
 * in for it.
 */
const runWrapper = (root, args) =>
  spawnSync(process.execPath, [join(root, 'scripts', 'run-on-supported-node.mjs'), ...args], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, npm_node_execpath: process.execPath },
  });

/*
 * A copy of this package's real manifest and real scripts with no
 * node_modules beside them -- a fresh clone before `npm ci`, which is the state
 * the release verification met. The files are copied from the originals at run
 * time, so they cannot drift from what ships; the only difference is the
 * missing install, which is the condition under test.
 */
const uninstalledRoots = [];
const checkoutWithoutInstall = () => {
  const root = mkdtempSync(join(tmpdir(), 'umm-web-uninstalled-'));
  uninstalledRoots.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(packageRoot, 'package.json'), join(root, 'package.json'));
  for (const script of ['run-on-supported-node.mjs', 'node-range.mjs']) {
    copyFileSync(join(packageRoot, 'scripts', script), join(root, 'scripts', script));
  }
  return root;
};

afterAll(() => {
  for (const root of uninstalledRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('a test entry point whose dependencies are not installed', () => {
  it('says the dependency is missing instead of throwing a resolution stack', () => {
    const run = runWrapper(checkoutWithoutInstall(), ['vitest', 'run']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('run-on-supported-node:');
    expect(run.stderr).toContain('vitest');
    expect(run.stderr).toMatch(/npm ci/);
  });

  /*
   * The unhandled MODULE_NOT_FOUND this replaces ended with the running
   * interpreter's version, which read as the interpreter problem this script
   * exists to solve: two release attempts chased Node instead of the install.
   */
  it('does not blame the interpreter for an uninstalled dependency', () => {
    const run = runWrapper(checkoutWithoutInstall(), ['vitest', 'run']);

    expect(run.stderr).not.toMatch(/Node\.js v\d/);
    expect(run.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(run.stderr).not.toContain('Require stack');
  });

  it('still runs a dependency that is installed', () => {
    const run = runWrapper(packageRoot, ['vitest', '--version']);

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
