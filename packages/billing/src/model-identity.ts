// The one test for "are these two model ids the same model", used by every
// pass that compares a name to a name: the source merge's precedence, and the
// resolver that picks which row prices a frame. It lives in its own module so
// both can import it without `price-book` and `price-sources` importing each
// other, and so the answer cannot drift into two implementations that disagree
// about `gpt-4` and `gpt-4o`.

/**
 * Characters that end one segment of a model id: the separators every vendor
 * uses between a family and its version, its date stamp, its size or its
 * gateway path.
 */
const MODEL_ID_BOUNDARY = new Set(["-", "/", ":", ".", "_", "@"]);

/**
 * Whether `name` is the same model as the `claimed` family: the same id, or
 * that family plus a version, date, size or path segment.
 *
 * The test is a segment boundary, not a raw `startsWith`. `gpt-4` and `gpt-4o`
 * share five characters and are different models with different prices, as are
 * `gpt-4` and `gpt-4o-mini`. Displacing on leading characters alone dropped
 * both `gpt-4o` rows in favour of an operator override for `gpt-4`; once
 * retirement closed the rows they used to have, the resolver prefix-matched
 * every `gpt-4o` call to that override and billed a frontier model at the
 * older model's rate. The operator overrode one model and silently repriced
 * three.
 *
 * `claude-sonnet` and `claude-sonnet-5` are the case this exists for: the
 * character after the family is a separator, so the second name is that
 * family's version, and an override on the family has to own it or the
 * resolver's longest-prefix match hands `claude-sonnet-5-20260901` back to the
 * list row. A `claimed` name that already ends at a separator (`anthropic/`)
 * is a boundary in itself.
 *
 * Exact alias relationships are settled before this: a lower source whose id
 * or alias is a name a higher source claimed outright is dropped on the
 * exact-name test, which is what binds the bare family and its gateway form
 * (`claude-sonnet-5` and `anthropic/claude-sonnet-5`) to one row.
 */
export function isSameModelIdentity(name: string, claimed: string): boolean {
  if (name === claimed) return true;
  // A source that published an empty name claims nothing, least of all every
  // id that happens to start with a separator.
  if (claimed === "") return false;
  if (!name.startsWith(claimed)) return false;
  const last = claimed.at(-1);
  if (last !== undefined && MODEL_ID_BOUNDARY.has(last)) return true;
  return MODEL_ID_BOUNDARY.has(name.charAt(claimed.length));
}
