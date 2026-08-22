/**
 * rotate-ai-gateway-key lib — pure core for the AI Gateway key rotation
 * script (`tools/scripts/rotate-ai-gateway-key.ts`).
 *
 * Everything here is side-effect free so it can be unit tested: parsing the
 * `vercel.tokens.json` credential file, rewriting AI_GATEWAY_API_KEY inside
 * dotenv content without disturbing the rest of the file, extracting the
 * plaintext key from the Vercel `POST /v1/api-keys` response, and resolving
 * a team slug to a team id.
 */

const ENV_KEY = "AI_GATEWAY_API_KEY";

// ── vercel.tokens.json ───────────────────────────────────────────────────────

export interface VercelTokenEntry {
  /** Team slug the token authenticates against (e.g. "oxagen", "manderson"). */
  slug: string;
  /** Vercel access token for that team's login. */
  token: string;
}

/**
 * Parse and validate the `vercel.tokens.json` payload. Accepts either a bare
 * array of entries or `{ "tokens": [...] }`. Throws with a descriptive
 * message on any malformed entry so the caller can surface it verbatim.
 */
export function parseTokensFile(raw: string): VercelTokenEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("vercel.tokens.json is not valid JSON");
  }
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" &&
        json !== null &&
        Array.isArray((json as { tokens?: unknown }).tokens)
      ? (json as { tokens: unknown[] }).tokens
      : null;
  if (list === null) {
    throw new Error(
      'vercel.tokens.json must be an array of entries or { "tokens": [...] }',
    );
  }
  return list.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`vercel.tokens.json entry ${i} is not an object`);
    }
    const { slug, token } = entry as { slug?: unknown; token?: unknown };
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(
        `vercel.tokens.json entry ${i} is missing a non-empty "slug"`,
      );
    }
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `vercel.tokens.json entry ${i} ("${slug}") is missing a non-empty "token"`,
      );
    }
    return { slug, token };
  });
}

/** Find the token entry for `slug`, or throw listing the slugs that exist. */
export function tokenForSlug(
  entries: VercelTokenEntry[],
  slug: string,
): VercelTokenEntry {
  const match = entries.find((e) => e.slug === slug);
  if (!match) {
    const known = entries.map((e) => `"${e.slug}"`).join(", ") || "(none)";
    throw new Error(
      `no token for org slug "${slug}" in vercel.tokens.json — known slugs: ${known}`,
    );
  }
  return match;
}

// ── dotenv rewriting ─────────────────────────────────────────────────────────

export interface EnvUpsertResult {
  content: string;
  /** "replaced" if an assignment existed, "appended" if the key was added. */
  action: "replaced" | "appended";
}

/**
 * Set `AI_GATEWAY_API_KEY=<value>` in dotenv `content`, preserving every other
 * line byte-for-byte. Replaces all existing assignments of the key (commented
 * lines are left alone); appends at the end when absent. Output always ends
 * with a trailing newline.
 */
export function upsertGatewayKey(
  content: string,
  value: string,
): EnvUpsertResult {
  const assignment = `${ENV_KEY}=${value}`;
  // Anchored to line start: never rewrites `# AI_GATEWAY_API_KEY=...` comments
  // or other keys that merely contain the name as a suffix.
  const keyLine = new RegExp(`^${ENV_KEY}=.*$`, "gm");
  if (keyLine.test(content)) {
    const next = content.replace(keyLine, assignment);
    return {
      content: next.endsWith("\n") ? next : `${next}\n`,
      action: "replaced",
    };
  }
  const base =
    content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  return { content: `${base}${assignment}\n`, action: "appended" };
}

// ── Vercel API response mining ───────────────────────────────────────────────

/**
 * Extract the plaintext AI Gateway key from the `POST /v1/api-keys` response.
 * Prefers well-known field names, then falls back to a recursive scan for the
 * `vck_` prefix Vercel uses for gateway keys — the response shape is not
 * covered by a published schema, so we stay defensive.
 */
export function extractGatewayKey(response: unknown): string | null {
  const preferred = ["key", "token", "secret", "value", "plaintext"];
  const seen = new Set<unknown>();
  const scan = (node: unknown, preferredOnly: boolean): string | null => {
    if (typeof node === "string") {
      return !preferredOnly && node.startsWith("vck_") ? node : null;
    }
    if (typeof node !== "object" || node === null || seen.has(node))
      return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = scan(item, preferredOnly);
        if (hit) return hit;
      }
      return null;
    }
    for (const [k, v] of Object.entries(node)) {
      if (
        preferredOnly &&
        preferred.includes(k) &&
        typeof v === "string" &&
        v.startsWith("vck_")
      ) {
        return v;
      }
      if (!preferredOnly || typeof v === "object") {
        const hit = scan(v, preferredOnly);
        if (hit) return hit;
      }
    }
    return null;
  };
  seen.clear();
  const byName = scan(response, true);
  if (byName) return byName;
  seen.clear();
  return scan(response, false);
}

// ── team resolution ──────────────────────────────────────────────────────────

export interface VercelTeam {
  id: string;
  slug: string;
}

/**
 * Pick the team matching `slug` from a `GET /v2/teams` payload. Throws with
 * the accessible slugs when absent — the usual cause is using the other
 * login's token.
 */
export function resolveTeam(teamsResponse: unknown, slug: string): VercelTeam {
  const teams =
    typeof teamsResponse === "object" &&
    teamsResponse !== null &&
    Array.isArray((teamsResponse as { teams?: unknown }).teams)
      ? ((teamsResponse as { teams: unknown[] }).teams as Array<
          Record<string, unknown>
        >)
      : [];
  const found = teams.find((t) => t.slug === slug);
  if (found && typeof found.id === "string") {
    return { id: found.id, slug };
  }
  const accessible = teams
    .map((t) => t.slug)
    .filter((s): s is string => typeof s === "string")
    .join(", ");
  throw new Error(
    `token cannot access a team with slug "${slug}" — accessible teams: ${accessible || "(none)"}. ` +
      "Each Vercel login has its own token; check vercel.tokens.json.",
  );
}

/** Mask a secret for log output: first 8 chars + length. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 8)}… (${secret.length} chars)`;
}
