/*
 * Runs one of this package's test entry points on a Node that satisfies
 * engines.node, instead of on whichever `node` happens to land first on PATH.
 *
 * npm builds the PATH for a lifecycle script by walking up from the package
 * directory and prepending every ancestor's node_modules/.bin -- all the way to
 * the filesystem root, with nothing bounding how far above the checkout it goes
 * (@npmcli/run-script/lib/set-path.js says exactly that in an XXX comment). A
 * `node` package installed in any directory above the clone therefore shadows
 * the interpreter the developer selected, and everything started through a
 * `#!/usr/bin/env node` shim boots on it.
 *
 * Both test entry points break on an interpreter below the floor, and neither
 * of them says so:
 *
 *   npm test                    vitest boots jsdom, which loads undici, which
 *                               reads markAsUncloneable out of
 *                               node:worker_threads at require time. That
 *                               symbol arrived in Node 22.10, so below it every
 *                               worker dies with `TypeError:
 *                               webidl.util.markAsUncloneable is not a
 *                               function` inside undici and the run reports
 *                               "no tests" with an exit code of 1.
 *
 *   npm run test:offline-queue  imports src/offline-queue.ts directly and
 *                               leaves the types for Node to strip, which is
 *                               only unflagged from 22.18. Below it the script
 *                               throws ERR_UNKNOWN_FILE_EXTENSION ".ts".
 *
 * Neither message names Node or a version, so the fix is not discoverable from
 * the failure. So: prefer this process's own interpreter, fall back to the one
 * npm itself is running (npm_node_execpath, the one the developer chose), then
 * to a PATH entry outside any node_modules, and refuse to guess when none of
 * them clears the floor. Refusing is the point -- a run that cannot use a
 * supported interpreter must exit non-zero rather than report green.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const fail = (message) => {
  console.error(`run-on-supported-node: ${message}`);
  process.exit(1);
};

/*
 * Only a bare `>=x.y.z` floor is understood. Widening engines.node to a real
 * semver range would leave this comparison reading the wrong thing, so say so
 * instead of quietly accepting every interpreter.
 */
const declared = (manifest.engines?.node ?? '').trim();
const floorParts = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(declared);
if (!floorParts) {
  fail(`engines.node is ${JSON.stringify(declared)}; this script only reads ">=x.y.z".`);
}
const floor = floorParts.slice(1, 4).map(Number);

const clearsFloor = (version) => {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts) {
    return false;
  }
  const found = parts.slice(1, 4).map(Number);
  for (let i = 0; i < floor.length; i += 1) {
    if (found[i] !== floor[i]) {
      return found[i] > floor[i];
    }
  }
  return true;
};

const versionOf = (executable) => {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.trim().replace(/^v/, '') : undefined;
};

const candidates = [{ path: process.execPath, version: process.versions.node }];
const add = (candidatePath) => {
  if (!candidatePath || candidates.some((c) => c.path === candidatePath)) {
    return;
  }
  const version = versionOf(candidatePath);
  if (version) {
    candidates.push({ path: candidatePath, version });
  }
};

/* The interpreter npm itself is running on -- the one the developer chose. */
add(process.env.npm_node_execpath);

/*
 * npm_node_execpath only survives one hop. The repository root delegates with
 * `npm --prefix web test`, and that nested npm is itself found on the shadowed
 * PATH, so it boots on the shadowing interpreter and then reports *that* as
 * npm_node_execpath -- both candidates above come back below the floor even
 * though a supported Node is installed and still on PATH behind the shadow.
 *
 * So fall back to scanning PATH, skipping any entry under a node_modules
 * directory: an interpreter vendored there is some package's dependency, never
 * the toolchain the developer selected, and those are exactly the entries npm
 * prepends. Ordinary installations (nvm, a system package, the CI setup-node
 * step, the Dockerfile's image) all sit outside node_modules and are found here.
 */
if (!candidates.some((candidate) => clearsFloor(candidate.version))) {
  const vendored = `${sep}node_modules${sep}`;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry && !`${entry}${sep}`.includes(vendored)) {
      add(join(entry, 'node'));
    }
  }
}

const chosen = candidates.find((candidate) => clearsFloor(candidate.version));
if (!chosen) {
  const found = [...new Set(candidates.map((c) => `${c.version} (${c.path})`))].join(', ');
  fail(
    `this package needs Node ${declared}; found ${found}. ` +
      'Install a supported Node, or check whether a `node` package in a directory ' +
      'above this checkout is shadowing it on the PATH npm gives to scripts.',
  );
}

if (chosen.path !== process.execPath) {
  console.error(
    `run-on-supported-node: PATH gave Node ${process.versions.node} (${process.execPath}), ` +
      `below engines.node ${declared}; running on ${chosen.version} (${chosen.path}) instead.`,
  );
}

/*
 * A target ending in .mjs or .js is one of this package's own scripts; anything
 * else is a dependency whose bin to resolve, so that the interpreter is chosen
 * here rather than by the shim's shebang.
 */
const [target, ...args] = process.argv.slice(2);
if (!target) {
  fail('usage: node scripts/run-on-supported-node.mjs <script.mjs|package> [args...]');
}

let entry;
if (target.endsWith('.mjs') || target.endsWith('.js')) {
  entry = join(packageRoot, target);
} else {
  const resolve = createRequire(manifestPath).resolve;
  const dependencyManifestPath = resolve(`${target}/package.json`);
  const { bin } = JSON.parse(readFileSync(dependencyManifestPath, 'utf8'));
  const relative = typeof bin === 'string' ? bin : bin?.[target];
  if (!relative) {
    fail(`${target} declares no bin named ${target}.`);
  }
  entry = join(dirname(dependencyManifestPath), relative);
}

const run = spawnSync(chosen.path, [entry, ...args], { stdio: 'inherit', cwd: packageRoot });
if (run.error) {
  fail(`could not run ${entry} on ${chosen.path}: ${run.error.message}`);
}

/*
 * A child killed by a signal reports a null status. Report that as a failure:
 * a crashed test run must never read as green.
 */
process.exit(run.status ?? 1);
