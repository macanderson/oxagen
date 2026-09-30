// The mockup parity capture (#4818): screenshots every app state the page
// registry names, as each seeded persona, in the dark and light themes and at
// phone width. CI-only audit tooling: .github/workflows/mockup-parity-capture.yml
// runs it against `next start` on the production build that workflow made,
// after seed:e2e and seed:audit. It is not an e2e spec (INV-20 allows exactly
// three), and nothing under src/ imports it (INV-07, INV-22).
//
//   tsx scripts/mockup-parity/capture.ts --registry FILE --out DIR
//     [--base-url URL] [--fault-url URL] [--pages a,b] [--variants dark.phone]
//     [--concurrency N] [--ref REF] [--commit SHA] [--registry-ref REF]
//
// plan.ts decides what to take. This file signs each persona in once through
// the login form, the way e2e/login.spec.ts does, keeps its storage state, and
// opens each planned state in a fresh browser context per variant. It writes
// OUT/<slug>/<state>.<theme>.<viewport>.png, where a `:` in the state id
// becomes `-`, and OUT/manifest.json. The manifest lists every file with the
// final URL and the HTTP status it landed on, so a redirect to /login or a 404
// is visible, and every state it skipped or failed, with the reason.
//
// One state never fails the run. It exits 0 once the manifest is written, 2
// when an argument, the registry, or a seed record is missing, and 1 when the
// server never answered.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Response as PageResponse,
} from "@playwright/test";
import type { z } from "zod";
import { SEED_RECORD } from "../../e2e/support";
import authCatalog from "../../messages/auth.json" with { type: "json" };
import organizationCatalog from "../../messages/organization.json" with {
  type: "json",
};
import shellCatalog from "../../messages/shell.json" with { type: "json" };
import {
  PERSONA_PASSWORD,
  type PersonaKey,
  PERSONAS_RECORD,
  type PersonasRecord,
  personasRecordSchema,
  seedRecordSchema,
} from "./personas";
import {
  type Capture,
  fileName,
  type OverlayKey,
  type PagePlan,
  pickVariants,
  planPage,
  registrySchema,
  resolvePath,
  type Skip,
  selectPages,
  unresolvedReason,
  type Variant,
  valuesFor,
  variantName,
} from "./plan";

const USAGE =
  "usage: capture.ts --registry FILE --out DIR [--base-url URL] [--fault-url URL] [--pages a,b] [--variants dark.desktop,light.desktop,dark.phone] [--concurrency N] [--ref REF] [--commit SHA] [--registry-ref REF]";

/** How long the server may take to answer /login before the run gives up. */
const SERVER_WAIT_MS = 120_000;

/** How long one navigation may take. The fault server's pages wait on refused stores. */
const NAVIGATION_TIMEOUT_MS = 60_000;

/** How long an overlay's control and dialog may take to appear. */
const OVERLAY_TIMEOUT_MS = 10_000;

/** A pause before each screenshot, so a transition that is still running finishes. */
const SETTLE_MS = 300;

/**
 * The throttle the loading state is taken under: slow enough that the
 * streamed skeleton shows before the page's data arrives.
 */
const LOADING_NETWORK = {
  offline: false,
  latency: 400,
  downloadThroughput: 100 * 1024,
  uploadThroughput: 50 * 1024,
} as const;

class UsageError extends Error {}
class StartError extends Error {}

type Args = {
  readonly registry: string;
  readonly out: string;
  readonly baseUrl: string;
  readonly faultUrl: string | null;
  readonly pages: readonly string[] | null;
  readonly variants: string | null;
  readonly concurrency: number;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly registryRef: string | null;
};

const FLAGS: ReadonlySet<string> = new Set([
  "registry",
  "out",
  "base-url",
  "fault-url",
  "pages",
  "variants",
  "concurrency",
  "ref",
  "commit",
  "registry-ref",
]);

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) {
      throw new UsageError(`expected --flag value pairs, got "${name}"`);
    }
    if (!FLAGS.has(name.slice(2))) {
      throw new UsageError(`unknown flag ${name}`);
    }
    flags.set(name.slice(2), value);
  }
  const text = (name: string): string | null => {
    const value = flags.get(name)?.trim() ?? "";
    return value === "" ? null : value;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === null) throw new UsageError(`--${name} is required`);
    return value;
  };
  const concurrency = Number(text("concurrency") ?? "3");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new UsageError("--concurrency is a whole number from 1 to 8");
  }
  const pages = text("pages");
  const faultUrl = text("fault-url");
  return {
    registry: required("registry"),
    out: required("out"),
    baseUrl: trimSlash(text("base-url") ?? "http://localhost:3000"),
    faultUrl: faultUrl === null ? null : trimSlash(faultUrl),
    pages:
      pages === null
        ? null
        : pages
            .split(",")
            .map((slug) => slug.trim())
            .filter((slug) => slug.length > 0),
    variants: text("variants"),
    concurrency,
    ref: text("ref"),
    commit: text("commit"),
    registryRef: text("registry-ref"),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** An error's first line, for a manifest reason or a log line. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n", 1)[0] ?? "";
}

