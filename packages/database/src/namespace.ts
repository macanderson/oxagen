// Namespace derivation for the immutable, globally-unique agent key
// (`org_namespace.workspace_namespace.agent_slug`).
//
// A namespace is a short, human-readable, IMMUTABLE handle — like a Linear team
// key. It is deliberately SEPARATE from the org/workspace slug: slugs are
// renameable (org_slug_history / workspace_slug_history capture the trail),
// whereas a namespace is chosen once and never changes, so it can anchor a
// stable global identity.
//
// Column shape (enforced by CHECK + UNIQUE in the schema):
//   - organizations.namespace: `^[a-z0-9]{2,6}$`, globally unique.
//   - workspaces.namespace:    `^[a-z0-9]{2,6}$`, unique per org.
//
// The 32-char agentKey budget is: 6 (org) + 1 (dot) + 6 (workspace) + 1 (dot)
// + 18 (agent slug) = 32.
//
// IMPORTANT: `deriveNamespace` here is the single source of truth for the
// derivation semantics. The backfill inside migration
// 20260709120000_namespace_identity.sql reimplements the IDENTICAL algorithm in
// PL/pgSQL — keep the two in lockstep if either changes.

/** Min/max namespace length — must satisfy the `^[a-z0-9]{2,6}$` column check. */
export const NAMESPACE_MIN_LENGTH = 2;
export const NAMESPACE_MAX_LENGTH = 6;

/** Compiled column-check regex, exported so callers/tests can validate. */
export const NAMESPACE_PATTERN = /^[a-z0-9]{2,6}$/;

/**
 * Normalize a seed into the namespace alphabet: lowercase, then strip every
 * character that is not `[a-z0-9]` (hyphens, spaces, punctuation all go). The
 * result may be shorter than NAMESPACE_MIN_LENGTH (or empty) — `deriveNamespace`
 * pads it so the final value always satisfies the column check.
 */
export function normalizeNamespaceSeed(seed: string): string {
  return seed.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Lowercase the whole `taken` set ONCE, up front.
 *
 * Namespaces are citext (case-insensitive) in Postgres; candidates are always
 * lowercase, but a caller may hand us a mixed-case set from a non-citext
 * source, so the comparison has to be case-insensitive. Doing that per lookup
 * means scanning the entire set on every miss — and the collision walk below
 * can probe tens of thousands of candidates, so a per-lookup scan turns
 * `deriveNamespace` quadratic in the number of existing namespaces. The org
 * path passes EVERY org namespace on the platform (packages/handlers/src/
 * org.create.ts), which is exactly the set that grows without bound.
 */
function lowercasedSet(taken: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of taken) out.add(t.toLowerCase());
  return out;
}

/**
 * Distinct candidates the collision walk can produce for one base.
 *
 * `keep` bottoms out at 1 once the suffix reaches 5 digits, so from n = 100000
 * onward `(base[0] + suffix).slice(0, 6)` truncates back onto values already
 * probed and the walk would spin forever on a fully-occupied prefix. The walk
 * is capped one step below that repeat point and raises instead.
 */
const MAX_SUFFIX_ATTEMPTS = 100_000;

/**
 * Derive a namespace from a seed (usually the org/workspace slug), avoiding any
 * value already in `taken`. The returned value always matches `^[a-z0-9]{2,6}$`.
 *
 * Algorithm (mirrored exactly by the SQL backfill):
 *   1. Normalize the seed to `[a-z0-9]` only.
 *   2. If it is shorter than 2 chars, right-pad with '0' to 2 (guarantees ≥2).
 *   3. The first candidate is the base truncated to 6 chars.
 *   4. On collision, append the smallest numeric suffix that keeps the total at
 *      ≤6 chars, truncating the base as the suffix grows (base5+"1", …, base4+
 *      "10", …), until a free value is found.
 *
 * `taken` MUST hold the namespaces already used in the same uniqueness scope —
 * ALL orgs for `organizations.namespace`, or just the target org's workspaces
 * for `workspaces.namespace`. The caller is responsible for querying that set.
 *
 * @throws when every candidate this base can produce is already taken — the
 *   caller must retry with a different seed rather than get a wrong value or a
 *   hung process.
 */
export function deriveNamespace(
  seed: string,
  taken: ReadonlySet<string>,
): string {
  let base = normalizeNamespaceSeed(seed);
  if (base.length < NAMESPACE_MIN_LENGTH) {
    base = (base + "00").slice(0, NAMESPACE_MIN_LENGTH);
  }

  const occupied = lowercasedSet(taken);
  const first = base.slice(0, NAMESPACE_MAX_LENGTH);
  if (!occupied.has(first)) return first;

  for (let n = 1; n < MAX_SUFFIX_ATTEMPTS; n++) {
    const suffix = String(n);
    // Reserve room for the suffix; keep at least 1 char of the base.
    const keep = Math.max(1, NAMESPACE_MAX_LENGTH - suffix.length);
    const candidate = (base.slice(0, keep) + suffix).slice(
      0,
      NAMESPACE_MAX_LENGTH,
    );
    if (!occupied.has(candidate)) return candidate;
  }

  throw new Error(
    `[namespace] every namespace derivable from seed "${seed}" (base "${base}") ` +
      `is already taken after ${MAX_SUFFIX_ATTEMPTS} attempts. The 6-character ` +
      "namespace space for this prefix is exhausted — retry with a different slug.",
  );
}
