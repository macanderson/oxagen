import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { CATALOG } from "./catalog";
import { listEnv, upsertEnv } from "./vercel";
import { resolveSource } from "./sources";
import { ENV_NAMES, SERVICE_NAMES } from "./types";
import type { DeployResult, EnvName, ServiceName } from "./types";

const cfg = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, "../public/index.html"), "utf8");

const app = new Hono();

app.get("/", (c) => c.html(HTML));

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
// services' projects (target = env). `generate` is resolved once per key so the
// same secret lands on api + app.
app.post("/api/deploy", async (c) => {
  if (!cfg.vercelToken) return c.json({ error: "VERCEL_TOKEN not set" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    env?: EnvName;
    keys?: string[];
    services?: ServiceName[];
  };
  const env = body.env;
  if (!env || !ENV_NAMES.includes(env)) return c.json({ error: "bad or missing env" }, 400);
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
        results.push({ key: entry.key, env, service: svc, status: "manual", detail: "set manually (Inngest/LLM dashboard)" });
        continue;
      }
      if (error) {
        results.push({ key: entry.key, env, service: svc, status: "error", detail: error });
        continue;
      }
      if (!value) {
        results.push({ key: entry.key, env, service: svc, status: "skipped", detail: "no value" });
        continue;
      }
      try {
        await upsertEnv(cfg, cfg.projects[svc], entry.key, value, env, entry.secret);
        results.push({ key: entry.key, env, service: svc, status: "ok" });
      } catch (e) {
        results.push({ key: entry.key, env, service: svc, status: "error", detail: (e as Error).message.slice(0, 140) });
      }
    }
  }
  return c.json({ results });
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `\n  env-manager → http://127.0.0.1:${info.port}` +
      `\n  vercel token: ${cfg.vercelToken ? "set" : "MISSING (set VERCEL_TOKEN in .env.local)"}\n`,
  );
});
