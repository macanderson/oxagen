// The Work walk (ADR-255, lane P1-05, #5163): the Work pages in a real
// browser, in both themes, by keyboard, at phone width, with stale evidence
// and a refused viewer. CI-only: `.github/workflows/work-surfaces-walk.yml`
// runs it against `next start` on the production build that workflow made,
// after seed:e2e, seed:audit, and seed:work. It is not an e2e spec (INV-20
// allows exactly three), and nothing under `src/` imports it (INV-07, INV-22).
//
//   tsx scripts/work-walk/walk.ts --out DIR [--base-url URL]
//
// It signs in through the login form, as e2e/login.spec.ts does, as the e2e
// owner and as the persona dana, then walks four parts in order:
//
//   1. Every seeded state (./states.ts) in dark and light at 1440x1000 and in
//      dark at 400x860: the Work page's four tabs, each seeded item on its own
//      tab with its status and wait, Work setup's three tabs, Outcomes, and
//      each seeded item's page. No Work page says Held or Proven, and at 400
//      px none scrolls sideways. This part changes nothing.
//   2. Keyboard, dark desktop: the tab row by arrow keys and Enter, a dialog
//      closed with Escape that hands focus back, and a new work item entered
//      and submitted from the keyboard.
//   3. The workflow as the owner: approve the triage draft, send it, cancel
//      the send, see a failing check block Accept, see stale evidence, press
//      Accept and see it refused, answer a question, close an item as a
//      duplicate and reopen it.
//   4. dana, who holds the Billing role in e2e-org and no workspace role: the
//      Work page and an item page draw the denied state and no action.
//
// Accept reads GitHub at the press, and this job has no GitHub connection.
// So the walk proves Accept is refused, and the item stays in review.
// dispatch.pg.test.ts and the component tests prove an Accept that succeeds.
//
// It saves a screenshot of every step as OUT/<step>.<theme>.<viewport>.png.
// It stops at the first broken check, saves OUT/failure.<theme>.<viewport>.png,
// and exits 1 with a message that names the page and what it showed. It exits
// 2 when an argument, the seed record, or a sign-in is missing.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "@playwright/test";
import { SEED } from "../../e2e/support";
import authCatalog from "../../messages/auth.json" with { type: "json" };
import catalog from "../../messages/en.json" with { type: "json" };
import { PERSONA_PASSWORD, personaByKey } from "../mockup-parity/personas";
import {
  ANSWER_BOX,
  DENIED_TEST_IDS,
  REASON_BOX,
  type SetupTab,
  WALK_CHECK,
  WALK_STATES,
  WALK_TEST_IDS as ID,
  type WalkState,
  type WalkStateKey,
  WORK_WALK_RECORD,
  type WorkTab,
  type WorkWalkRecord,
  walkState,
  workWalkRecordSchema,
} from "./states";

const USAGE = "usage: walk.ts --out DIR [--base-url URL]";

/** How long the server may take to answer /login before the walk gives up. */
const SERVER_WAIT_MS = 120_000;

/** How long one navigation may take. */
const NAVIGATION_TIMEOUT_MS = 60_000;

/** How long a page may take to show what a check waits for. */
const WAIT_MS = 20_000;

/** How long one attribute read waits for its element. */
const READ_MS = 2_000;

const POLL_MS = 250;

/** A pause before each screenshot, so a transition that is still running finishes. */
const SETTLE_MS = 300;

const WORK_TABS: readonly WorkTab[] = ["inbox", "running", "review", "done"];
const SETUP_TABS: readonly SetupTab[] = ["collectors", "priorities", "runtimes"];

/** Words a Phase 1 Work page never shows (agent-work-phase-1.html, Screens). */
const FORBIDDEN_WORDS = /\b(Held|Proven)\b/;

type Theme = "dark" | "light";
type Viewport = "desktop" | "phone";
type Variant = {
  readonly theme: Theme;
  readonly viewport: Viewport;
  readonly size: { readonly width: number; readonly height: number };
};

const DESKTOP = { width: 1440, height: 1000 } as const;
const PHONE = { width: 400, height: 860 } as const;
const DARK_DESKTOP: Variant = { theme: "dark", viewport: "desktop", size: DESKTOP };
const LIGHT_DESKTOP: Variant = { theme: "light", viewport: "desktop", size: DESKTOP };
const DARK_PHONE: Variant = { theme: "dark", viewport: "phone", size: PHONE };
const VARIANTS: readonly Variant[] = [DARK_DESKTOP, LIGHT_DESKTOP, DARK_PHONE];

