import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRange, parseVersion } from './node-range.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

describe('the declared engines.node', () => {
  const supports = parseRange(manifest.engines?.node);

  it('is a range this repository can read', () => {
    expect(supports).toBeTypeOf('function');
  });

  /*
   * Each of these is a verdict some observed failure forced. A version moving
   * from one list to the other is a claim about where the tests run, and wants
   * an interpreter it was checked on rather than an edit here.
   */
  it.each(['22.22.2', '22.23.1', '24.15.0', '24.20.0'])('admits %s', (version) => {
    expect(supports(version)).toBe(true);
  });

  it.each([
    '20.20.2', // undici reads markAsUncloneable, added in 22.10, at require time
    '22.10.0', // below jsdom's own floor
    '22.18.0', // likewise
    '23.11.1', // jsdom excludes 23.x
    '24.0.0', // below jsdom's floor for the 24 line
    '25.0.0', // ships an unflagged built-in localStorage that shadows jsdom's
    '25.9.0',
    '26.0.0', // same built-in localStorage, and no release checked here
  ])('refuses %s', (version) => {
    expect(supports(version)).toBe(false);
  });
});

describe('parseRange', () => {
  it('reads a bare lower bound', () => {
    const supports = parseRange('>=22.22.2');
    expect(supports('22.22.2')).toBe(true);
    expect(supports('22.22.1')).toBe(false);
    expect(supports('99.0.0')).toBe(true);
  });

  it('holds a caret comparator inside its major', () => {
    const supports = parseRange('^24.15.0');
    expect(supports('24.15.0')).toBe(true);
    expect(supports('24.99.0')).toBe(true);
    expect(supports('24.14.9')).toBe(false);
    expect(supports('25.0.0')).toBe(false);
  });

  it('takes a version matching any one clause', () => {
    const supports = parseRange('^22.22.2 || ^24.15.0 || >=26.0.0');
    expect(supports('22.30.0')).toBe(true);
    expect(supports('24.15.1')).toBe(true);
    expect(supports('26.1.0')).toBe(true);
    expect(supports('23.11.1')).toBe(false);
    expect(supports('25.9.0')).toBe(false);
  });

  it('requires every comparator within one clause', () => {
    const supports = parseRange('>=22.22.2 <25.0.0');
    expect(supports('24.0.0')).toBe(true);
    expect(supports('25.0.0')).toBe(false);
    expect(supports('22.0.0')).toBe(false);
  });

  it('ignores a prerelease tag so a candidate is judged as its release', () => {
    const supports = parseRange('^24.15.0');
    expect(supports('24.16.0-rc.1')).toBe(true);
    expect(supports('25.0.0-rc.1')).toBe(false);
  });

  it('accepts a leading v on the version under test', () => {
    expect(parseRange('^22.22.2')('v22.23.1')).toBe(true);
  });

  it.each(['', '   ', '*', '22.x', '>=22', '~22.22.2', '^0.1.2', 'latest', '>=22.22.2 || junk'])(
    'declines to read %o rather than guess',
    (spec) => {
      expect(parseRange(spec)).toBeUndefined();
    },
  );

  it('reports a version it cannot parse as unsupported', () => {
    expect(parseRange('>=22.22.2')('not a version')).toBe(false);
    expect(parseVersion('not a version')).toBeUndefined();
  });
});
