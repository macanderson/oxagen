#!/usr/bin/env node
/**
 * Drive the built desktop app through tauri-driver and run the panel actions
 * that need no Oxagen session: the scan in setup step 3 (`tacho detect`),
 * Sign out (`oxagen logout`), the start of Sign in (`oxagen login
 * --browser`), and the machine read the poll makes (`tacho status`). Each one
 * reaches its sidecar through `run_sidecar` and the allowlist in
 * `src-tauri/src/sidecar.rs`, which #4318 item 6 asks to see working in a
 * built app. The run also checks that the page cannot start a command off
 * that list, or spawn a process through the shell plugin.
 *
 * Linux only: tauri-driver drives WebKitWebDriver there. The app runs in a
 * scratch HOME with a stand-in control plane on 127.0.0.1 that answers the
 * two picker routes, so no step reaches Oxagen. Sign in, register, reassign
 * and Re-apply need a real session and are not here.
 *
 *   xvfb-run -a node scripts/e2e-webdriver.mjs [--app <binary>]
 *
 * Needs `tauri-driver` and `WebKitWebDriver` on PATH, and a build made with
 * `pnpm sidecars` and then `tauri build --debug --no-bundle`. E2E_EVIDENCE
 * names the directory for the record of the run: each step, the window's
 * text and markup at each one, the driver's log, and the stand-in's requests.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const argv = process.argv.slice(2);
const appFlag = argv.indexOf("--app");
const application =
  appFlag >= 0 && argv[appFlag + 1] !== undefined
    ? resolve(argv[appFlag + 1])
    : join(appDir, "src-tauri", "target", "debug", "oxagen-desktop");
if (!existsSync(application)) {
  console.error(`e2e-webdriver: no app at ${application}; build it first`);
  process.exit(2);
}
const evidence =
  process.env.E2E_EVIDENCE ??
  mkdtempSync(join(tmpdir(), "oxagen-e2e-evidence-"));
mkdirSync(evidence, { recursive: true });

const DRIVER = "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/** Every step, written out after each one so a failed run keeps its record. */
const steps = [];
function record(step, detail = {}) {
  const entry = { at: new Date().toISOString(), step, ...detail };
  steps.push(entry);
  console.log(`${entry.at} ${step} ${JSON.stringify(detail)}`);
  writeFileSync(
    join(evidence, "steps.json"),
    `${JSON.stringify(steps, null, 2)}\n`,
  );
}

// ── The stand-in control plane ─────────────────────────────────────────────
const ORG = { id: "org_e2e", slug: "e2e-org", name: "E2E organization" };
const WORKSPACE = { slug: "e2e-ws", name: "E2E workspace" };
const requests = [];
const api = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && req.url === "/v1/user/organizations")
      return send(200, { organizations: [ORG] });
    if (req.method === "POST" && req.url === "/v1/user/workspaces")
      return send(200, { workspaces: [WORKSPACE] });
    send(404, { error: "not_found" });
  });
});
await new Promise((ready) => api.listen(0, "127.0.0.1", ready));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