class UsageError extends Error {}
class StartError extends Error {}
class WalkError extends Error {}

type Args = { readonly out: string; readonly baseUrl: string };

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) {
      throw new UsageError(`expected --flag value pairs, got "${name}"`);
    }
    if (name !== "--out" && name !== "--base-url") throw new UsageError(`unknown flag ${name}`);
    flags.set(name.slice(2), value.trim());
  }
  const out = flags.get("out") ?? "";
  if (out === "") throw new UsageError("--out is required");
  const baseUrl = (flags.get("base-url") ?? "http://localhost:3000").replace(/\/+$/, "");
  return { out, baseUrl };
}

/** An error's first line, for a log line. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n", 1)[0] ?? "";
}

/** A value as a message quotes it. */
function show(value: string | null): string {
  return value === null ? "none" : `"${value}"`;
}

/** Stop the walk: `label` names the page and the variant. */
function fail(label: string, message: string): never {
  throw new WalkError(`${label}: ${message}`);
}

function readRecord(): WorkWalkRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(WORK_WALK_RECORD, "utf8"));
  } catch (error) {
    throw new StartError(`The seed:work record at ${WORK_WALK_RECORD} is unreadable: ${firstLine(error)}. Run seed:work first.`);
  }
  const parsed = workWalkRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StartError(`The seed:work record at ${WORK_WALK_RECORD} does not have the expected shape: ${parsed.error.message}`);
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

// ── Paths and titles ──────────────────────────────────────────────────────

function workspacePath(record: WorkWalkRecord): string {
  return `/${record.orgSlug}/${record.workspaceSlug}`;
}

/** The Work page on `tab`. Inbox is the page with no `tab=`. */
function workPath(record: WorkWalkRecord, tab: WorkTab = "inbox"): string {
  const base = `${workspacePath(record)}/work`;
  return tab === "inbox" ? base : `${base}?tab=${tab}`;
}

/** Work setup on `tab`. Collectors is the page with no `tab=`. */
function setupPath(record: WorkWalkRecord, tab: SetupTab): string {
  const base = `${workspacePath(record)}/work/setup`;
  return tab === "collectors" ? base : `${base}?tab=${tab}`;
}

function itemPath(record: WorkWalkRecord, number: string): string {
  return `${workspacePath(record)}/work/${number}`;
}

/** The document title the root layout composes: `%s · Oxagen`. */
function titleOf(page: string): string {
  return `${page} · ${catalog.app.name}`;
}

function numberOf(record: WorkWalkRecord, key: WalkStateKey): string {
  return record.items[key].number;
}

// ── Sessions and pages ────────────────────────────────────────────────────

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

type Walk = {
  readonly browser: Browser;
  readonly base: string;
  readonly out: string;
  readonly record: WorkWalkRecord;
  readonly owner: StorageState;
};

/**
 * Sign in through the login form, as e2e/login.spec.ts does, and keep the
 * storage state. The landing page goes in `next`: a bare /login sends a
 * person to the root after sign-in.
 */
