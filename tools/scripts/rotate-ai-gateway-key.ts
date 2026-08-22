#!/usr/bin/env tsx
/**
 * rotate-ai-gateway-key.ts — mint a fresh Vercel AI Gateway API key and roll
 * it out everywhere it is consumed.
 *
 * What it does, in order:
 *   1. Reads `vercel.tokens.json` (repo root, gitignored) and picks the token
 *      for the org slug you pass (`manderson` | `oxagen` | any team slug).
 *   2. Resolves the team id for that slug and creates a new AI Gateway key
 *      via `POST /v1/api-keys` (purpose "ai-gateway").
 *   3. Writes `AI_GATEWAY_API_KEY=<new key>` into every local env file:
 *      ~/.env.global.local, the repo root .env.local, and
 *      apps/{app,api,mcp}/.env.local.
 *   4. Upserts the key into every `oxagen-v2-*` Vercel project in that team,
 *      across all environments (production, preview, development).
 *   5. Redeploys each project's most recent successful production deployment
 *      so the new key takes effect.
 *
 * Usage:
 *   pnpm vercel:rotate-ai-key -- <org-slug> [--dry-run] [--skip-redeploy]
 *   pnpm vercel:rotate-ai-key -- --init      # seed vercel.tokens.json from
 *                                            # the local Vercel CLI login
 *
 * `--dry-run` performs reads only: it resolves the team and lists the files
 * and projects it would touch, but mints no key, writes no file, and triggers
 * no deploy.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import {
  extractGatewayKey,
  maskSecret,
  parseTokensFile,
  resolveTeam,
  tokenForSlug,
  upsertGatewayKey,
  type VercelTeam,
  type VercelTokenEntry,
} from "./lib/rotate-ai-gateway-key";

const REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const TOKENS_FILE = join(REPO_ROOT, "vercel.tokens.json");
const API = "https://api.vercel.com";
const PROJECT_PREFIX = "oxagen-v2-";
const ENV_TARGETS = ["production", "preview", "development"] as const;

// Local env files that must always carry the key (created when missing).
const EXPLICIT_ENV_FILES = [
  join(homedir(), ".env.global.local"),
  join(REPO_ROOT, ".env.local"),
  join(REPO_ROOT, "apps/app/.env.local"),
  join(REPO_ROOT, "apps/api/.env.local"),
  join(REPO_ROOT, "apps/mcp/.env.local"),
];

// ── Vercel REST helpers ──────────────────────────────────────────────────────

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
    throw new Error(`${method} ${path} → ${res.status}: ${message}`);
  }
  return payload;
}

interface VercelProject {
  id: string;
  name: string;
}

async function listV2Projects(
  token: string,
  teamId: string,
): Promise<VercelProject[]> {
  const projects: VercelProject[] = [];
  let until: number | null = null;
  // Paginate defensively; teams here hold well under 100 projects.
  for (let page = 0; page < 10; page++) {
    const qs = `teamId=${teamId}&limit=100${until !== null ? `&until=${until}` : ""}`;
    const res = (await vercel(token, "GET", `/v10/projects?${qs}`)) as {
      projects?: Array<{ id?: unknown; name?: unknown }>;
      pagination?: { next?: unknown };
    };
    for (const p of res.projects ?? []) {
      if (
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        p.name.startsWith(PROJECT_PREFIX)
      ) {
        projects.push({ id: p.id, name: p.name });
      }
    }
    const next = res.pagination?.next;
    if (typeof next !== "number") break;
    until = next;
  }
  return projects;
}

// ── steps ────────────────────────────────────────────────────────────────────

function loadTokens(): VercelTokenEntry[] {
  if (!existsSync(TOKENS_FILE)) {
    throw new Error(
      `${TOKENS_FILE} not found. Create it (it is gitignored) or run with --init to seed it ` +
        'from your Vercel CLI login. Shape: { "tokens": [{ "slug": "oxagen", "token": "..." }] }',
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
      `Vercel CLI auth not found at ${authPath} — run \`vercel login\` first`,
    );
  }
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
    token?: unknown;
  };
  if (typeof auth.token !== "string" || auth.token.length === 0) {
    throw new Error(`no "token" in ${authPath}`);
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
    `${kleur.green("✓")} seeded ${TOKENS_FILE} with the CLI token for team(s): ${slugs.join(", ") || "(none)"}`,
  );
  console.log(
    kleur.dim(
      "  Add the other login's token manually (each Vercel login has its own token): " +
        'append { "slug": "<team>", "token": "<token>" } to the tokens array.',
    ),
  );
}

function updateLocalEnvFiles(key: string, dryRun: boolean): void {
  for (const file of EXPLICIT_ENV_FILES) {
    const exists = existsSync(file);
    if (dryRun) {
      console.log(
        `  ${kleur.dim("dry-run")} would ${exists ? "update" : "create"} ${file}`,
      );
      continue;
    }
    const current = exists ? readFileSync(file, "utf8") : "";
    const { content, action } = upsertGatewayKey(current, key);
    writeFileSync(file, content);
    console.log(
      `  ${kleur.green("✓")} ${action} AI_GATEWAY_API_KEY in ${file}`,
    );
  }
}

async function upsertProjectEnv(
  token: string,
  teamId: string,
  project: VercelProject,
  key: string,
): Promise<void> {
  await vercel(
    token,
    "POST",
    `/v10/projects/${project.id}/env?teamId=${teamId}&upsert=true`,
    {
      key: "AI_GATEWAY_API_KEY",
      value: key,
      type: "encrypted",
      target: [...ENV_TARGETS],
    },
  );
  console.log(
    `  ${kleur.green("✓")} ${project.name}: env upserted for ${ENV_TARGETS.join(", ")}`,
  );
}

async function redeployProduction(
  token: string,
  teamId: string,
  project: VercelProject,
): Promise<void> {
  const res = (await vercel(
    token,
    "GET",
    `/v6/deployments?teamId=${teamId}&projectId=${project.id}&target=production&state=READY&limit=1`,
  )) as { deployments?: Array<{ uid?: unknown; url?: unknown }> };
  const last = res.deployments?.[0];
  if (!last || typeof last.uid !== "string") {
    console.log(
      `  ${kleur.yellow("∅")} ${project.name}: no successful production deployment to redeploy`,
    );
    return;
  }
  const redeploy = (await vercel(
    token,
    "POST",
    `/v13/deployments?teamId=${teamId}&forceNew=1`,
    {
      name: project.name,
      deploymentId: last.uid,
      target: "production",
      meta: { action: "redeploy" },
    },
  )) as { url?: unknown; id?: unknown };
  const url = typeof redeploy.url === "string" ? redeploy.url : "(queued)";
  console.log(
    `  ${kleur.green("✓")} ${project.name}: production redeploy started → ${url}`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = argv.slice(2);
  if (args.includes("--init")) {
    await initTokensFile();
    return;
  }
  const dryRun = args.includes("--dry-run");
  const skipRedeploy = args.includes("--skip-redeploy");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) {
    console.error(
      "usage: pnpm vercel:rotate-ai-key -- <org-slug> [--dry-run] [--skip-redeploy]\n" +
        "       pnpm vercel:rotate-ai-key -- --init",
    );
    exit(1);
    return;
  }

  const entry = tokenForSlug(loadTokens(), slug);
  console.log(`${kleur.cyan("→")} resolving Vercel team "${slug}"…`);
  const teamsRes = await vercel(entry.token, "GET", "/v2/teams?limit=100");
  const team: VercelTeam = resolveTeam(teamsRes, slug);
  console.log(`  team id ${team.id}`);

  let key: string;
  if (dryRun) {
    key = "vck_dry_run_placeholder";
    console.log(`${kleur.cyan("→")} dry-run: skipping key creation`);
  } else {
    console.log(`${kleur.cyan("→")} creating AI Gateway API key…`);
    const created = await vercel(
      entry.token,
      "POST",
      `/v1/api-keys?teamId=${team.id}`,
      {
        purpose: "ai-gateway",
        name: `oxagen-rotated-${new Date().toISOString().slice(0, 10)}`,
      },
    );
    const extracted = extractGatewayKey(created);
    if (!extracted) {
      throw new Error(
        "key created but plaintext not found in the response — inspect it in the Vercel dashboard " +
          "(AI Gateway → API keys) and rotate manually",
      );
    }
    key = extracted;
    console.log(`  ${kleur.green("✓")} created ${maskSecret(key)}`);
  }

  console.log(`${kleur.cyan("→")} updating local env files…`);
  updateLocalEnvFiles(key, dryRun);

  console.log(
    `${kleur.cyan("→")} updating Vercel ${PROJECT_PREFIX}* projects…`,
  );
  const projects = await listV2Projects(entry.token, team.id);
  if (projects.length === 0) {
    console.log(
      `  ${kleur.yellow("∅")} no ${PROJECT_PREFIX}* projects in team "${slug}"`,
    );
  }
  for (const project of projects) {
    if (dryRun) {
      console.log(
        `  ${kleur.dim("dry-run")} would upsert env + redeploy ${project.name}`,
      );
      continue;
    }
    await upsertProjectEnv(entry.token, team.id, project, key);
  }

  if (!dryRun && !skipRedeploy) {
    console.log(
      `${kleur.cyan("→")} redeploying last successful production deployments…`,
    );
    for (const project of projects) {
      await redeployProduction(entry.token, team.id, project);
    }
  }

  if (dryRun) {
    console.log(
      kleur.green(
        "\nDry-run complete — nothing was created, written, or deployed.",
      ),
    );
  } else {
    console.log(
      kleur.green("\nDone. New key is live locally and rolling out on Vercel."),
    );
    console.log(
      kleur.dim(
        "Old gateway keys remain valid — revoke them in the dashboard once traffic drains.",
      ),
    );
  }
}

main().catch((err: unknown) => {
  console.error(
    kleur.red(
      `rotate-ai-gateway-key failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
  exit(1);
});