// ── The scratch home: signed in to the stand-in, nothing enrolled ──────────
const home = mkdtempSync(join(tmpdir(), "oxagen-e2e-home-"));
const configPath = join(home, ".config", "oxagen", "config.json");
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      token: "e2e-session-token",
      apiUrl,
      appUrl: apiUrl,
      orgSlug: ORG.slug,
      workspaceSlug: WORKSPACE.slug,
    },
    null,
    2,
  )}\n`,
);
record("seeded", { home, apiUrl, application });

// ── tauri-driver, with the app's whole environment pointed at the scratch
// home ──────────────────────────────────────────────────────────────────────
const driverLog = openSync(join(evidence, "tauri-driver.log"), "w");
const env = { ...process.env };
for (const name of Object.keys(env))
  if (name.startsWith("OXAGEN_") || name.startsWith("TACHO_")) delete env[name];
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  // WebKitGTK under Xvfb draws a blank page without these.
  WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  WEBKIT_DISABLE_COMPOSITING_MODE: "1",
});
const driver = spawn("tauri-driver", [], {
  env,
  stdio: ["ignore", driverLog, driverLog],
});

let sessionId;
let failed = false;
try {
  await until("tauri-driver answers", async () => {
    try {
      return (await fetch(`${DRIVER}/status`)).ok;
    } catch {
      return false;
    }
  });
  await run();
} catch (error) {
  failed = true;
  record("failed", { error: error instanceof Error ? error.message : error });
  await capture("failure").catch(() => undefined);
} finally {
  if (sessionId !== undefined)
    await wd("DELETE", `/session/${sessionId}`).catch(() => undefined);
  driver.kill();
  // `oxagen login --browser` waits five minutes for a browser that never
  // answers. It started from the app and outlives it.
  spawnSync("pkill", ["-f", "login --browser"]);
  api.close();
  writeFileSync(
    join(evidence, "control-plane-requests.json"),
    `${JSON.stringify(requests, null, 2)}\n`,
  );
}
process.exit(failed ? 1 : 0);

// ── The run ──────────────────────────────────────────────────────────────────
async function run() {
  // `pageLoadStrategy: "none"`: with the default, WebKitWebDriver held
  // every command until its page-load timeout, five minutes, although the
  // page had loaded and was calling the stand-in. Each step below waits for
  // what it needs instead.
  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        pageLoadStrategy: "none",
        timeouts: { script: 30_000, pageLoad: 30_000, implicit: 0 },
        "tauri:options": { application },
      },
    },
  });
  sessionId = created.sessionId;
  record("app started", { sessionId });

  // Step 2 with the stand-in's organization and workspace, listed through
  // the app's own `api_post`.
  await until("step 2 lists the organization and workspace", async () => {
    const text = await pageText();
    return (
      text.includes("Select an organization and workspace") &&
      (await buttonEnabled("Continue"))
    );
  });
  await capture("step-2");
  record("step 2 ready");

  await ipcChecks();

  // `tacho detect --json`: the scan that opens step 3.
  await click("Continue");
  await until(
    "step 3 lists the scan's agents",
    async () =>
      (await script(
        "return document.querySelectorAll('input[id^=\"register-\"]').length",
      )) >= 4,
  );
  const rows = await script(
    "return [...document.querySelectorAll('.agent')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim())",
  );
  const text = await pageText();
  if (text.includes("Could not scan for agents"))
    throw new Error("the scan failed");
  record("tacho detect ran", { rows });
  await capture("step-3-scan");

  // `oxagen logout`: Sign out, from step 2.
  await click("change");
  await until("step 2 again", () => buttonEnabled("Sign out"));
  await click("Sign out");
  await until("the logout's output", async () =>
    (await activityText()).includes("Logged out."),
  );
  await until("step 1", () => buttonEnabled("Sign in"));
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  if (config.token !== undefined)
    throw new Error("config.json still holds the session token");
  record("oxagen logout ran", { activity: await activityText() });
  await capture("signed-out");

  // `oxagen login --browser`: the start of Sign in. It prints the URL and
  // waits for a browser, which never comes here.
  await click("Sign in");
  await until("the login's output", async () =>
    (await activityText()).includes("Opening browser for authentication"),
  );
  const waiting = await hasButton("Waiting for the browser…");
  if (!waiting) throw new Error("Sign in did not wait for the browser");
  record("oxagen login --browser started", {
    activity: await activityText(),
  });
  await capture("signing-in");
  const banner = await pageText();
  if (banner.includes("Oxagen does not run"))
    throw new Error("the allowlist refused a panel action");
}

/**
 * The same IPC the page's bridge uses: `tacho status` runs and reports, a
 * command off the allowlist is refused, and the shell plugin spawns nothing.
 */
async function ipcChecks() {
  const status = await invokeSidecar("tacho", ["status", "--json"]);
  if (!status.ok) throw new Error(`tacho status: ${status.error}`);
  // Not enrolled here, so it prints `{"enrolled": false}` and exits 1. The
  // page's `tachoStatus` reads the document whatever the exit code.
  const report = JSON.parse(status.stdout.join("\n"));
  if (report.enrolled !== false)
    throw new Error(`tacho status answered ${JSON.stringify(status)}`);
  record("tacho status ran", { code: status.code, report });

  const refused = await invokeSidecar("tacho", ["daemon"]);
  if (
    refused.ok ||
    !refused.error.includes("Oxagen does not run `tacho daemon`")
  )
    throw new Error(`tacho daemon was not refused: ${JSON.stringify(refused)}`);
  record("tacho daemon refused", { error: refused.error });

  const spawned = await asyncScript(`
    const done = arguments[arguments.length - 1];
    const internals = window.__TAURI_INTERNALS__;
    const id = internals.transformCallback(() => undefined);
    internals
      .invoke("plugin:shell|spawn", {
        program: "tacho",
        args: ["daemon"],
        options: { sidecar: true },
        onEvent: "__CHANNEL__:" + id,
      })
      .then((pid) => done({ ok: true, pid }))
      .catch((error) => done({ ok: false, error: String(error) }));
  `);
  if (spawned.ok)
    throw new Error(`the shell plugin spawned pid ${spawned.pid}`);
  record("shell plugin refused", { error: spawned.error });
}

/** `run_sidecar` from the page, collecting its lines until it exits. */
function invokeSidecar(sidecar, args) {
  return asyncScript(
    `
    const [sidecar, args, done] = arguments;
    const internals = window.__TAURI_INTERNALS__;
    const out = { ok: true, stdout: [], stderr: [], code: null };
    const id = internals.transformCallback((raw) => {
      const message = raw && raw.message;
      if (!message) return;
      if (message.event === "stdout") out.stdout.push(message.data);
      if (message.event === "stderr") out.stderr.push(message.data);
      if (message.event === "error") done({ ok: false, error: message.data });
      if (message.event === "terminated") {
        out.code = message.data.code;
        done(out);
      }
    });
    internals
      .invoke("run_sidecar", { sidecar, args, onEvent: "__CHANNEL__:" + id })
      .then((pid) => { out.pid = pid; })
      .catch((error) => done({ ok: false, error: String(error) }));
  `,
    [sidecar, args],
  );
}

// ── WebDriver ───────────────────────────────────────────────────────────────
async function wd(method, path, body) {
  // A command that hangs fails in a minute with its name, not after five
  // with only "fetch failed".
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  }).catch((error) => {
    throw new Error(`${method} ${path}: ${error.message}`);
  });
  const json = await res.json().catch(() => ({}));
  // A driver error is a value with an `error` code. A script's own answer can
  // carry `error` too (`{ ok: false, error }` from `invokeSidecar`), so a
  // value with an `ok` member is the script's result, not a driver error.
  const value = json?.value;
  const driverError =
    value !== null &&
    typeof value === "object" &&
    value.error !== undefined &&
    !("ok" in value);
  if (!res.ok || driverError)
    throw new Error(
      `${method} ${path}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`,
    );
  return json.value;
}

function script(source, args = []) {
  return wd("POST", `/session/${sessionId}/execute/sync`, {
    script: source,
    args,
  });
}

function asyncScript(source, args = []) {
  return wd("POST", `/session/${sessionId}/execute/async`, {
    script: source,
    args,
  });
}

function pageText() {
  return script("return document.body.innerText");
}

function activityText() {
  return script(
    "const panel = document.querySelector('section[aria-labelledby=\"out\"]'); return panel ? panel.innerText : ''",
  );
}

/** A page expression for the button with this label. */
function buttonQuery(label) {
  return `[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
}

