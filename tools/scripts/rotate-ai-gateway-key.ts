#!/usr/bin/env tsx
/**
 * rotate-ai-gateway-key.ts: create new Vercel AI Gateway keys and save them in
 * SSM Parameter Store (ADR-240).
 *
 * Usage:
 *   pnpm vercel:rotate-ai-key <team-slug> --env <environments> [--dry-run]
 *                             [--profile <name>] [--region <region>]
 *   pnpm vercel:rotate-ai-key --init
 *
 * `<environments>` names development, staging, or production. Repeat `--env`,
 * or separate names with commas: `--env staging,production`. `preview` is read
 * as staging, as `pnpm env:push` reads it.
 *
 * What it does, in order:
 *   1. Reads `vercel.tokens.json` (repo root, gitignored) and picks the token
 *      for the team slug you pass, such as `oxagen`.
 *   2. Resolves the team id for that slug.
 *   3. For each environment, in the order development, staging, production,
 *      creates a new AI Gateway key with `POST /v1/api-keys` and saves it as
 *      the SecureString parameter `AI_GATEWAY_API_KEY` under that
 *      environment's prefix, such as `/oxagen/production`. Each environment
 *      gets its own key, so a laptop never holds the production key, and one
 *      key can be deleted without breaking the others.
 *   4. Says where each key goes next. Development reaches each laptop at its
 *      next `pnpm env:pull`. Staging and production reach api, app, and mcp
 *      the next time each one starts, because the node reads Parameter Store
 *      when it starts a container.
 *
 * The old key keeps working until you delete it in the Vercel dashboard, under
 * AI Gateway, API keys. Delete it once everything that used it runs on the new
 * key.
 *
 * Before ADR-240 this script also wrote the key into local env files and into
 * the `oxagen-v2-*` Vercel projects. It does neither now: `pnpm env:pull`
 * rewrites each `.env.local` from Parameter Store, and nothing deploys to
 * Vercel.
 *
 * `--dry-run` resolves the team and prints each parameter it would write. It
 * creates no key and writes nothing.
 *
 * `--init` seeds `vercel.tokens.json` from your Vercel CLI login.
 *
 * The script never prints a key. The AWS CLI finds its own credentials
 * (`--profile`, `AWS_PROFILE`, an SSO session, or an access key), and this
 * script reads no environment variable.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { afterSaveLines } from "./env-push";
import { formatError } from "./lib/format-error";
import { putParameter } from "./lib/parameter-store";
import {
  extractGatewayKey,
  GATEWAY_KEY_NAME,
  gatewayKeyName,
  gatewayKeyParameter,
  maskSecret,
  parseRotateArgs,
  parseTokensFile,
  resolveTeam,
  ROTATE_USAGE,
  rotationFailureMessage,
  tokenForSlug,
  type RotateEnv,
  type VercelTeam,
  type VercelTokenEntry,
} from "./lib/rotate-ai-gateway-key";

const REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const TOKENS_FILE = join(REPO_ROOT, "vercel.tokens.json");
const API = "https://api.vercel.com";

// ── Vercel REST helper ───────────────────────────────────────────────────────

async function vercel(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : res.statusText;
    throw new Error(
      `Vercel answered ${method} ${path} with ${res.status}: ${message}`,
    );
  }
  return payload;
}

// ── steps ────────────────────────────────────────────────────────────────────

function loadTokens(): VercelTokenEntry[] {
  if (!existsSync(TOKENS_FILE)) {
    throw new Error(
      `${TOKENS_FILE} does not exist. Run this with --init to create it from ` +
        "your Vercel CLI login, or write it yourself. Git ignores it. Its " +
        'shape is { "tokens": [{ "slug": "oxagen", "token": "..." }] }.',
    );
  }
  return parseTokensFile(readFileSync(TOKENS_FILE, "utf8"));
}

/** Seed vercel.tokens.json from the local Vercel CLI auth token. */
async function initTokensFile(): Promise<void> {
  const authPath = join(
    homedir(),
    "Library/Application Support/com.vercel.cli/auth.json",
  );
  if (!existsSync(authPath)) {
    throw new Error(
      `No Vercel CLI login at ${authPath}. Run \`vercel login\`, then run this again.`,
    );
  }
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
    token?: unknown;
  };
  if (typeof auth.token !== "string" || auth.token.length === 0) {
    throw new Error(
      `${authPath} holds no "token". Run \`vercel login\`, then run this again.`,
    );
  }
  const teamsRes = (await vercel(auth.token, "GET", "/v2/teams?limit=100")) as {
    teams?: Array<{ slug?: unknown }>;
  };
  const slugs = (teamsRes.teams ?? [])
    .map((t) => t.slug)
    .filter((s): s is string => typeof s === "string");
  const existing = existsSync(TOKENS_FILE)
    ? parseTokensFile(readFileSync(TOKENS_FILE, "utf8"))
    : [];
  const merged = [...existing];
  for (const slug of slugs) {
    const prior = merged.find((e) => e.slug === slug);
    if (prior) prior.token = auth.token;
    else merged.push({ slug, token: auth.token });
  }
  writeFileSync(
    TOKENS_FILE,
    `${JSON.stringify({ tokens: merged }, null, 2)}\n`,
  );
  console.log(
    kleur.green(
      `Saved the CLI token in ${TOKENS_FILE} for these teams: ${slugs.join(", ") || "(none)"}.`,
    ),
  );
  console.log(
    kleur.dim(
      "Each Vercel login has its own token. To add another login's token, " +
        'append { "slug": "<team>", "token": "<token>" } to the tokens array.',
    ),
  );
}

