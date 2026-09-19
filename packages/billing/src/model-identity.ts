// The one test for "are these two model ids the same model", used by every
// pass that compares a name to a name: the source merge's precedence, and the
// resolver that picks which row prices a frame. It lives in its own module so
// both can import it without `price-book` and `price-sources` importing each
// other, and so the answer cannot drift into two implementations that disagree
// about `gpt-4o` and `gpt-4o-mini`.

/**
 * Characters that end one segment of a model id: the separators every vendor
 * uses between a family and its version, its date stamp, its size or its
 * gateway path.
 */
const MODEL_ID_BOUNDARY = new Set(["-", "/", ":", ".", "_", "@"]);

/**
 * A segment that names which RELEASE of a product this is: a version number
 * (`5`, `4.8`, `v2`), a part of a date stamp (`20260901`, or `2026`, `08`,
 * `01`), a snapshot ordinal (`002`), or the moving `latest` pointer.
 *
 * Anything else — `mini`, `nano`, `turbo`, `pro`, `flash`, `thinking`, `free`
 * — names a different product that the vendor prices separately, even though
 * it hangs off the same family name.
 */
const VERSION_SEGMENT = /^(?:v?\d+(?:\.\d+)*|latest)$/;

function segmentsOf(rest: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of rest) {
    if (MODEL_ID_BOUNDARY.has(char)) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out;
}

/**
 * Whether `name` is the same model as the `claimed` family: the same id, or
 * that family plus segments that name nothing but a version, a date stamp or
 * the `latest` pointer.
 *
 * **This is not a prefix test, and deliberately not a boundary test either.**
 * Three rounds of review taught the same lesson from three directions. Keying
 * on the model id alone ignored aliases, so an override never bound the
 * gateway form of the name it overrode. A raw `startsWith` let `gpt-4`
 * displace `gpt-4o`, and an operator who overrode one model silently repriced
 * three. Requiring the match to land on a separator fixed that pair and left
 * the real hole open: `-` is a separator, so `gpt-4o` still swallowed
 * `gpt-4o-mini` — a tenth of its price — and an organization that negotiated
 * `gpt-4o` was billed the frontier rate for every cheap call whose name starts
 * the same way.
 *
 * A fourth punctuation tweak could not close that, because the distinction is
 * not in the punctuation. `gpt-4o-2026-08-01` is the same product as `gpt-4o`
 * and `gpt-4o-mini` is a different one, yet both differ from `gpt-4o` by a
 * hyphen and one token. So inheritance is restricted to the two relationships
 * that are actually stated somewhere: an **explicit alias** (settled by the
 * exact-name test in the callers, which is what binds `claude-sonnet-5` to
 * `anthropic/claude-sonnet-5`), and a **recognized version suffix** —
 * {@link VERSION_SEGMENT}, the vocabulary the catalogs publish for releases of
 * one product.
 *
 * An unrecognized suffix is a DISTINCT identity, which is the safe direction.
 * A model that fails to inherit resolves to no row, and the rollup records it
 * as `estimated` with a null cost and the Pricing tab shows the gap. A model
 * that inherits the wrong row bills a customer at another product's rate.
 *
 * ```
 * gpt-4o            ← gpt-4o-2026-08-01   same: a date stamp
 * claude-sonnet     ← claude-sonnet-5     same: a version
 * gemini-1.5-pro    ← gemini-1.5-pro-002  same: a snapshot ordinal
 * gpt-4o            ✗ gpt-4o-mini         different products
 * gpt-4             ✗ gpt-4o              not even a segment boundary
 * claude-sonnet-5   ✗ claude-sonnet-50    not even a segment boundary
 * gpt-5             ✗ gpt-5.2             a separately priced release, not a snapshot
 * ```
 */
export function isSameModelIdentity(name: string, claimed: string): boolean {
  if (name === claimed) return true;
  // A source that published an empty name claims nothing, least of all every
  // id that happens to start with a separator.
  if (claimed === "") return false;
  if (!name.startsWith(claimed)) return false;
  const last = claimed.at(-1);
  const claimedEndsAtBoundary = last !== undefined && MODEL_ID_BOUNDARY.has(last);
  const separator = claimedEndsAtBoundary ? undefined : name.charAt(claimed.length);
  const rest = claimedEndsAtBoundary
    ? // `claimed` already ends at a boundary (`anthropic/`), so the rest of
      // `name` is the suffix — and it has to be a version like any other.
      // Ending at a separator does not let a name own every id beneath it.
      name.slice(claimed.length)
    : separator !== undefined && MODEL_ID_BOUNDARY.has(separator)
      ? name.slice(claimed.length + 1)
      : null;
  if (rest === null || rest === "") return false;
  // A `.` directly after a family name that already ends in a bare version
  // number (`gpt-5` to `gpt-5.2`) names another release the catalog prices
  // on its own, not a snapshot of this one: the repository's rate card gives
  // `gpt-5`, `gpt-5.2` and `gpt-5.5` three different rates. Require an
  // explicit alias for that shape instead of inheriting it here, while a
  // hyphenated numeric suffix (`gpt-4-0613`) still inherits as a snapshot.
  if (!claimedEndsAtBoundary && separator === "." && last !== undefined && /\d/.test(last)) {
    return false;
  }
  return segmentsOf(rest).every((segment) => VERSION_SEGMENT.test(segment));
}
