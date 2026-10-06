/*
 * Refuses a gate whose dependencies are not installed, by name.
 *
 * `typecheck`, `lint` and `build` call their tools through the shims npm puts
 * on PATH, so in a checkout where `npm ci` has not run they die as
 * `sh: 1: tsc: not found` with an exit code of 127. That names neither the
 * install nor a package -- `tsc` is a bin, and typescript is what you install
 * to get it -- and it arrives with no notice above it, which is how the same
 * missing install was misread twice as the interpreter-shadowing problem
 * run-on-supported-node.mjs exists to solve. This runs first, as those scripts'
 * pre* hook, and says which package is missing, which manifest it resolved
 * against, and the `npm ci` that fixes it. It only ever adds a refusal: a gate
 * that would have passed still passes, silently.
 *
 * Why this is a second file and not an import from run-on-supported-node.mjs,
 * whose message this repeats word for word: that file is an entry point. It
 * spawns its target as soon as it is loaded, so importing it would run a test
 * suite. It is a sibling here for the same reason verify-offline-queue.mjs and
 * verify-pwa.mjs are siblings rather than one module -- each keeps its own
 * contract, and the shared sentence is cheaper to repeat than the coupling
 * would be. The other copy is the `fail()` call in that file's dependency
 * resolution.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, 'package.json');
const resolve = createRequire(manifestPath).resolve;

const dependencies = process.argv.slice(2);
if (dependencies.length === 0) {
  console.error('require-installed: usage: node scripts/require-installed.mjs <package> [package...]');
  process.exit(1);
}

for (const dependency of dependencies) {
  try {
    resolve(`${dependency}/package.json`);
  } catch (error) {
    /*
     * Only a missing install gets relabelled. Anything else -- a manifest with
     * no exports entry for package.json, a permission error -- is a different
     * fault, and calling it a missing install would send the reader to a
     * `npm ci` that cannot help.
     */
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    console.error(
      `require-installed: ${dependency} is not installed: nothing resolves ` +
        `${dependency}/package.json from ${manifestPath}. Run ` +
        `\`npm ci --prefix ${packageRoot}\` first. This is a missing install, not an ` +
        'unsupported interpreter.',
    );
    process.exit(1);
  }
}
