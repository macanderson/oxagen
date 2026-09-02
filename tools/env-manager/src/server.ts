import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ENV_NAMES, ENV_REGISTRY, requiredKeysFor } from "@oxagen/config";
import { loadConfig } from "./config";
import { CATALOG } from "./catalog";
import { listEnv, upsertEnv } from "./vercel";
import { resolveSource } from "./sources";
import { SERVICE_NAMES } from "./types";
import type { DeployResult, EnvName, ServiceName } from "./types";
import { openDb, listSecrets, editSecret } from "./secrets-db";
import type { EditableField } from "./secrets-db";
import { listWorkspace } from "./secrets-usage";

const cfg = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const HTML = readFileSync(join(here, "../public/index.html"), "utf8");
const SECRETS_HTML = readFileSync(join(here, "../public/secrets.html"), "utf8");

const app = new Hono();

app.get("/", (c) => c.html(HTML));

// ── Secrets spreadsheet (backed by the local secrets.db GCP mirror) ──────────
app.get("/secrets", (c) => c.html(SECRETS_HTML));

// List every secret row plus the workspace apps/packages for the usage dropdown.
//
// This is the one endpoint that hands plaintext secret values to the browser —
// that is the whole point of the spreadsheet — which is why the server binds to
// 127.0.0.1 only. openDb() creates secrets.db when it is missing, so an empty
// list means "never pulled" and only a genuinely broken file reaches the catch.
app.get("/api/secrets", (c) => {
  try {
    const db = openDb();
    return c.json({
      secrets: listSecrets(db),
      workspace: listWorkspace(REPO_ROOT),
    });
  } catch (e) {
    return c.json(
      {
        error: `could not open secrets.db — run \`pnpm env:secrets:pull\` to rebuild it (${(e as Error).message})`,
      },
      400,
    );
  }
});

