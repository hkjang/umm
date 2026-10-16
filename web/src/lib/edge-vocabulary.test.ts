import { afterEach, describe, expect, it } from 'vitest';
import { isInferred, originLabel, relationLabel, relationOptions } from './edge-vocabulary';
import { setLocale } from '../i18n/translate';
import type { EdgeOrigin, EdgeRelation } from '../api';

/**
 * The whole connection vocabulary, in both languages a reader can pick.
 *
 * These two tables are annotated rather than inferred on purpose. `Record<EdgeRelation, …>`
 * makes a seventh relation in `api.ts` a typecheck error here, which is the one thing the
 * module itself cannot do: `relationOptions` is a plain `EdgeRelation[]`, so a new relation
 * would compile cleanly and then go missing from the picker that reads it
 * (`CanvasPage.tsx:2392`) and be rewritten to `related` by the guard that validates a stored
 * choice (`CanvasPage.tsx:353`) — silently, in both places. Adding the member here is a
 * compile error; the exhaustiveness test below then asks for it in `relationOptions` too.
 *
 * The English column is the wording in `en.ts`, not a better translation of it. Changing a
 * reader's words should be a deliberate edit to this file.
 */
const relationWords: Record<EdgeRelation, { ko: string; en: string }> = {
  related: { ko: '연결됨', en: 'Related' },
  supports: { ko: '뒷받침함', en: 'Supports' },
  contradicts: { ko: '상충함', en: 'Contradicts' },
  refines: { ko: '구체화함', en: 'Refines' },
  expands: { ko: '확장됨', en: 'Expands' },
  follows: { ko: '이어짐', en: 'Follows' },
};

const originWords: Record<EdgeOrigin, { ko: string; en: string }> = {
  manual: { ko: '직접 연결', en: 'Drawn by hand' },
  agent: { ko: '에이전트', en: 'Agent' },
  // 'Dream' is a product name and is written the same in both languages, so it has no
  // entry in en.ts and the fallback in `translate` hands back the source. See below.
  dream: { ko: 'Dream', en: 'Dream' },
  development: { ko: 'Dream 확장', en: 'Dream development' },
  import: { ko: '가져오기', en: 'Import' },
  auto: { ko: '자동 추천', en: 'Suggested' },
};

const relations = Object.keys(relationWords) as EdgeRelation[];
const origins = Object.keys(originWords) as EdgeOrigin[];

describe('edge vocabulary', () => {
  // setLocale writes module-global state, so a test that reads English has to put it back
  // or every later test in the file quietly runs in the wrong language.
  afterEach(() => setLocale('ko'));

  it('names every relation in Korean', () => {
    expect(relations.map(relationLabel)).toEqual(relations.map((relation) => relationWords[relation].ko));
  });

  it('names every relation in English', () => {
    setLocale('en');

    expect(relations.map(relationLabel)).toEqual(relations.map((relation) => relationWords[relation].en));
  });

  it('names every origin in Korean', () => {
    expect(origins.map(originLabel)).toEqual(origins.map((origin) => originWords[origin].ko));
  });

  it('names every origin in English', () => {
    setLocale('en');

    expect(origins.map(originLabel)).toEqual(origins.map((origin) => originWords[origin].en));
  });

  it('leaves the Dream origin untranslated, because the product name is the same in both languages', () => {
    expect(originLabel('dream')).toBe('Dream');

    setLocale('en');

    expect(originLabel('dream')).toBe('Dream');
  });

  it('offers every relation in the vocabulary and nothing else', () => {
    expect(new Set(relationOptions)).toEqual(new Set(relations));
  });

  it('offers the relations most reached for first', () => {
    expect(relationOptions).toEqual(['related', 'supports', 'contradicts', 'refines', 'expands', 'follows']);
  });

  it('counts only an automatic suggestion as inferred', () => {
    expect(origins.filter(isInferred)).toEqual(['auto']);
  });
});