/** Lines that say when a saved key reaches the services that read it. */
function reachLines(env: RotateEnv): string[] {
  const lines = afterSaveLines(GATEWAY_KEY_NAME, env);
  if (env !== "development") {
    lines.push(
      "The node reads Parameter Store each time it starts a container, so no build is needed.",
    );
  }
  return lines;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseRotateArgs(argv.slice(2));
  if (!parsed.ok) {
    console.error(kleur.red(`[rotate-ai-key] ${parsed.message}`));
    console.error(ROTATE_USAGE);
    exit(2);
  }
  const command = parsed.options;
  if (command.mode === "init") {
    await initTokensFile();
    return;
  }
  const { slug, envs, dryRun, profile, region } = command;

  const entry = tokenForSlug(loadTokens(), slug);
  console.log(`Resolving the Vercel team ${slug}.`);
  const team: VercelTeam = resolveTeam(
    await vercel(entry.token, "GET", "/v2/teams?limit=100"),
    slug,
  );
  console.log(kleur.dim(`Team id ${team.id}.`));

  const now = new Date();
  if (dryRun) {
    for (const env of envs) {
      console.log(
        `Would create a key named ${gatewayKeyName(env, now)} and save it in ` +
          `${gatewayKeyParameter(env)}.`,
      );
    }
    console.log(
      kleur.green("Dry run complete. No key was created, and nothing was written."),
    );
    return;
  }

  const saved: RotateEnv[] = [];
  for (const [index, env] of envs.entries()) {
    const keyName = gatewayKeyName(env, now);
    const parameter = gatewayKeyParameter(env);
    let created = false;
    try {
      console.log(`Creating a key named ${keyName}.`);
      const response = await vercel(
        entry.token,
        "POST",
        `/v1/api-keys?teamId=${team.id}`,
        { purpose: "ai-gateway", name: keyName },
      );
      created = true;
      const key = extractGatewayKey(response);
      if (!key) {
        throw new Error(
          "Vercel created the key, but its response holds no key that starts with vck_.",
        );
      }
      const { Type } = await putParameter({
        name: parameter,
        value: key,
        secure: true,
        profile,
        region,
      });
      console.log(
        kleur.green(`Saved the new key ${maskSecret(key)} in ${parameter} (${Type}).`),
      );
      for (const line of reachLines(env)) console.log(`  ${line}`);
      saved.push(env);
    } catch (error) {
      throw new Error(
        rotationFailureMessage({
          slug,
          saved,
          failed: env,
          strandedKey: created ? keyName : undefined,
          rerun: envs.slice(index),
          cause: formatError(error),
        }),
      );
    }
  }

  console.log(kleur.green(`\nDone. A new key is saved in ${saved.join(", ")}.`));
  const closing = [
    "The old keys keep working until you delete them. Open the Vercel " +
      "dashboard, go to AI Gateway, API keys, and delete each old key once " +
      "nothing uses it.",
  ];
  if (saved.some((env) => env !== "development")) {
    closing.push(
      "For staging and production, wait until api, app, and mcp have restarted or deployed.",
    );
  }
  if (saved.includes("development")) {
    closing.push(
      "For development, wait until each laptop has run `pnpm env:pull`.",
    );
  }
  closing.push(
    `The new keys are named ${saved.map((env) => gatewayKeyName(env, now)).join(", ")}.`,
  );
  console.log(closing.join("\n"));
}

main().catch((error: unknown) => {
  console.error(kleur.red(`[rotate-ai-key] ${formatError(error)}`));
  exit(1);
});