// Inline edit one column of one secret; the puller won't clobber it afterward.
const EDITABLE: ReadonlySet<EditableField> = new Set<EditableField>([
  "value",
  "description",
  "vendor_url",
  "usage",
]);
app.patch("/api/secrets/:key", async (c) => {
  const key = c.req.param("key");
  const body = (await c.req.json().catch(() => ({}))) as {
    field?: string;
    value?: string | string[];
  };
  const field = body.field as EditableField | undefined;
  if (!field || !EDITABLE.has(field))
    return c.json(
      { error: "field must be value|description|vendor_url|usage" },
      400,
    );
  if (body.value === undefined)
    return c.json({ error: "value is required" }, 400);
  try {
    const db = openDb();
    const row = editSecret(db, key, field, body.value);
    return c.json({ secret: row });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get("/api/catalog", (c) =>
  c.json({
    catalog: CATALOG,
    services: SERVICE_NAMES,
    envs: ENV_NAMES,
    projects: cfg.projects,
    hasToken: cfg.vercelToken.length > 0,
  }),
);

// Current Vercel state: service -> key -> [targets it's set on].
app.get("/api/state", async (c) => {
  if (!cfg.vercelToken) return c.json({ error: "VERCEL_TOKEN not set" }, 400);
  const state: Record<string, Record<string, string[]>> = {};
  await Promise.all(
    SERVICE_NAMES.map(async (svc) => {
      const s: Record<string, string[]> = {};
      try {
        for (const v of await listEnv(cfg, cfg.projects[svc])) {
          const targets = s[v.key] ?? (s[v.key] = []);
          for (const t of v.target) if (!targets.includes(t)) targets.push(t);
        }
      } catch (e) {
        s.__error = [(e as Error).message.slice(0, 120)];
      }
      state[svc] = s;
    }),
  );
  return c.json({ state });
});

// Resolve every catalog entry's source for `env` and push to each of its
// services' projects. `generate` is resolved once per key so the same secret
// lands on api + app. `manual` entries are skipped here — use POST /api/set.
app.post("/api/deploy", async (c) => {
  if (!cfg.vercelToken) return c.json({ error: "VERCEL_TOKEN not set" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    env?: EnvName;
    keys?: string[];
    services?: ServiceName[];
  };
  const env = body.env;
  if (!env || !ENV_NAMES.includes(env))
    return c.json({ error: "bad or missing env" }, 400);
  const onlyKeys = body.keys?.length ? new Set(body.keys) : null;
  const onlyServices = body.services?.length ? new Set(body.services) : null;

  const results: DeployResult[] = [];
  const generated = new Map<string, string>();

  for (const entry of CATALOG) {
    if (onlyKeys && !onlyKeys.has(entry.key)) continue;
    const src = entry.sources[env];
    if (!src) continue;

    let value: string | undefined;
    let manual = false;
    let error: string | undefined;

    if (src.type === "manual") {
      manual = true;
    } else if (src.type === "generate") {
      if (!generated.has(entry.key)) {
        const r = await resolveSource(src);
        if (r.value) generated.set(entry.key, r.value);
        else error = r.error ?? "generate failed";
      }
      value = generated.get(entry.key);
    } else {
      const r = await resolveSource(src);
      value = r.value;
      error = r.error;
    }

    for (const svc of entry.services) {
      if (onlyServices && !onlyServices.has(svc)) continue;
      if (manual) {
        results.push({
          key: entry.key,
          env,
          service: svc,
          status: "manual",
          detail: "set manually via /api/set or the paste UI",
        });
        continue;
      }
      if (error) {
        results.push({
          key: entry.key,
          env,
          service: svc,
          status: "error",
          detail: error,
        });
        continue;
      }
      if (!value) {
        results.push({
          key: entry.key,
          env,
          service: svc,
          status: "skipped",
          detail: "no value",
        });
        continue;
      }
      try {
        await upsertEnv(
          cfg,
          cfg.projects[svc],
          entry.key,
          value,
          env,
          entry.secret,
        );
        results.push({ key: entry.key, env, service: svc, status: "ok" });
      } catch (e) {
        results.push({
          key: entry.key,
          env,
          service: svc,
          status: "error",
          detail: (e as Error).message.slice(0, 140),
        });
      }
    }
  }
  return c.json({ results });
});

// Paste-and-fan-out: the operator provides a value and it's pushed to every
// project that needs this key for the given environment. The value is never
// returned to the browser or logged.
app.post("/api/set", async (c) => {
  if (!cfg.vercelToken) return c.json({ error: "VERCEL_TOKEN not set" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    key?: string;
    env?: EnvName;
    value?: string;
    services?: ServiceName[];
  };

  const { key, env, value } = body;
  if (!key) return c.json({ error: "key is required" }, 400);
  const meta = ENV_REGISTRY[key];
  if (!meta) return c.json({ error: `unknown key: ${key}` }, 400);
  if (!env || !ENV_NAMES.includes(env))
    return c.json({ error: "bad or missing env" }, 400);
  if (!value || value.trim().length === 0)
    return c.json({ error: "value is required" }, 400);

  const targetServices = body.services?.length
    ? meta.services.filter((s) => (body.services as ServiceName[]).includes(s))
    : meta.services;

  const results: DeployResult[] = [];
  for (const svc of targetServices) {
    try {
      await upsertEnv(cfg, cfg.projects[svc], key, value, env, meta.secret);
      results.push({ key, env, service: svc, status: "ok" });
    } catch (e) {
      results.push({
        key,
        env,
        service: svc,
        status: "error",
        detail: (e as Error).message.slice(0, 140),
      });
    }
  }
  // value is intentionally not included in the response
  return c.json({ results });
});

// Online gap detector: diff required keys (from registry) against live Vercel
// state per service, for a given environment target.
app.get("/api/gaps", async (c) => {
  if (!cfg.vercelToken) return c.json({ error: "VERCEL_TOKEN not set" }, 400);
  const env = c.req.query("env") as EnvName | undefined;
  if (!env || !ENV_NAMES.includes(env))
    return c.json({ error: "bad or missing env query param" }, 400);

  // Fetch live state for all services in parallel.
  const liveState: Record<ServiceName, Set<string>> = {} as Record<
    ServiceName,
    Set<string>
  >;
  const allRegistryKeys = new Set(Object.keys(ENV_REGISTRY));

  await Promise.all(
    SERVICE_NAMES.map(async (svc) => {
      const present = new Set<string>();
      try {
        for (const v of await listEnv(cfg, cfg.projects[svc])) {
          if (v.target.includes(env)) present.add(v.key);
        }
      } catch {
        // Leave the set empty; gap detector will report everything as missing.
      }
      liveState[svc] = present;
    }),
  );

  const missing: { service: ServiceName; key: string }[] = [];
  const extra: { service: ServiceName; key: string }[] = [];

  for (const svc of SERVICE_NAMES) {
    const required = new Set(requiredKeysFor(svc, env));
    const present = liveState[svc];

    for (const key of required) {
      if (!present.has(key)) missing.push({ service: svc, key });
    }
    for (const key of present) {
      if (!allRegistryKeys.has(key)) extra.push({ service: svc, key });
    }
  }

  return c.json({ env, missing, extra });
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
  console.log(
    `\n  env-manager → http://127.0.0.1:${info.port}` +
      `\n  vercel token: ${cfg.vercelToken ? "set" : "MISSING (set VERCEL_TOKEN in .env.local)"}\n`,
  );
});
