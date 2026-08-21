#!/usr/bin/env node
// Fails when a user-visible Korean string is not routed through the translation
// layer. Translations are keyed by their Korean source text, so a literal that
// is never passed to `t(...)` or `translate(...)` can never be translated and
// would stay Korean for an English reader.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const sourceRoot = join(root, 'src');
// The dictionaries are keyed by Korean, so their literals are data, not copy.
const ignored = new Set(['src/i18n/en.ts', 'src/i18n/translate.ts', 'src/i18n/index.tsx']);
const hangul = /[가-힣]/;

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Replace a region with spaces so offsets — and therefore line numbers — hold. */
const blank = (source, start, end) =>
  source.slice(0, start) + source.slice(start, end).replaceAll(/[^\n]/g, ' ') + source.slice(end);

/** Blank every `t(...)` / `translate(...)` / `msg(...)` call, including nested ones. */
function blankTranslationCalls(source) {
  let output = source;
  const call = /(?<![\w$.])(?:t|translate|msg)\s*\(/g;
  let match;
  while ((match = call.exec(output)) !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < output.length; index += 1) {
      if (output[index] === '(') depth += 1;
      else if (output[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (index >= output.length) break;
    output = blank(output, match.index, index + 1);
    call.lastIndex = match.index;
  }
  return output;
}

function blankComments(source) {
  let output = source;
  for (const pattern of [/\/\*[\s\S]*?\*\//g, /\/\/[^\n]*/g, /\{\/\*[\s\S]*?\*\/\}/g]) {
    output = output.replaceAll(pattern, (text) => text.replaceAll(/[^\n]/g, ' '));
  }
  return output;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const findings = [];
for (const file of walk(sourceRoot)) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (ignored.has(name)) continue;
  const scanned = blankTranslationCalls(blankComments(readFileSync(file, 'utf8')));
  // After the translation calls and comments are blanked out, any Hangul left
  // is copy that would stay Korean in every language. Scanning characters
  // rather than string literals also catches JSX text that sits next to an
  // expression, which a literal-shaped pattern would miss.
  const lines = scanned.split('\n');
  lines.forEach((line, index) => {
    if (hangul.test(line)) findings.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`);
  });
}

// Every key the app asks for must exist in each non-default dictionary. A
// missing key still renders (in Korean), so this is a separate, explicit check
// rather than something a reader would notice.
const keyPattern = /(?<![\w$.])(?:t|translate|msg)\s*\(\s*'((?:[^'\\]|\\.)*)'/g;
const requested = new Set();
for (const file of walk(sourceRoot)) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (ignored.has(name)) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(keyPattern)) {
    const key = match[1].replaceAll("\\'", "'");
    if (hangul.test(key)) requested.add(key);
  }
}
const english = readFileSync(join(sourceRoot, 'i18n/en.ts'), 'utf8');
const translated = new Set();
for (const match of english.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|([^\s:'"]+))\s*:/gm)) {
  translated.add((match[1] ?? match[2]).replaceAll("\\'", "'"));
}
const untranslated = [...requested].filter((key) => !translated.has(key)).sort();
if (untranslated.length > 0) {
  console.error(`Keys missing an English translation (${untranslated.length}):`);
  for (const key of untranslated) console.error(`  ${key}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`Untranslated Korean strings (${findings.length}):`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('\nWrap each string in t(...) so it can be translated, or move it into a comment.');
  process.exit(1);
}
console.log(`i18n check passed: ${requested.size} keys routed through the translation layer and translated.`);
