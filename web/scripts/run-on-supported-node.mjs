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
 * The test entry points break on an unsupported interpreter in three separate
 * ways, and none of them says so:
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
 *   npm test                    from Node 25 the `localStorage` global ships
 *                               unflagged, as an accessor on globalThis that
 *                               hands back a store needing --localstorage-file.
 *                               It outranks the one jsdom installs, so the
 *                               tests that reach for web storage fail on
 *                               `localStorage.clear is not a function` -- 58 of
 *                               186 on 25.9.0. Node 22, 23 and 24 have no such
 *                               global, and 26 will inherit it, so engines.node
 *                               names the bands that work rather than an open
 *                               upper end -- which is why it is a range with a
 *                               hole in it and not a lower bound.
 *
 *   npm run test:offline-queue  imports src/offline-queue.ts directly and
 *                               leaves the types for Node to strip, which is
 *                               only unflagged from 22.18. Below it the script
 *                               throws ERR_UNKNOWN_FILE_EXTENSION ".ts".
 *
 * None of those messages names Node or a version, so the fix is not
 * discoverable from the failure -- and the shadowing-localStorage one is worse
 * than undiscoverable, since it reads as 58 assertions about this product
 * failing. So: prefer this process's own interpreter, fall back to the one npm
 * itself is running (npm_node_execpath, the one the developer chose), then to a
 * PATH entry outside any node_modules, and refuse to guess when none of them is
 * supported. Refusing is the point -- a run that cannot use a supported
 * interpreter must exit non-zero rather than report green, and the one thing it
 * must never do is run anyway and blame the tests.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRange } from './node-range.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const fail = (message) => {
  console.error(`run-on-supported-node: ${message}`);
  process.exit(1);
};

/*
 * engines.node is the whole declaration of where these tests run, holes and
 * all; node-range.mjs returns nothing for a range it cannot read, and that has
 * to be a failure rather than a shrug -- a misread range accepts the
 * interpreters this exists to turn away.
 */
const declared = (manifest.engines?.node ?? '').trim();
const isSupported = parseRange(declared);
if (!isSupported) {
  fail(
    `engines.node is ${JSON.stringify(declared)}; this script reads "||"-separated ` +
      'clauses of "^x.y.z", ">=", ">", "<=", "<" and exact comparators.',
  );
}

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
 * npm_node_execpath -- both candidates above come back unsupported even though
 * a supported Node is installed and still on PATH behind the shadow.
 *
 * So fall back to scanning PATH, skipping any entry under a node_modules
 * directory: an interpreter vendored there is some package's dependency, never
 * the toolchain the developer selected, and those are exactly the entries npm
 * prepends. Ordinary installations (nvm, a system package, the CI setup-node
 * step, the Dockerfile's image) all sit outside node_modules and are found here.
 *
 * Which of several installed Nodes gets picked is then just PATH order, so the
 * set this walks has to be the real one: with a lower bound standing in for it,
 * a machine whose /usr/bin/node is a newer unsupported release got that one
 * chosen for it and failed as if the product were broken.
 */
if (!candidates.some((candidate) => isSupported(candidate.version))) {
  const vendored = `${sep}node_modules${sep}`;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry && !`${entry}${sep}`.includes(vendored)) {
      add(join(entry, 'node'));
    }
  }
}

const chosen = candidates.find((candidate) => isSupported(candidate.version));
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
      `which engines.node ${declared} does not cover; ` +
      `running on ${chosen.version} (${chosen.path}) instead.`,
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