async function signIn(browser: Browser, base: string, email: string, password: string, landing: string): Promise<StorageState> {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/login?next=${encodeURIComponent(landing)}`, { timeout: NAVIGATION_TIMEOUT_MS });
    const copy = authCatalog.auth.login;
    const form = page.getByRole("form", { name: copy.title });
    await form.locator("#login-email").fill(email);
    await form.locator("#login-password").fill(password);
    await form.getByRole("button", { name: copy.submit }).click();
    try {
      await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
    } catch {
      const shown = (await page.getByRole("alert").allInnerTexts())
        .map((text) => text.trim())
        .filter((text) => text !== "")
        .join(" ");
      throw new StartError(
        `Signing in as ${email} failed. The page stayed at ${page.url()}${shown === "" ? " with no alert" : ` and showed: ${shown}`}.`,
      );
    }
    console.log(`[walk] signed in as ${email}`);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** Run `fn` on a fresh page in `variant`, signed in with `session`. A failure saves a screenshot first. */
async function withPage(walk: Walk, session: StorageState, variant: Variant, fn: (page: Page) => Promise<void>): Promise<void> {
  const context = await walk.browser.newContext({
    viewport: variant.size,
    deviceScaleFactor: 1,
    colorScheme: variant.theme,
    reducedMotion: "reduce",
    storageState: session,
  });
  try {
    // The shell's pre-paint script reads the `theme` cookie (THEME_SCRIPT in
    // src/features/shell/theme.ts).
    await context.addCookies([{ name: "theme", value: variant.theme, url: walk.base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    page.on("pageerror", (error) => {
      console.warn(`[walk] page error on ${page.url()}: ${firstLine(error)}`);
    });
    try {
      await fn(page);
    } catch (error) {
      await page
        .screenshot({
          path: path.join(walk.out, `failure.${variant.theme}.${variant.viewport}.png`),
          fullPage: true,
          animations: "disabled",
        })
        .catch(() => undefined);
      throw error;
    }
  } finally {
    await context.close();
  }
}

/**
 * Go to `target` and stay there: no redirect, not even to /login. A page the
 * viewer may read answers 200. A refused viewer's page may answer 403, so
 * `refused` admits any answer below 500.
 */
async function open(walk: Walk, page: Page, target: string, label: string, refused = false): Promise<void> {
  const response = await page.goto(`${walk.base}${target}`, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  const status = response?.status() ?? null;
  const ok = status !== null && (refused ? status < 500 : status === 200);
  if (!ok) fail(label, `${target} answered ${status === null ? "nothing" : String(status)}.`);
  const landed = new URL(page.url());
  if (`${landed.pathname}${landed.search}` !== target) {
    fail(label, `${target} redirected to ${landed.pathname}${landed.search}.`);
  }
  // A live page holds a stream open, so network idle may never come.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

async function expectTitle(page: Page, title: string, label: string): Promise<void> {
  try {
    await page.waitForFunction((expected) => document.title === expected, title, { timeout: WAIT_MS });
  } catch {
    fail(label, `the title is "${await page.title()}", not "${title}".`);
  }
}

/** The first visible element with this test id. */
function byTestId(page: Page, id: string): Locator {
  return page.getByTestId(id).filter({ visible: true }).first();
}

function isShown(target: Locator, timeoutMs = WAIT_MS): Promise<boolean> {
  return target.waitFor({ state: "visible", timeout: timeoutMs }).then(
    () => true,
    () => false,
  );
}

/** The attribute on the element, or on the first element inside it that carries it. */
async function attributeOf(target: Locator, name: string): Promise<string | null> {
  const own = await target.getAttribute(name, { timeout: READ_MS });
  if (own !== null) return own;
  const inner = target.locator(`[${name}]`).first();
  if ((await inner.count()) === 0) return null;
  return inner.getAttribute(name, { timeout: READ_MS });
}

type Poll = { readonly matched: boolean; readonly value: string | null };

/** Read the attribute until `accept` takes it or the time runs out. A page that refreshes after a write is read again. */
async function pollAttribute(
  target: Locator,
  name: string,
  accept: (value: string | null) => boolean,
  timeoutMs = WAIT_MS,
): Promise<Poll> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attributeOf(target, name).catch(() => null);
    if (accept(value)) return { matched: true, value };
    if (Date.now() >= deadline) return { matched: false, value };
    await delay(POLL_MS);
  }
}

/** The item page's status, waited for until it reads `expected`. */
async function expectItemStatus(page: Page, expected: string, label: string): Promise<void> {
  const status = await pollAttribute(byTestId(page, ID.itemStatus), "data-status", (value) => value === expected);
  if (!status.matched) fail(label, `the item reads data-status ${show(status.value)}, not "${expected}".`);
}

/** The item page's status, waited for until it is anything but `left`. */
async function expectItemLeft(page: Page, left: string, label: string): Promise<void> {
  const status = await pollAttribute(
    byTestId(page, ID.itemStatus),
    "data-status",
    (value) => value !== null && value !== left,
  );
  if (!status.matched) fail(label, `the item still reads data-status ${show(status.value)}.`);
}

async function checkTab(page: Page, name: string, label: string): Promise<void> {
  const tab = page.locator(`[data-tab="${name}"]:visible`).first();
  const selected = await pollAttribute(tab, "aria-selected", (value) => value === "true");
  if (!selected.matched) fail(label, `the ${name} tab is not selected (aria-selected ${show(selected.value)}).`);
}

async function checkWords(page: Page, label: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  const found = FORBIDDEN_WORDS.exec(text);
  if (found !== null) {
    fail(label, `the page says "${found[0]}". A Phase 1 Work page says neither Held nor Proven (agent-work-phase-1.html, Screens).`);
  }
}

async function checkNoSideScroll(page: Page, label: string): Promise<void> {
  const size = await page.evaluate(() => ({
    scrollWidth: (document.scrollingElement ?? document.documentElement).scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (size.scrollWidth > size.innerWidth) {
    fail(label, `the page scrolls sideways: it is ${String(size.scrollWidth)} px wide in a ${String(size.innerWidth)} px window.`);
  }
}

async function shoot(walk: Walk, page: Page, step: string, variant: Variant): Promise<void> {
  await delay(SETTLE_MS);
  const file = `${step}.${variant.theme}.${variant.viewport}.png`;
  await page.screenshot({ path: path.join(walk.out, file), fullPage: true, animations: "disabled" });
  console.log(`[walk] ${file}`);
}

/** What every Work page must hold in every variant, then its screenshot. */
async function settle(walk: Walk, page: Page, variant: Variant, step: string, label: string): Promise<void> {
  await checkWords(page, label);
  if (variant.viewport === "phone") await checkNoSideScroll(page, label);
  await shoot(walk, page, step, variant);
}

/** A file-name form of a state key. */
function stepName(key: WalkStateKey): string {
  return key.replace(/_/g, "-");
}

// ── 1. Every seeded state ────────────────────────────────────────────────

function rowOf(page: Page, number: string): Locator {
  return page.locator(`[data-work-item="${number}"]`).filter({ visible: true }).first();
}

/**
 * The item is listed with its status and wait. The first `data-status` and
 * `data-wait` in the row are the item's own. At phone width the Inbox hides
 * its State column, so the status is read from the attribute, not the screen.
 */
async function checkRow(page: Page, state: WalkState, number: string, label: string): Promise<void> {
  const row = rowOf(page, number);
  if (!(await isShown(row))) fail(label, `${number} (${state.title}) is not listed, and it belongs on this tab.`);
  const status = await attributeOf(row, "data-status");
  if (status !== state.status) {
    fail(label, `${number} (${state.title}) reads data-status ${show(status)}, not "${state.status}".`);
  }
  const wait = await attributeOf(row, "data-wait");
  if (wait !== state.wait) fail(label, `${number} (${state.title}) reads data-wait ${show(wait)}, not "${state.wait}".`);
}

async function checkAbsent(page: Page, state: WalkState, number: string, label: string): Promise<void> {
  const shown = await page.locator(`[data-work-item="${number}"]`).filter({ visible: true }).count();
  if (shown > 0) fail(label, `${number} (${state.title}) is listed here, and it belongs on the ${state.tab} tab.`);
}

async function checkItemPage(page: Page, state: WalkState, number: string, label: string): Promise<void> {
  const status = byTestId(page, ID.itemStatus);
  if (!(await isShown(status))) fail(label, `the page has no visible ${ID.itemStatus}.`);
  const statusValue = await attributeOf(status, "data-status");
  if (statusValue !== state.status) {
    fail(label, `${number} (${state.title}) reads data-status ${show(statusValue)}, not "${state.status}".`);
  }
  const wait = byTestId(page, ID.itemWait);
  if (!(await isShown(wait))) fail(label, `the page has no visible ${ID.itemWait}.`);
  const waitValue = await attributeOf(wait, "data-wait");
  if (waitValue !== state.wait) {
    fail(label, `${number} (${state.title}) reads data-wait ${show(waitValue)}, not "${state.wait}".`);
  }
}

async function sweep(walk: Walk, variant: Variant): Promise<void> {
  const where = `${variant.theme} ${variant.viewport}`;
  const { record } = walk;
  await withPage(walk, walk.owner, variant, async (page) => {
    for (const tab of WORK_TABS) {
      const label = `Work page, ${tab} tab, ${where}`;
      await open(walk, page, workPath(record, tab), label);
      await expectTitle(page, titleOf(catalog.pages.work), label);
      await checkTab(page, tab, label);
      for (const state of WALK_STATES) {
        const number = numberOf(record, state.key);
        if (state.tab === tab) await checkRow(page, state, number, label);
        else await checkAbsent(page, state, number, label);
      }
      await settle(walk, page, variant, `work-${tab}`, label);
    }

    for (const tab of SETUP_TABS) {
      const label = `Work setup, ${tab} tab, ${where}`;
      await open(walk, page, setupPath(record, tab), label);
      await expectTitle(page, titleOf(catalog.pages.workSetup), label);
      await checkTab(page, tab, label);
      if (tab === "collectors") {
        const collector = page.getByText(record.collector, { exact: false }).filter({ visible: true }).first();
        if (!(await isShown(collector))) fail(label, `the collector ${record.collector} is not listed.`);
      }
      await settle(walk, page, variant, `setup-${tab}`, label);
    }

    const outcomesLabel = `Outcomes, ${where}`;
    await open(walk, page, `${workspacePath(record)}/work/outcomes`, outcomesLabel);
    await expectTitle(page, titleOf(catalog.pages.workOutcomes), outcomesLabel);
    await settle(walk, page, variant, "outcomes", outcomesLabel);

    for (const state of WALK_STATES) {
      const number = numberOf(record, state.key);
      const label = `Work item ${number} (${state.key}), ${where}`;
      await open(walk, page, itemPath(record, number), label);
      // The item route titles the page with the item first (generateMetadata).
      await expectTitle(page, titleOf(`${number} · ${catalog.pages.workItem}`), label);
      await checkItemPage(page, state, number, label);
      await settle(walk, page, variant, `item-${stepName(state.key)}`, label);
    }
  });
  console.log(`[walk] every seeded state reads right in ${where}`);
}

// ── 2. Keyboard ───────────────────────────────────────────────────────────

/** The `data-*` attribute of the focused element. */
function focusedAttribute(page: Page, name: string): Promise<string | null> {
  return page.evaluate((attribute) => document.activeElement?.getAttribute(attribute) ?? null, name);
}

async function openDialog(page: Page, label: string): Promise<Locator> {
  const dialog = page.getByRole("dialog").filter({ visible: true }).last();
  if (!(await isShown(dialog))) fail(label, "no dialog opened.");
  return dialog;
}

async function keyboard(walk: Walk): Promise<void> {
  const variant = DARK_DESKTOP;
  const { record } = walk;
  await withPage(walk, walk.owner, variant, async (page) => {
    // The tab row is one tab stop. The arrow keys move along it, and Enter
    // follows the focused tab's link (ADR-243).
    let label = "Keyboard, Work page tab row";
    await open(walk, page, workPath(record), label);
    await page.locator('[data-tab="inbox"]:visible').first().focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const focusedTab = await focusedAttribute(page, "data-tab");
    if (focusedTab !== "review") {
      fail(label, `two presses of ArrowRight from Inbox focused the tab ${show(focusedTab)}, not "review".`);
    }
    await page.keyboard.press("Enter");
    try {
      await page.waitForURL((url) => url.searchParams.get("tab") === "review", { timeout: WAIT_MS });
    } catch {
      fail(label, `Enter on the Review tab left the page at ${page.url()}.`);
    }
    await checkTab(page, "review", label);
    await shoot(walk, page, "keyboard-tabs", variant);

    // A dialog closed with Escape gives focus back to the button that opened it.
    label = "Keyboard, Escape closes a dialog";
    await open(walk, page, workPath(record), label);
    const opener = byTestId(page, ID.newItem);
    if (!(await isShown(opener))) fail(label, `the Work page has no visible ${ID.newItem}.`);
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = await openDialog(page, label);
    await page.keyboard.press("Escape");
    try {
      await dialog.waitFor({ state: "hidden", timeout: WAIT_MS });
    } catch {
      fail(label, "Escape did not close the New work item dialog.");
    }
    const deadline = Date.now() + 2_000;
    let focused = await focusedAttribute(page, "data-testid");
    while (focused !== ID.newItem && Date.now() < deadline) {
      await delay(POLL_MS);
      focused = await focusedAttribute(page, "data-testid");
    }
    if (focused !== ID.newItem) {
      fail(label, `after Escape, focus is on ${show(focused)}, not back on New work item.`);
    }
    await shoot(walk, page, "keyboard-dialog-closed", variant);

    // Enter a work item from the keyboard alone: Enter opens the dialog, Tab
    // reaches the title, and Enter submits it.
    label = "Keyboard, new work item";
    await opener.focus();
    await page.keyboard.press("Enter");
    await openDialog(page, label);
    let onTitle = false;
    for (let presses = 0; presses < 12 && !onTitle; presses += 1) {
      onTitle = await page.evaluate(() => {
        const field = document.activeElement;
        return field instanceof HTMLInputElement && field.type === "text" && field.closest('[role="dialog"]') !== null;
      });
      if (!onTitle) await page.keyboard.press("Tab");
    }
    if (!onTitle) fail(label, "Tab never reached a text field in the New work item dialog.");
    await page.keyboard.type(`Work walk: entered from the keyboard at ${new Date().toISOString()}`);
    await page.keyboard.press("Enter");
    try {
      await page.waitForURL((url) => /\/work\/WI-[0-9]+$/.test(url.pathname), { timeout: WAIT_MS });
    } catch {
      const failure = byTestId(page, ID.actionFailure);
      const why = (await failure.count()) > 0 ? ` It showed: ${await failure.innerText()}` : "";
      fail(label, `Enter did not open the new item's page. The page stayed at ${page.url()}.${why}`);
    }
    // This job runs no triage, so a new item stays in triage.
    await expectItemStatus(page, "triaging", label);
    await shoot(walk, page, "keyboard-new-item", variant);
  });
  console.log("[walk] the keyboard reaches the tabs, a dialog, and a new item");
}

