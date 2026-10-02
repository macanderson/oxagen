/**
 * rotate-ai-gateway-key lib: the pure core of the AI Gateway key rotation
 * script (`tools/scripts/rotate-ai-gateway-key.ts`).
 *
 * Nothing here calls Vercel or AWS, so every function is tested without a
 * network. It reads the command line, parses the `vercel.tokens.json`
 * credential file, finds the plaintext key in Vercel's `POST /v1/api-keys`
 * response, resolves a team slug to a team id, names the parameter that holds
 * the key in each environment (ADR-240), and writes the message for a run that
 * stops partway.
 */

import { parseArgs } from "node:util";
import { withoutSeparator, type ParsedArgs } from "../env-pull";
import { parsePushTarget, targetPrefix } from "../env-push";
import { DEFAULT_REGION, type AwsTarget } from "./parameter-store";

/** The variable the gateway key is saved as, in every environment. */
export const GATEWAY_KEY_NAME = "AI_GATEWAY_API_KEY";

// ── command line ─────────────────────────────────────────────────────────────

/**
 * An environment that holds a gateway key. `staging` is the registry's
 * `preview`, kept under `/oxagen/staging`.
 */
export type RotateEnv = "development" | "staging" | "production";

/** The order a run saves in, so a failure stops before production. */
const ENV_ORDER: readonly RotateEnv[] = ["development", "staging", "production"];

export const ROTATE_USAGE = [
  "Usage: pnpm vercel:rotate-ai-key <team-slug> --env <environments> " +
    "[--dry-run] [--profile <name>] [--region <region>]",
  "       pnpm vercel:rotate-ai-key --init",
  "<environments> is development, staging, or production. Repeat --env, or " +
    "separate names with commas: --env staging,production.",
].join("\n");

export type RotateCommand =
  | { mode: "init" }
  | ({
      mode: "rotate";
      /** The Vercel team slug, which picks the token in vercel.tokens.json. */
      slug: string;
      /** Each environment to save a new key in, in ENV_ORDER. */
      envs: RotateEnv[];
      dryRun: boolean;
    } & AwsTarget);

/**
 * Read every `--env` value. Each one may hold several names separated by
 * commas. `preview` is read as staging, as env:push reads it. The result has
 * no repeats and follows ENV_ORDER.
 */
function readEnvs(values: readonly string[]): ParsedArgs<RotateEnv[]> {
  if (values.length === 0) {
    return {
      ok: false,
      message: "--env is required. Name development, staging, or production.",
    };
  }
  const chosen = new Set<RotateEnv>();
  for (const value of values) {
    for (const piece of value.split(",")) {
      const name = piece.trim();
      const target = parsePushTarget(name);
      if (target === "operator") {
        return {
          ok: false,
          message:
            `${GATEWAY_KEY_NAME} has one value per environment, so it does ` +
            "not go under operator. Name development, staging, or production.",
        };
      }
      if (target === undefined) {
        return {
          ok: false,
          message:
            name === ""
              ? "--env holds an empty name. Separate names with one comma, " +
                "such as --env staging,production."
              : `--env must be development, staging, or production, not ${name}.`,
        };
      }
      chosen.add(target);
    }
  }
  return { ok: true, options: ENV_ORDER.filter((env) => chosen.has(env)) };
}

