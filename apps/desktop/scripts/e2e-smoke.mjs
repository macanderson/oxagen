#!/usr/bin/env node
/**
 * End-to-end smoke test of an installed Oxagen app against a live control
 * plane, driving the bundled sidecars with the exact argv the wizard uses.
 * Run it on a test machine after installing the app; it writes a report of
 * every step it ran and what came back.
 *
 *   node e2e-smoke.mjs                                  read-only checks
 *   node e2e-smoke.mjs --login                          + browser sign-in
 *   node e2e-smoke.mjs --enroll --org acme --workspace core [--harness claude-code,codex,cursor]
 *                                                       + register, record a first run
 *   node e2e-smoke.mjs --cleanup                        + unenroll --purge at the end
 *
 * Steps, in wizard order:
 *   0. find the app's sidecars (`/Applications/Oxagen.app/Contents/MacOS` by
 *      default, `--bin <dir>` elsewhere) and print their versions;
 *   1. session: `~/.config/oxagen/config.json` present, and the token answers
 *      GET /v1/auth/whoami (a 401 is the "session expired" state); with
 *      --login, `oxagen login --browser` first;
 *   2. org + workspace: POST /v1/user/organizations and /v1/user/workspaces,
 *      the same user-scoped calls the pickers make;
 *   3. `tacho detect --json`; with --enroll, `tacho enroll --org … --workspace
 *      … --harness …` (default: every detected harness);
 *   4. `tacho status --json`: enrollment, service, hooks per harness;
 *   5. with --enroll, `tacho verify --harness <h> --json` per registered
 *      harness — one headless turn, confirmed sealed — and the workspace's
 *      URL in the app.
 *
 * Exit 0 when every step that ran passed. Nothing here needs the repo: copy
 * the file to the test machine and run it with any Node >= 18.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const exe = (name) => (platform() === "win32" ? `${name}.exe` : name);
const defaultBin =
  platform() === "darwin"
    ? "/Applications/Oxagen.app/Contents/MacOS"
    : platform() === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "Oxagen")
      : "/usr/bin";
const bin = flag("--bin") ?? defaultBin;
const report = [];
let failed = 0;

function record(step, ok, detail) {
  report.push({ step, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${step}${detail ? ` — ${detail}` : ""}`);
}

function run(name, args, { inherit = false } = {}) {
  const started = Date.now();
  const result = spawnSync(join(bin, exe(name)), args, {
    encoding: "utf8",
    // The app spawns sidecars with a piped stdin that stays open; closing it
    // here is the stricter case, and the one a hang would show up in.
    stdio: inherit
      ? ["ignore", "inherit", "inherit"]
      : ["ignore", "pipe", "pipe"],
    timeout: inherit ? 600_000 : 120_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "") + (result.error ? String(result.error) : ""),
    ms: Date.now() - started,
  };
}

function lastJson(text) {
  const line = text
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (line === undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(line);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function config() {
  const path = join(homedir(), ".config", "oxagen", "config.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function api(method, path, token, apiUrl, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "oxagen-e2e-smoke",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

// 0. Sidecars.
for (const name of ["tacho", "oxagen"]) {
  const path = join(bin, exe(name));
  if (!existsSync(path)) {
    record(`sidecar ${name}`, false, `missing at ${path} (pass --bin <dir>)`);
    continue;
  }
  const v = run(name, ["--version"]);
  record(
    `sidecar ${name}`,
    v.code === 0,
    v.code === 0 ? `${v.stdout.trim()} in ${v.ms} ms` : v.stderr.trim(),
  );
}
if (failed > 0) finish();

// 1. Session.
if (has("--login") || has("--signup")) {
  console.log("… opening the browser; finish signing in there");
  const login = run(
    "oxagen",
    ["login", "--browser", ...(has("--signup") ? ["--signup"] : [])],
    { inherit: true },
  );
  record("oxagen login --browser", login.code === 0, `exit ${login.code}`);
}
const cfg = config();
const apiUrl = (
  process.env.OXAGEN_API_URL ??
  cfg?.apiUrl ??
  "https://api.oxagen.sh"
).replace(/\/+$/, "");
const appUrl = (cfg?.appUrl ?? "https://app.oxagen.sh").replace(/\/+$/, "");
if (!cfg?.token) {
  record(
    "session",
    false,
    "no token in ~/.config/oxagen/config.json — rerun with --login",
  );
  finish();
}
const whoami = await api("GET", "/v1/auth/whoami", cfg.token, apiUrl).catch(
  (e) => ({ status: 0, text: String(e) }),
);
record(
  "session (GET /v1/auth/whoami)",
  whoami.status === 200,
  whoami.status === 401
    ? "401: session expired — rerun with --login"
    : whoami.status === 200
      ? `signed in to ${cfg.orgSlug ?? "?"} via ${apiUrl}`
      : `${whoami.status}: ${whoami.text?.slice(0, 200)}`,
);
if (whoami.status !== 200) finish();

// 2. Org + workspace pickers.
const orgs = await api("POST", "/v1/user/organizations", cfg.token, apiUrl, {});
const orgList = orgs.json?.organizations ?? [];
record(
  "orgs (POST /v1/user/organizations)",
  orgs.status === 200 && orgList.length > 0,
  orgs.status === 200
    ? orgList.map((o) => o.slug).join(", ") || "none"
    : `${orgs.status}: ${orgs.text.slice(0, 200)}`,
);
const org = flag("--org") ?? cfg.orgSlug ?? orgList[0]?.slug;
let workspace = flag("--workspace") ?? cfg.workspaceSlug;
if (org) {
  const ws = await api("POST", "/v1/user/workspaces", cfg.token, apiUrl, {
    orgSlug: org,
  });
  const wsList = ws.json?.workspaces ?? [];
  workspace ??= wsList[0]?.slug;
  record(
    `workspaces of ${org} (POST /v1/user/workspaces)`,
    ws.status === 200 && wsList.some((w) => w.slug === workspace),
    ws.status === 200
      ? `${wsList.map((w) => w.slug).join(", ") || "none"}; using ${workspace ?? "none"}`
      : `${ws.status}: ${ws.text.slice(0, 200)}`,
  );
}

// 3. Detect, then register.
const detectRun = run("tacho", ["detect", "--json"]);
const detected = lastJson(detectRun.stdout);
const installed = (detected?.harnesses ?? []).filter((h) => h.installed);
record(
  "tacho detect",
  detectRun.code === 0 && detected !== null && detectRun.ms < 30_000,
  detected
    ? `${installed.map((h) => `${h.label} ${h.version ?? "?"}`).join(", ") || "no agents found"} in ${detectRun.ms} ms`
    : detectRun.stderr.trim().slice(0, 200),
);
const harnesses =
  flag("--harness") ?? installed.map((h) => h.harness).join(",");

if (has("--enroll")) {
  if (!org || !workspace || harnesses === "") {
    record(
      "tacho enroll",
      false,
      "need an org, a workspace and at least one detected agent",
    );
  } else {
    const enroll = run("tacho", [
      "enroll",
      "--org",
      org,
      "--workspace",
      workspace,
      "--harness",
      harnesses,
    ]);
    const lastErr = enroll.stderr.trim().split("\n").filter(Boolean).at(-1);
    record(
      `tacho enroll ${org}/${workspace} --harness ${harnesses}`,
      enroll.code === 0,
      enroll.code === 0
        ? `${enroll.ms} ms`
        : (lastErr ?? `exit ${enroll.code}`),
    );
  }
}

// 4. Status.
const statusRun = run("tacho", ["status", "--json"]);
const status = lastJson(statusRun.stdout);
if (status?.enrolled) {
  const hooks = [
    status.hooks
      ? `claude-code hooks ${status.hooks.complete ? "complete" : `${status.hooks.missing?.length} missing`}`
      : null,
    status.codexHooks
      ? `codex hooks ${status.codexHooks.complete ? "complete" : `${status.codexHooks.missing?.length} missing`}`
      : null,
    status.cursorHooks
      ? `cursor hooks ${status.cursorHooks.complete ? "complete" : `${status.cursorHooks.missing?.length} missing`}`
      : null,
    status.stellaHooks
      ? `stella hooks ${status.stellaHooks.complete ? "complete" : `${status.stellaHooks.missing?.length} missing`}`
      : null,
  ].filter(Boolean);
  record(
    "tacho status",
    Boolean(status.service?.running) &&
      (status.hooks?.complete ?? true) &&
      (status.codexHooks?.complete ?? true) &&
      (status.cursorHooks?.complete ?? true) &&
      (status.stellaHooks?.complete ?? true),
    `${status.host?.agent_key} → ${status.host?.org_slug}/${status.host?.workspace_slug}; service ${status.service?.kind} ${status.service?.running ? "running" : "NOT running"}; ${hooks.join("; ")}`,
  );
} else {
  record(
    "tacho status",
    !has("--enroll"),
    has("--enroll")
      ? "not enrolled after enroll"
      : "not enrolled (read-only run)",
  );
}

// 5. First run per harness + the workspace in the app.
if (has("--enroll") && status?.enrolled) {
  for (const h of status.host?.harnesses ?? []) {
    const verify = run("tacho", ["verify", "--harness", h, "--json"]);
    const result = lastJson(verify.stdout);
    record(
      `tacho verify --harness ${h}`,
      result?.ok === true,
      result
        ? `${result.detail}${result.seq ? ` (${result.seq} events)` : ""} in ${verify.ms} ms`
        : verify.stderr.trim().slice(0, 200),
    );
  }
  // Not /runs: apps/app has no such route under [orgSlug]/[workspaceSlug];
  // the workspace root is what exists and what the desktop app links to.
  console.log(
    `\nWorkspace: ${appUrl}/${status.host.org_slug}/${status.host.workspace_slug}`,
  );
}

// Whether or not status says enrolled: an enroll that failed part way can
// leave hooks on the machine with no host.json, and `unenroll` strips those
// too. Skipping it left the test machine half installed.
if (has("--cleanup")) {
  const un = run("tacho", ["unenroll", "--purge"]);
  record(
    "tacho unenroll --purge",
    un.code === 0,
    un.code === 0
      ? "hooks, service, credentials removed"
      : un.stderr.trim().split("\n").at(-1),
  );
}

finish();

function finish() {
  const out = join(process.cwd(), `oxagen-e2e-smoke-${hostname()}.json`);
  writeFileSync(
    out,
    `${JSON.stringify({ at: new Date().toISOString(), bin, platform: platform(), failed, steps: report }, null, 2)}\n`,
  );
  console.log(
    `\n${failed === 0 ? "PASS" : `FAIL (${failed})`} — report: ${out}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
