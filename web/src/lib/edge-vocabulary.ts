import { msg, translate } from '../i18n/translate';
import type { EdgeOrigin, EdgeRelation } from '../api';

// A connection says two things: what it means, and who decided it. The canvas
// used to print the server's raw identifier for the first and had no way to show
// the second, so a line umm guessed looked exactly like a line someone drew.

const relationLabels: Record<EdgeRelation, string> = {
  related: msg('연결됨'),
  supports: msg('뒷받침함'),
  contradicts: msg('상충함'),
  refines: msg('구체화함'),
  expands: msg('확장됨'),
  follows: msg('이어짐'),
};

const originLabels: Record<EdgeOrigin, string> = {
  manual: msg('직접 연결'),
  agent: msg('에이전트'),
  dream: msg('Dream'),
  development: msg('Dream 확장'),
  import: msg('가져오기'),
  auto: msg('자동 추천'),
};

export const relationLabel = (relation: EdgeRelation) => translate(relationLabels[relation] ?? relation);

export const originLabel = (origin: EdgeOrigin) => translate(originLabels[origin] ?? origin);

/** The order the interface offers relations in: most reached for first. */
export const relationOptions: EdgeRelation[] = ['related', 'supports', 'contradicts', 'refines', 'expands', 'follows'];

/** True when umm inferred the connection rather than anyone asserting it. */
export const isInferred = (origin: EdgeOrigin) => origin === 'auto';
