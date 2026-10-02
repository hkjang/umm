/*
 * Reads engines.node well enough to decide whether an interpreter is one this
 * package supports.
 *
 * engines.node here is not a single floor: the versions that run these tests
 * are two disjoint bands with a hole between them (see run-on-supported-node.mjs
 * for which failures carve the hole out), so a lower bound cannot express it.
 * This understands the slice of semver range syntax that writes such a set --
 * `||`-separated clauses of `^x.y.z`, `>=`, `>`, `<=`, `<` and exact
 * comparators -- and refuses anything else rather than guessing at it, because
 * a range this reads wrongly would wave through exactly the interpreters it
 * exists to turn away.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/*
 * A trailing prerelease tag is ignored, so 26.0.0-rc.1 reads as 26.0.0. That
 * keeps a release candidate held to the same verdict as the release it is
 * standing in for.
 */
export const parseVersion = (version) => {
  const parts = VERSION.exec(String(version ?? ''));
  return parts ? parts.slice(1, 4).map(Number) : undefined;
};

const compare = (left, right) => {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
};

const COMPARATOR = /^(\^|>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/;

const parseComparator = (text) => {
  const parts = COMPARATOR.exec(text);
  if (!parts) {
    return undefined;
  }
  const operator = parts[1] ?? '=';
  const bound = parts.slice(2, 5).map(Number);
  switch (operator) {
    case '^':
      /*
       * `^0.y.z` allows only patch bumps rather than the whole major, and no
       * Node has ever had major 0, so a 0 here means the range says something
       * other than what it looks like. Refuse it instead of applying the rule
       * for majors above 0.
       */
      if (bound[0] === 0) {
        return undefined;
      }
      return (found) => compare(found, bound) >= 0 && found[0] === bound[0];
    case '>=':
      return (found) => compare(found, bound) >= 0;
    case '>':
      return (found) => compare(found, bound) > 0;
    case '<=':
      return (found) => compare(found, bound) <= 0;
    case '<':
      return (found) => compare(found, bound) < 0;
    default:
      return (found) => compare(found, bound) === 0;
  }
};

/*
 * Returns a predicate over version strings, or undefined when the range uses
 * syntax this does not read -- the caller is expected to treat that as a
 * failure and say so, not to fall back to accepting everything.
 */
export const parseRange = (spec) => {
  const clauses = String(spec ?? '')
    .split('||')
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) {
    return undefined;
  }
  const parsed = [];
  for (const clause of clauses) {
    const comparators = clause.split(/\s+/).map(parseComparator);
    if (comparators.some((comparator) => !comparator)) {
      return undefined;
    }
    parsed.push(comparators);
  }
  return (version) => {
    const found = parseVersion(version);
    if (!found) {
      return false;
    }
    return parsed.some((comparators) => comparators.every((matches) => matches(found)));
  };
};
