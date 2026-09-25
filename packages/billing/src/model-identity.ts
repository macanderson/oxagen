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
 * A suffix that stamps WHEN a product was snapshot, rather than naming a
 * product: an ISO date (`2026-08-01`), the compact form (`20260801`), an
 * OpenAI-style four-digit snapshot (`0613`), or the moving `latest` pointer.
 *
 * Everything else names a different product that the vendor prices
 * separately, **including a bare or dotted number.** `gpt-5.2` is not a
 * version of `gpt-5` in any sense this file cares about: the repository's own
 * rate card prices `gpt-5` at $1.25/$10, `gpt-5.2` at $1.75/$14 and `gpt-5.5`
 * at $5/$30, and gives each its own row rather than letting one inherit from
 * another. The same card prices `grok-4` at $3/$15 above both `grok-4.5`
 * ($2/$6) and `grok-4.3` ($1.25/$2.50), so a numeric suffix rule gets the
 * direction of the error wrong as readily as its size.
 */
const POINT_IN_TIME_STAMP = /^(?:latest|\d{4}(?:[-._/]?\d{2}[-._/]?\d{2})?)$/;

/**
 * Whether `name` is the same model as the `claimed` family: the same id, or
 * that family plus a stamp that says which point-in-time snapshot of it this
 * is.
 *
 * **This is not a prefix test, not a boundary test, and not a version test.**
 * Four rounds of review taught the same lesson from four directions. Keying on
 * the model id alone ignored aliases, so an override never bound the gateway
 * form of the name it overrode. A raw `startsWith` let `gpt-4` displace
 * `gpt-4o`, and an operator who overrode one model silently repriced three.
 * Requiring the match to land on a separator fixed that pair and left the real
 * hole open: `-` is a separator, so `gpt-4o` still swallowed `gpt-4o-mini` — a
 * tenth of its price. Admitting a version suffix closed that pair and opened
 * the numeric one: `gpt-5` then claimed `gpt-5.2` and `gpt-5.5`, which the
 * rate card prices as three separate products.
 *
 * The distinction that holds is not in the punctuation and not in whether the
 * suffix looks like a number. It is whether the suffix names **one product at
 * a point in time** or **a different product**. A date or snapshot stamp is
 * the first. A release number is the second, because a vendor reprices between
 * releases and the card already carries a row per release. So inheritance is
 * restricted to the two relationships that are actually stated somewhere: an
 * **explicit alias** (settled by the exact-name test in the callers, which is
 * what binds `claude-sonnet-5` to `anthropic/claude-sonnet-5`), and a
 * **point-in-time stamp** — {@link POINT_IN_TIME_STAMP}.
 *
 * An unrecognized suffix is a DISTINCT identity, which is the safe direction.
 * A model that fails to inherit resolves to no row, the rollup records it as
 * `estimated` with a null cost, and the Pricing tab shows the gap for a person
 * to fix. A model that inherits the wrong row bills a customer at another
 * product's rate and says nothing.
 *
 * ```
 * gpt-4o            ← gpt-4o-2026-08-01      same: an ISO date stamp
 * gpt-4             ← gpt-4-0613             same: a snapshot stamp
 * claude-sonnet-5   ← claude-sonnet-5-latest same: the moving pointer
 * gpt-5             ✗ gpt-5.2                $1.25/$10 against $1.75/$14
 * grok-4            ✗ grok-4.5               $3/$15 against $2/$6
 * claude-sonnet     ✗ claude-sonnet-5        two rows in the card, not one
 * gpt-4o            ✗ gpt-4o-mini            different products
 * gpt-4             ✗ gpt-4o                 not even a segment boundary
 * ```
 */
export function isSameModelIdentity(name: string, claimed: string): boolean {
  if (name === claimed) return true;
  // A source that published an empty name claims nothing, least of all every
  // id that happens to start with a separator.
  if (claimed === "") return false;
  if (!name.startsWith(claimed)) return false;
  const last = claimed.at(-1);
  const rest =
    last !== undefined && MODEL_ID_BOUNDARY.has(last)
      ? // `claimed` already ends at a boundary (`anthropic/`), so the rest of
        // `name` is the suffix — and it has to be a stamp like any other.
        // Ending at a separator does not let a name own every id beneath it.
        name.slice(claimed.length)
      : MODEL_ID_BOUNDARY.has(name.charAt(claimed.length))
        ? name.slice(claimed.length + 1)
        : null;
  if (rest === null || rest === "") return false;
  return POINT_IN_TIME_STAMP.test(rest);
}

/**
 * Every name that {@link isSameModelIdentity} accepts as the same model as
 * `name`: the id itself, and each shorter prefix of it that the id continues
 * past with a point-in-time stamp.
 *
 * A price row can price an id only when its model or one of its aliases is in
 * this list, so a store read that asks for these names returns every row the
 * resolver could pick and none it could not use. The list is computed with
 * {@link isSameModelIdentity} itself, so the read and the resolver cannot
 * disagree about which rows match.
 */
export function claimableNames(name: string): string[] {
  const out = [name];
  for (let end = 1; end < name.length; end++) {
    const claimed = name.slice(0, end);
    if (isSameModelIdentity(name, claimed)) out.push(claimed);
  }
  return out;
}