// ── 3. The workflow as the owner ─────────────────────────────────────────

/** Press the visible, enabled button with this test id. */
async function press(page: Page, id: string, label: string): Promise<void> {
  const button = byTestId(page, id);
  if (!(await isShown(button))) fail(label, `there is no visible ${id}.`);
  if (await isDisabled(button)) fail(label, `${id} is disabled.`);
  await button.click();
}

async function isDisabled(target: Locator): Promise<boolean> {
  if (!(await target.isEnabled())) return true;
  return (await target.getAttribute("aria-disabled")) === "true";
}

/** Type a reason into the open dialog's reason box. */
async function fillReason(page: Page, text: string, label: string): Promise<void> {
  const box = page.getByRole("dialog").filter({ visible: true }).last().locator(REASON_BOX).first();
  if (!(await isShown(box, 5_000))) fail(label, `the dialog has no reason box (${REASON_BOX}).`);
  await box.fill(text);
}

/** Tick a checkbox, a switch, or a radio, whatever element carries the test id. */
async function tick(target: Locator): Promise<void> {
  const checked = await target.isChecked().catch(() => null);
  if (checked === false) await target.check();
  else if (checked === null) await target.click();
}

async function workflow(walk: Walk): Promise<void> {
  const variant = DARK_DESKTOP;
  const { record } = walk;
  const itemOf = (key: WalkStateKey) => itemPath(record, numberOf(record, key));
  await withPage(walk, walk.owner, variant, async (page) => {
    // Approve the brief triage drafted.
    let label = `Workflow, approve the triage draft ${numberOf(record, "triage_draft")}`;
    await open(walk, page, itemOf("triage_draft"), label);
    // Approve runs in place: it saves the brief triage drafted and approves it.
    await press(page, ID.approve, label);
    await expectItemStatus(page, "ready", label);
    await shoot(walk, page, "flow-approved", variant);

    // Send it to e2e-agent, which holds no open send.
    label = `Workflow, send ${numberOf(record, "triage_draft")} to an agent`;
    await press(page, ID.send, label);
    await openDialog(page, label);
    const preferred = byTestId(page, `${ID.sendAgentPrefix}${record.agents.send}`);
    const agent = (await preferred.count()) > 0
      ? preferred
      : page
          .locator(`[data-testid^="${ID.sendAgentPrefix}"]:not([disabled]):not([aria-disabled="true"])`)
          .filter({ visible: true })
          .first();
    if ((await agent.count()) === 0) {
      fail(label, `the Send dialog offers no agent. ${record.agents.send} has a host that takes work orders and no open send.`);
    }
    await tick(agent);
    await press(page, ID.sendSubmit, label);
    await expectItemStatus(page, "waiting_for_claim", label);
    await shoot(walk, page, "flow-sent", variant);

    // Withdraw the send before any runtime claims it.
    label = `Workflow, cancel the send of ${numberOf(record, "triage_draft")}`;
    await press(page, ID.cancel, label);
    await openDialog(page, label);
    await fillReason(page, "The walk withdraws the send it just made.", label);
    await press(page, ID.cancelSubmit, label);
    await expectItemStatus(page, "ready", label);
    await shoot(walk, page, "flow-cancelled", variant);

    // A failing required check keeps Accept disabled, and the review names it.
    label = `Workflow, a failing check on ${numberOf(record, "review_failing")}`;
    await open(walk, page, itemOf("review_failing"), label);
    const accept = byTestId(page, ID.accept);
    if (!(await isShown(accept))) fail(label, `${ID.accept} is not on the page. A failing check disables Accept and leaves it in view.`);
    if (!(await isDisabled(accept))) fail(label, `Accept is enabled while the required check ${WALK_CHECK} failed.`);
    const waitLine = await byTestId(page, ID.itemWait).innerText();
    if (!new RegExp(`\\b${WALK_CHECK}\\b`).test(waitLine)) {
      fail(label, `the review does not name the failed check ${WALK_CHECK}. It reads: "${waitLine}".`);
    }
    await shoot(walk, page, "flow-review-failing", variant);

    // An acceptance on an older head shows as stale evidence.
    label = `Workflow, stale evidence on ${numberOf(record, "stale_evidence")}`;
    await open(walk, page, itemOf("stale_evidence"), label);
    if (!(await isShown(byTestId(page, ID.staleEvidence)))) fail(label, `${ID.staleEvidence} is not on the page.`);
    await shoot(walk, page, "flow-stale-evidence", variant);

    // Accept reads GitHub at the press. This job has no GitHub connection, so
    // the honest answer is a refusal, and the item stays in review.
    label = `Workflow, accept ${numberOf(record, "review_passing")} with no GitHub connection`;
    await open(walk, page, itemOf("review_passing"), label);
    await press(page, ID.accept, label);
    await openDialog(page, label);
    for (const criterion of record.criteria) {
      const box = byTestId(page, `${ID.acceptCriterionPrefix}${criterion}`);
      if (!(await isShown(box))) fail(label, `the Accept dialog has no ${ID.acceptCriterionPrefix}${criterion}.`);
      await tick(box);
    }
    await press(page, ID.acceptSubmit, label);
    if (!(await isShown(byTestId(page, ID.actionFailure)))) {
      fail(label, `Accept showed no ${ID.actionFailure}. With no GitHub connection, Oxagen cannot read the checks, and Accept must be refused.`);
    }
    await expectItemStatus(page, walkState("review_passing").status, label);
    await shoot(walk, page, "flow-accept-refused", variant);

    // Answer triage's question.
    label = `Workflow, answer the question on ${numberOf(record, "needs_info")}`;
    await open(walk, page, itemOf("needs_info"), label);
    const answer = page.locator(ANSWER_BOX).filter({ visible: true }).first();
    if (!(await isShown(answer))) fail(label, `there is no visible answer box (${ANSWER_BOX}).`);
    await answer.fill("No. The expiry message is enough.");
    await press(page, ID.answer, label);
    await expectItemLeft(page, walkState("needs_info").status, label);
    await shoot(walk, page, "flow-answered", variant);

    // Close the possible duplicate as a duplicate: it moves to Done.
    const duplicate = numberOf(record, "possible_duplicate");
    label = `Workflow, close ${duplicate} as a duplicate`;
    await open(walk, page, itemOf("possible_duplicate"), label);
    const confirmDuplicate = byTestId(page, ID.confirmDuplicate);
    await press(page, (await isShown(confirmDuplicate, 5_000)) ? ID.confirmDuplicate : ID.close, label);
    await openDialog(page, label);
    const asDuplicate = byTestId(page, ID.closeAsDuplicate);
    if (!(await isShown(asDuplicate))) fail(label, `the Close dialog has no ${ID.closeAsDuplicate}.`);
    await tick(asDuplicate);
    await fillReason(page, "The walk closes this item as a repeat of the ready item.", label);
    await press(page, ID.closeSubmit, label);
    await expectItemStatus(page, "closed", label);
    await shoot(walk, page, "flow-closed", variant);
    label = `Workflow, ${duplicate} on the Done tab`;
    await open(walk, page, workPath(record, "done"), label);
    if (!(await isShown(rowOf(page, duplicate)))) fail(label, `${duplicate} is not listed on Done after it closed.`);
    await shoot(walk, page, "flow-done-tab", variant);

    // Reopen it: it goes back to the Inbox.
    label = `Workflow, reopen ${duplicate}`;
    await open(walk, page, itemOf("possible_duplicate"), label);
    await press(page, ID.reopen, label);
    await openDialog(page, label);
    await fillReason(page, "The walk reopens the item it closed.", label);
    await press(page, ID.reopenSubmit, label);
    await expectItemLeft(page, "closed", label);
    await shoot(walk, page, "flow-reopened", variant);
    label = `Workflow, ${duplicate} back in the Inbox`;
    await open(walk, page, workPath(record), label);
    if (!(await isShown(rowOf(page, duplicate)))) fail(label, `${duplicate} is not listed in the Inbox after it reopened.`);
    await shoot(walk, page, "flow-inbox-after-reopen", variant);
  });
  console.log("[walk] the owner approved, sent, cancelled, was refused Accept, answered, closed, and reopened");
}