/** Read the command line. Pure, so each refusal is tested. */
export function parseRotateArgs(
  args: readonly string[],
): ParsedArgs<RotateCommand> {
  let flags: {
    env?: string[];
    "dry-run"?: boolean;
    init?: boolean;
    profile?: string;
    region?: string;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: withoutSeparator(args),
      options: {
        env: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        init: { type: "boolean" },
        profile: { type: "string" },
        region: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    flags = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (flags.init) {
    const hasOthers =
      positionals.length > 0 ||
      flags.env !== undefined ||
      flags["dry-run"] !== undefined ||
      flags.profile !== undefined ||
      flags.region !== undefined;
    if (hasOthers) {
      return {
        ok: false,
        message: "--init runs on its own. Run it with no team slug and no other flag.",
      };
    }
    return { ok: true, options: { mode: "init" } };
  }

  const [slug, ...extra] = positionals;
  if (slug === undefined) {
    return { ok: false, message: "Name the Vercel team slug, such as oxagen." };
  }
  if (extra.length > 0) {
    return {
      ok: false,
      message: `Name one team slug. The command named ${positionals.length}.`,
    };
  }

  const envs = readEnvs(flags.env ?? []);
  if (!envs.ok) return envs;

  if (flags.region === "") {
    return { ok: false, message: "--region needs a region name." };
  }
  if (flags.profile === "") {
    return { ok: false, message: "--profile needs a profile name." };
  }

  return {
    ok: true,
    options: {
      mode: "rotate",
      slug,
      envs: envs.options,
      dryRun: flags["dry-run"] ?? false,
      profile: flags.profile,
      region: flags.region ?? DEFAULT_REGION,
    },
  };
}

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
 * message on any malformed entry so the CLI can surface it verbatim.
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
      `vercel.tokens.json has no token for the team slug "${slug}". ` +
        `It has tokens for: ${known}. Add an entry for "${slug}", or run with ` +
        "--init to seed the file from your Vercel CLI login.",
    );
  }
  return match;
}

// ── Vercel API response mining ───────────────────────────────────────────────

/**
 * Extract the plaintext AI Gateway key from the `POST /v1/api-keys` response.
 * Prefers well-known field names, then falls back to a recursive scan for the
 * `vck_` prefix Vercel uses for gateway keys. No published schema covers the
 * response shape, so the scan stays defensive.
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
 * the slugs the token can reach when it is absent. The usual cause is the
 * other login's token.
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
    `The token for "${slug}" cannot reach a team with that slug. ` +
      `It can reach these teams: ${accessible || "(none)"}. ` +
      "Each Vercel login has its own token, so check that vercel.tokens.json " +
      `holds the token of the login that owns "${slug}".`,
  );
}

/** Mask a secret for log output: first 8 chars + length. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 8)}… (${secret.length} chars)`;
}

// ── Parameter Store ──────────────────────────────────────────────────────────

/** The parameter that holds the gateway key in one environment (ADR-240). */
export function gatewayKeyParameter(env: RotateEnv): string {
  return `${targetPrefix(env)}/${GATEWAY_KEY_NAME}`;
}

/**
 * The name a new key gets in Vercel. It names the environment and the day, so
 * the dashboard shows which key is new and which old key to delete.
 */
export function gatewayKeyName(env: RotateEnv, now: Date): string {
  return `oxagen-${env}-${now.toISOString().slice(0, 10)}`;
}

export interface RotationFailure {
  slug: string;
  /** The environments whose parameter already holds a new key. */
  saved: readonly RotateEnv[];
  /** The environment the run stopped at. */
  failed: RotateEnv;
  /**
   * The Vercel name of a key the run created for `failed` that no parameter
   * holds. Undefined when the run stopped before Vercel created one.
   */
  strandedKey?: string;
  /** `failed` and every environment after it, which a second run needs. */
  rerun: readonly RotateEnv[];
  /** What went wrong. It must hold no key. */
  cause: string;
}

/**
 * The error for a run that stopped partway: where it stopped, why, what it
 * already saved, any key it left in Vercel, and the command that finishes the
 * job. The script never prints a key, so a key Vercel created that reached no
 * parameter cannot be recovered. The message says to delete it.
 */
export function rotationFailureMessage(failure: RotationFailure): string {
  const lines = [`The rotation stopped at ${failure.failed}.`, failure.cause];
  lines.push(
    failure.saved.length > 0
      ? `These environments already hold a new key: ${failure.saved.join(", ")}.`
      : "No environment got a new key.",
  );
  if (failure.strandedKey !== undefined) {
    lines.push(
      `Vercel holds a new key named ${failure.strandedKey} that no parameter ` +
        "holds. Delete it in the Vercel dashboard, under AI Gateway, API keys.",
    );
  }
  lines.push(
    "Fix the cause, then run " +
      `\`pnpm vercel:rotate-ai-key ${failure.slug} --env ${failure.rerun.join(",")}\`.`,
  );
  return lines.join("\n");
}
