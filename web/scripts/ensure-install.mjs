/*
 * Installs this package's dependencies, once, for a caller that only knows the
 * repository root.
 *
 * The root package.json is a forwarder: it exists so that an `npm run ...`
 * typed outside this directory binds to this checkout instead of walking past
 * it, and every script there is `npm --prefix web run <the same name>`. A
 * caller that goes through it -- the automation that verifies a fresh clone,
 * someone who typed `npm test` at the top of the repository -- has no reason to
 * know that the dependencies live one directory down, and in a clone where
 * `npm ci` has not run it gets the refusal run-on-supported-node.mjs prints:
 * correct, named, and pointing at a `npm ci --prefix web` it has no way to run
 * on its own. Three verification rounds ended there. So this runs as that
 * forwarder's pretest hook and does the install itself.
 *
 * Only that one path installs. `make test-web`, CI's `working-directory: web`
 * steps and `npm --prefix web test` all keep refusing by name, because there
 * the missing install is a fact about the operator's checkout and silently
 * reinstalling under them would hide it -- and `npm ci` deletes node_modules
 * before it writes, so an install triggered where one was not wanted is
 * destructive. Hence the resolution check: when the dependency is already
 * there this exits silently without calling npm at all.
 *
 * Third sibling of run-on-supported-node.mjs and require-installed.mjs rather
 * than a branch inside either: require-installed.mjs:17-25 gives the reason,
 * and this one differs from both anyway -- they refuse, this one repairs.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Resolved from this file, not from cwd: the hook runs at the repository root. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, 'package.json');

/*
 * vitest is what the forwarded script goes on to run, so it is what decides
 * whether an install is needed.
 */
try {
  createRequire(manifestPath).resolve('vitest/package.json');
  process.exit(0);
} catch (error) {
  /*
   * Same contract as require-installed.mjs: only a missing install is handled
   * here. Anything else is a different fault, and an `npm ci` would not mend
   * it, so it is rethrown with its own message intact.
   */
  if (error?.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

console.error(
  `ensure-install: vitest does not resolve from ${manifestPath}; installing with ` +
    `\`npm ci --prefix ${packageRoot}\`.`,
);

const install = spawnSync('npm', ['ci', '--prefix', packageRoot], { stdio: 'inherit' });

/* A child killed by a signal reports a null status; that must not read as green. */
const status = install.error ? 1 : (install.status ?? 1);
if (status !== 0) {
  console.error(
    `ensure-install: that install failed${install.error ? `: ${install.error.message}` : ` with exit ${status}`}. ` +
      `Run \`npm ci --prefix ${packageRoot}\` and read its output.`,
  );
}
process.exit(status);