function buttonEnabled(label) {
  return script(`const b = ${buttonQuery(label)}; return !!b && !b.disabled`);
}

function hasButton(label) {
  return script(`return !!${buttonQuery(label)}`);
}

/**
 * Click a button by its label, the way a person would. When something sits
 * over it (an update notice, say), WebDriver refuses the click, and the
 * button's own click() runs the same handler.
 */
async function click(label) {
  const found = await wd("POST", `/session/${sessionId}/element`, {
    using: "xpath",
    value: `//button[normalize-space(.)=${JSON.stringify(label)}]`,
  });
  try {
    await wd(
      "POST",
      `/session/${sessionId}/element/${found[ELEMENT]}/click`,
      {},
    );
    record("clicked", { label });
  } catch (error) {
    await script(`${buttonQuery(label)}.click()`);
    record("clicked from the page", { label, refused: error.message });
  }
}

/**
 * What the window shows at this point: its text, and its markup. Not a
 * screenshot: WebKitWebDriver under Xvfb never answered that command, and
 * every command after it queued behind it.
 */
async function capture(name) {
  const text = await pageText();
  const html = await script("return document.documentElement.outerHTML");
  writeFileSync(join(evidence, `${name}.txt`), `${text}\n`);
  writeFileSync(join(evidence, `${name}.html`), `${html}\n`);
}

async function until(what, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  const text = sessionId === undefined ? "" : await pageText().catch(() => "");
  throw new Error(
    `timed out: ${what}${last ? ` (${last.message})` : ""}\n${text.slice(0, 2000)}`,
  );
}