/** A JSON file, checked against its shape; a failure stops the run before it starts. */
function readJson<S extends z.ZodType>(
  file: string,
  schema: S,
  what: string,
): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new StartError(
      `${what} at ${file} is unreadable: ${firstLine(error)}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StartError(
      `${what} at ${file} does not have the expected shape: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Whether the server answers /login with anything below 500 before the deadline. */
async function waitForServer(base: string): Promise<boolean> {
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/login`, { redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      // Not listening yet: wait and ask again.
    }
    await delay(2_000);
  }
  return false;
}

// ── Sessions ──────────────────────────────────────────────────────────────

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type Session =
  | { readonly ok: true; readonly state: StorageState }
  | { readonly ok: false; readonly reason: string };

/**
 * Sign in through the login form, as e2e/login.spec.ts does, and keep the
 * storage state. Session cookies on `localhost` are sent to every port, so the
 * same state serves the fault server too.
 */
async function signIn(
  browser: Browser,
  base: string,
  email: string,
): Promise<Session> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/login`, { timeout: NAVIGATION_TIMEOUT_MS });
    const copy = authCatalog.auth.login;
    const form = page.getByRole("form", { name: copy.title });
    await form.locator("#login-email").fill(email);
    await form.locator("#login-password").fill(PERSONA_PASSWORD);
    await form.getByRole("button", { name: copy.submit }).click();
    await page.waitForURL((url) => url.pathname !== "/login", {
      timeout: 30_000,
    });
    return { ok: true, state: await context.storageState() };
  } catch (error) {
    return {
      ok: false,
      reason: `Signing in as ${email} failed: ${firstLine(error)}`,
    };
  } finally {
    await context.close();
  }
}

/** One session per persona the plans sign in as; anonymous needs none. */
async function signInAll(
  browser: Browser,
  base: string,
  plans: readonly PagePlan[],
  record: PersonasRecord,
): Promise<Map<PersonaKey, Session>> {
  const keys = new Set<PersonaKey>();
  for (const plan of plans) {
    for (const capture of plan.captures) {
      if (capture.persona !== "anonymous") keys.add(capture.persona);
    }
  }
  const sessions = new Map<PersonaKey, Session>();
  for (const key of keys) {
    const account = record.personas[key];
    const session: Session =
      account === undefined
        ? { ok: false, reason: `seed:audit wrote no account for ${key}.` }
        : await signIn(browser, base, account.email);
    console.log(
      `[capture] ${key}: ${session.ok ? "signed in" : session.reason}`,
    );
    sessions.set(key, session);
  }
  return sessions;
}

// ── Overlays ──────────────────────────────────────────────────────────────

