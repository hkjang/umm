import type { Space } from '../api';

/**
 * The name to show for the space someone is looking at.
 *
 * The same value reaches the canvas heading and the names of the files a
 * download produces, so both have to come from one decision rather than two.
 *
 * The fallback arrives as an argument instead of being translated here. A
 * space someone named `생각 공간` is their wording, not a translation key, and
 * calling `t` on a name would turn it into English for an English reader.
 * Only the fallback — which is ours — is translated, by the caller.
 */
export function spaceDisplayName(spaces: readonly Space[], activeSpace: string | undefined, fallback: string): string {
  const name = spaces.find((space) => space.id === activeSpace)?.name.trim();
  return name ? name : fallback;
}