// ── 4. A refused viewer ──────────────────────────────────────────────────

/**
 * dana holds the Billing role in e2e-org and no workspace role (seed:audit),
 * so the Work reads refuse her. The pages draw the denied state and offer no
 * action.
 */
async function refused(walk: Walk): Promise<void> {
  const variant = DARK_DESKTOP;
  const { record } = walk;
  const email = personaByKey("dana")?.email ?? null;
  if (email === null) throw new StartError("The persona dana has no sign-in address in personas.ts.");
  const session = await signIn(walk.browser, walk.base, email, PERSONA_PASSWORD, workspacePath(record));
  const pages: readonly (readonly [string, string, string])[] = [
    ["denied-work", workPath(record), "Role restriction, the Work page as dana"],
    ["denied-item", itemPath(record, numberOf(record, "review_passing")), "Role restriction, a work item as dana"],
  ];
  await withPage(walk, session, variant, async (page) => {
    for (const [step, target, label] of pages) {
      await open(walk, page, target, label, true);
      const denied = page.locator(DENIED_TEST_IDS.map((id) => `[data-testid="${id}"]`).join(", ")).filter({ visible: true }).first();
      if (!(await isShown(denied))) {
        fail(label, `the page draws none of ${DENIED_TEST_IDS.join(", ")}. dana holds no role that reads Work.`);
      }
      const actions = await page
        .locator(`[data-testid^="${ID.actionPrefix}"], [data-testid="${ID.newItem}"], [data-testid="${ID.listSend}"]`)
        .filter({ visible: true })
        .count();
      if (actions > 0) fail(label, `${String(actions)} Work actions are on a page dana is refused.`);
      await shoot(walk, page, step, variant);
    }
  });
  console.log("[walk] dana is refused the Work pages and offered no action");
}

// ── The run ───────────────────────────────────────────────────────────────

async function run(args: Args): Promise<number> {
  const record = readRecord();
  mkdirSync(args.out, { recursive: true });
  if (!(await waitForServer(args.baseUrl))) {
    console.error(`walk: ${args.baseUrl}/login never answered`);
    return 1;
  }
  const browser = await chromium.launch();
  try {
    const owner = await signIn(browser, args.baseUrl, SEED.email, SEED.password, workPath(record));
    const walk: Walk = { browser, base: args.baseUrl, out: args.out, record, owner };
    for (const variant of VARIANTS) await sweep(walk, variant);
    await keyboard(walk);
    await workflow(walk);
    await refused(walk);
  } finally {
    await browser.close();
  }
  console.log(`[walk] every check passed. The screenshots are in ${args.out}.`);
  return 0;
}

async function main(): Promise<number> {
  try {
    return await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof WalkError) {
      console.error(`walk: ${error.message}`);
      return 1;
    }
    if (error instanceof UsageError || error instanceof StartError) {
      console.error(`walk: ${error.message}`);
      if (error instanceof UsageError) console.error(USAGE);
      return 2;
    }
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("walk: failed", error);
    process.exit(1);
  },
);
