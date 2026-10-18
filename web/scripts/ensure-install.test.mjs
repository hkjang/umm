import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * Whether this script installs is only observable from outside it, so nothing
 * here stands in for npm by patching: each case puts an executable `npm` first
 * on the child's PATH that records the arguments it was handed and exits with a
 * chosen code, then reads that record back. A case that expects no install
 * asserts the record was never written.
 *
 * The two inherited things cleared below are the ones require-installed.test.mjs
 * clears, for the same reasons: npm_config_* carries the outer `--prefix web`,
 * and PATH inside a lifecycle script already holds node_modules/.bin entries --
 * which here would also hand the child a real `npm` ahead of the shim.
 */
const temporaryRoots = [];
const temporaryDirectory = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
};

const recordingNpm = (exitCode) => {
  const shimDirectory = temporaryDirectory('umm-npm-shim-');
  const log = join(shimDirectory, 'calls.txt');
  writeFileSync(join(shimDirectory, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  return { shimDirectory, log };
};

/*
 * A copy of this package's real manifest and the real script, so the fixture
 * cannot drift from what ships. No package-lock.json is copied: if the shim
 * were ever missed and the real npm ran, `npm ci` without a lockfile refuses
 * immediately instead of reaching the network.
 */
const checkoutWithout = (installed) => {
  const root = temporaryDirectory('umm-web-ensure-');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(packageRoot, 'package.json'), join(root, 'package.json'));
  copyFileSync(join(packageRoot, 'scripts', 'ensure-install.mjs'), join(root, 'scripts', 'ensure-install.mjs'));
  if (installed) {
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'package.json'), '{"name":"vitest","version":"0.0.0"}\n');
  }
  return root;
};

const runEnsureInstall = (root, shimDirectory) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('npm_')));
  const vendored = `${sep}node_modules${sep}`;
  env.PATH = [
    shimDirectory,
    ...(process.env.PATH ?? '').split(delimiter).filter((entry) => entry && !`${entry}${sep}`.includes(vendored)),
  ].join(delimiter);

  /*
   * cwd is this repository root rather than the fixture: the hook runs from
   * there, and the script has to locate its own package from import.meta.url
   * instead of from where it was called.
   */
  return spawnSync(process.execPath, [join(root, 'scripts', 'ensure-install.mjs')], {
    encoding: 'utf8',
    cwd: dirname(packageRoot),
    env,
  });
};

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('the install step the repository root runs before npm test', () => {
  it('installs nothing, and says nothing, when the dependency already resolves', () => {
    const { shimDirectory, log } = recordingNpm(0);

    const run = runEnsureInstall(checkoutWithout(true), shimDirectory);

    expect(existsSync(log)).toBe(false);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  }, 30_000);

  it('installs into its own package, by absolute path, when the dependency is missing', () => {
    const { shimDirectory, log } = recordingNpm(0);
    const root = checkoutWithout(false);

    const run = runEnsureInstall(root, shimDirectory);

    expect(readFileSync(log, 'utf8')).toBe(`ci\n--prefix\n${root}\n`);
    expect(run.status).toBe(0);
  }, 30_000);

  it('refuses, and names the install to run by hand, when the install fails', () => {
    const { shimDirectory } = recordingNpm(7);
    const root = checkoutWithout(false);

    const run = runEnsureInstall(root, shimDirectory);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`npm ci --prefix ${root}`);
  }, 30_000);
});