/** A pattern that matches a name starting with `prefix`, taken literally. */
function prefixPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}`);
}

/**
 * Open an overlay that has no address, by the control a person uses. The
 * names come from the message catalogues the app renders, and the two test
 * ids are the ones the components declare for their tests. A failure throws,
 * and the caller captures the page beneath with a note.
 */
async function openOverlay(page: Page, overlay: OverlayKey): Promise<void> {
  const shell = shellCatalog.shell;
  const timeout = OVERLAY_TIMEOUT_MS;
  switch (overlay) {
    case "command-menu":
      await page.keyboard.press("Control+K");
      await page
        .getByRole("dialog", { name: shell.commands.title })
        .waitFor({ timeout });
      return;
    case "account": {
      // "User menu for {name}": the trigger's name starts with the part
      // before the person's name.
      const userMenu = prefixPattern(
        shell.topbar.userMenu.split("{name}")[0] ?? "",
      );
      await page
        .getByRole("button", { name: userMenu })
        .filter({ visible: true })
        .first()
        .click({ timeout });
      await page
        .getByRole("menuitem", { name: shell.userMenu.profile, exact: true })
        .click({ timeout });
      await page
        .getByRole("dialog", { name: shell.account.title })
        .waitFor({ timeout });
      return;
    }
    case "stella": {
      const launcher = page
        .getByTestId("assistant-launcher")
        .filter({ visible: true });
      if ((await launcher.count()) === 0) {
        // Below `md` the rail is hidden, and the launcher's second copy sits
        // at the foot of the navigation drawer (assistant-launcher.tsx).
        await page
          .getByRole("button", { name: shell.topbar.menu, exact: true })
          .filter({ visible: true })
          .first()
          .click({ timeout });
      }
      await launcher.first().click({ timeout });
      // The panel the launcher's aria-controls names (ASSISTANT_PANEL_ID).
      await page.locator("#shell-assistant").waitFor({ timeout });
      return;
    }
    case "new-workspace": {
      const copy = organizationCatalog.organization.actions.createWorkspace;
      await page
        .getByRole("button", { name: copy.open, exact: true })
        .filter({ visible: true })
        .first()
        .click({ timeout });
      await page.getByRole("dialog", { name: copy.title }).waitFor({ timeout });
      return;
    }
  }
}

// ── One screenshot ────────────────────────────────────────────────────────

type Job = {
  readonly slug: string;
  readonly capture: Capture;
  readonly variant: Variant;
  /** The path after its placeholders were filled. */
  readonly path: string;
  readonly origin: string;
  readonly overlay: OverlayKey | null;
  readonly session: StorageState | null;
};

type FileEntry = {
  readonly state: string;
  readonly persona: PersonaKey;
  readonly theme: Variant["theme"];
  readonly viewport: Variant["viewport"];
  readonly file: string;
  readonly path: string;
  /** Where the browser ended up, after any redirect. */
  readonly url: string;
  /** The document's HTTP status, or null when the navigation returned no response. */
  readonly status: number | null;
  readonly note?: string;
};

type Shot =
  | { readonly kind: "file"; readonly entry: FileEntry }
  | { readonly kind: "failed"; readonly skip: Skip };

/** Slow the page's network through the DevTools protocol, for the loading state. */
async function throttle(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", LOADING_NETWORK);
}

/**
 * After the response commits, wait for a busy region and the stylesheets,
 * then say whether the busy region is still on screen. Best effort: a page
 * that settles before its stylesheets arrive shows no loading state.
 */
async function catchLoading(page: Page): Promise<string | null> {
  const busy = page.locator('[aria-busy="true"]').first();
  await busy
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(() => undefined);
  await page
    .waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        ).every((link) => link.sheet !== null),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  return (await busy.isVisible())
    ? null
    : "No busy region was on screen when the screenshot was taken. The page may have settled first.";
}

async function shoot(browser: Browser, job: Job, out: string): Promise<Shot> {
  const { capture, variant } = job;
  const context = await browser.newContext({
    viewport: variant.size,
    deviceScaleFactor: 1,
    colorScheme: variant.theme,
    reducedMotion: "reduce",
    storageState: job.session ?? undefined,
  });
  try {
    // The shell's pre-paint script reads the `theme` cookie (THEME_SCRIPT in
    // src/features/shell/theme.ts). A page outside the shell follows the
    // color scheme above.
    await context.addCookies([
      { name: "theme", value: variant.theme, url: job.origin },
    ]);
    const page = await context.newPage();
    const url = `${job.origin}${job.path}`;
    const notes: string[] = [];
    let response: PageResponse | null;
    if (capture.mode === "loading") {
      await throttle(context, page);
      response = await page.goto(url, {
        waitUntil: "commit",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const note = await catchLoading(page);
      if (note !== null) notes.push(note);
    } else {
      response = await page.goto(url, {
        waitUntil: "load",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      // A live page holds a stream open, so network idle may never come.
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => undefined);
    }
    const overlay = job.overlay;
    if (overlay !== null && capture.mode === "loading") {
      // Opening the overlay waits for the page to settle, which would take
      // the loading state away.
      notes.push(
        `The ${overlay} overlay is not opened in the loading state, which shows the page beneath as it loads.`,
      );
    } else if (overlay !== null) {
      try {
        await openOverlay(page, overlay);
      } catch (error) {
        notes.push(
          `The ${overlay} overlay did not open (${firstLine(error)}), so the page beneath is captured.`,
        );
      }
    }
    await delay(SETTLE_MS);
    const file = fileName(capture.state, variant);
    await page.screenshot({
      path: path.join(out, job.slug, file),
      animations: "disabled",
    });
    return {
      kind: "file",
      entry: {
        state: capture.state,
        persona: capture.persona,
        theme: variant.theme,
        viewport: variant.viewport,
        file,
        path: job.path,
        url: page.url(),
        status: response?.status() ?? null,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      },
    };
  } catch (error) {
    return {
      kind: "failed",
      skip: {
        state: capture.state,
        reason: `The ${variantName(variant)} capture failed: ${firstLine(error)}`,
      },
    };
  } finally {
    await context.close();
  }
}

/** Run `work` over `items` with at most `size` at once, keeping their order. */
async function pool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => worker()),
  );
  return results;
}

// ── The run ───────────────────────────────────────────────────────────────

type PageEntry = { files: FileEntry[]; skipped: Skip[]; note?: string };

async function run(args: Args): Promise<number> {
  const variants = pickVariants(args.variants);
  if (variants === null) {
    throw new UsageError("--variants names a variant that does not exist");
  }
  const registry = readJson(args.registry, registrySchema, "the registry");
  const { pages, unknown } = selectPages(registry, args.pages);
  if (unknown.length > 0) {
    throw new UsageError(`no page in the registry is named ${unknown.join(", ")}`);
  }
  const seed = readJson(SEED_RECORD, seedRecordSchema, "the seed:e2e record");
  const record = readJson(
    PERSONAS_RECORD,
    personasRecordSchema,
    "the seed:audit record",
  );

  if (!(await waitForServer(args.baseUrl))) {
    console.error(`capture: ${args.baseUrl}/login never answered`);
    return 1;
  }
  const faultUp =
    args.faultUrl !== null && (await waitForServer(args.faultUrl));
  if (args.faultUrl !== null && !faultUp) {
    console.warn(
      `capture: ${args.faultUrl}/login never answered; error states are skipped`,
    );
  }

  const plans = pages.map(planPage);
  const manifestPages: Record<string, PageEntry> = {};
  const jobs: Job[] = [];
  const browser = await chromium.launch();
  try {
    const sessions = await signInAll(browser, args.baseUrl, plans, record);
    for (const plan of plans) {
      const entry: PageEntry = {
        files: [],
        skipped: [...plan.skipped],
        ...(plan.note === null ? {} : { note: plan.note }),
      };
      manifestPages[plan.slug] = entry;
      mkdirSync(path.join(args.out, plan.slug), { recursive: true });
      for (const capture of plan.captures) {
        const resolved = resolvePath(
          capture.path,
          valuesFor(capture, record, seed.runPublicId),
        );
        if (!resolved.ok) {
          entry.skipped.push({
            state: capture.state,
            reason: unresolvedReason(resolved, record),
          });
          continue;
        }
        const origin = capture.server === "fault" ? args.faultUrl : args.baseUrl;
        if (origin === null || (capture.server === "fault" && !faultUp)) {
          entry.skipped.push({
            state: capture.state,
            reason:
              "No fault server answered (--fault-url), so the error state cannot be shown.",
          });
          continue;
        }
        let session: StorageState | null = null;
        if (capture.persona !== "anonymous") {
          const signedIn = sessions.get(capture.persona);
          if (signedIn === undefined || !signedIn.ok) {
            entry.skipped.push({
              state: capture.state,
              reason: signedIn?.reason ?? `${capture.persona} did not sign in.`,
            });
            continue;
          }
          session = signedIn.state;
        }
        for (const variant of variants) {
          jobs.push({
            slug: plan.slug,
            capture,
            variant,
            path: resolved.path,
            origin,
            overlay: plan.overlay,
            session,
          });
        }
      }
    }

    console.log(
      `[capture] ${String(jobs.length)} screenshots of ${String(plans.length)} pages`,
    );
    const shots = await pool(jobs, args.concurrency, (job) =>
      shoot(browser, job, args.out),
    );
    jobs.forEach((job, index) => {
      const shot = shots[index];
      const entry = manifestPages[job.slug];
      if (shot === undefined || entry === undefined) return;
      if (shot.kind === "file") entry.files.push(shot.entry);
      else entry.skipped.push(shot.skip);
    });
  } finally {
    await browser.close();
  }

  const manifest = {
    schema: 1,
    ref: args.ref,
    commit: args.commit,
    registryRef: args.registryRef,
    baseUrl: args.baseUrl,
    faultUrl: args.faultUrl,
    variants: variants.map(variantName),
    pages: manifestPages,
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    path.join(args.out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  let files = 0;
  let skipped = 0;
  for (const [slug, entry] of Object.entries(manifestPages)) {
    files += entry.files.length;
    skipped += entry.skipped.length;
    console.log(
      `[capture] ${slug}: ${String(entry.files.length)} files, ${String(entry.skipped.length)} skipped`,
    );
  }
  console.log(
    `[capture] wrote ${String(files)} screenshots and skipped ${String(skipped)} states. The manifest is ${path.join(args.out, "manifest.json")}.`,
  );
  return 0;
}

async function main(): Promise<number> {
  try {
    return await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError || error instanceof StartError) {
      console.error(`capture: ${error.message}`);
      if (error instanceof UsageError) console.error(USAGE);
      return 2;
    }
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("capture: failed", error);
    process.exit(1);
  },
);
