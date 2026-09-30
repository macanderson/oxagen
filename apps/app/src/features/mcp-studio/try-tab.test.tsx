// @vitest-environment jsdom
// A Studio server's Test tab (#4678) on fake calls: where the environment
// and tool pickers start, the live warning, the arguments check, a call in
// flight, the three panes a call that succeeded draws, the not built, denied
// and failed answers, the empty state, and Save as test. With no call passed,
// the tab gets try_studio_tool's stub, and Run renders disabled with a note
// until #4742 merges. A saved test is read
// back from the tab's sessionStorage the way the page stored it, and it must
// hold no credential header: Save as test strips authorization,
// proxy-authorization, cookie and set-cookie before it stages the test. The
// call itself names an environment and leaves the credential to the gateway.
// axe checks the state each test ends in (INV-26).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { DraftOp } from "./draft";
import type { TryResult, TryStudioTool } from "./pending-capabilities";
import {
  BILLING,
  draftKey,
  fakeTry,
  GITHUB,
  idDraftKey,
  SCRATCH,
  seedDraft,
  STRIPE,
  STUDIO_AT,
  studioTool,
  studioView,
  tryClean,
  tryWithCredentials,
  WAREHOUSE,
  WAREHOUSE_IMPORTED,
  warehouseTool,
} from "./studio.builders";
import { TryTab } from "./try-tab";

// Nothing under the tab navigates today; the router is here so a child that
// starts to cannot reach the real one.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

type TryProps = Parameters<typeof TryTab>[0];
type TryInput = Parameters<TryStudioTool["call"]>[0];
type Answered = Extract<TryResult, { ok: true }>;
type SavedTest = Extract<DraftOp, { kind: "test" }>;

/** How many edits a stored draft holds at most (draft.ts, `DraftShape`). */
const DRAFT_LIMIT = 2_000;

/** The four headers a saved test never holds, lowercased. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
];

function withIntl(element: ReactNode) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

/** The tab for one fixture server, with the props the page passes, and any of them replaced. */
function renderTry(serverId: string, over: Partial<TryProps> = {}) {
  const view = studioView(serverId);
  return withIntl(
    <TryTab
      at={STUDIO_AT}
      serverName={view.serverName}
      serverId={serverId}
      tools={view.tools}
      environments={view.environments}
      agentEnvironment={view.agentEnvironment}
      canEdit
      {...over}
    />,
  );
}

const environmentSelect = () => screen.getByLabelText("Environment");
const toolSelect = () => screen.getByLabelText("Tool");
const argsField = () => screen.getByLabelText("Arguments");
const saveButton = () => screen.getByRole("button", { name: "Save as test" });

/** The label of each option a select offers, in order. */
function optionsOf(select: HTMLElement): (string | null)[] {
  return Array.from(select.querySelectorAll("option"), (option) => option.textContent);
}

function choose(select: HTMLElement, value: string) {
  fireEvent.change(select, { target: { value } });
}

function typeArgs(text: string) {
  fireEvent.change(argsField(), { target: { value: text } });
}

function run() {
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
}

/** Run the call and wait for the three panes a call that succeeded draws. */
async function runToPanes() {
  run();
  await screen.findByTestId("studio-try-request");
}

/** A fixture narrowed to a call that succeeded, or a failure naming the fixture. */
function answered(result: TryResult): Answered {
  if (!result.ok) throw new Error("the fixture is not a call that succeeded");
  return result;
}

/** A call that stays in flight until the test settles it, recording each input. */
function pendingTry() {
  const calls: TryInput[] = [];
  const waiting: ((result: TryResult) => void)[] = [];
  const call: TryStudioTool = {
    name: "try_studio_tool",
    available: true,
    gap: "capability",
    call: (input) => {
      calls.push(input);
      return new Promise<TryResult>((resolve) => {
        waiting.push(resolve);
      });
    },
  };
  const settle = (result: TryResult) => {
    for (const resolve of waiting) resolve(result);
  };
  return { call, calls, settle };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function isSavedTest(value: unknown): value is SavedTest {
  if (!isRecord(value) || value.kind !== "test") return false;
  return [
    value.tool,
    value.environment,
    value.args,
    value.request,
    value.raw,
    value.shaped,
  ].every((field) => typeof field === "string");
}

/** The saved tests in the draft stored under `key`, read back from sessionStorage. */
function savedTests(key: string): SavedTest[] {
  const text = window.sessionStorage.getItem(key);
  if (text === null) throw new Error(`no draft is stored under ${key}`);
  const draft = parseJson(text);
  const ops: unknown = isRecord(draft) ? draft.ops : undefined;
  if (!Array.isArray(ops)) throw new Error(`the draft under ${key} has no ops`);
  return ops.filter(isSavedTest);
}

/** The one saved test under `key`, or a failure saying how many there were. */
function onlySavedTest(key: string): SavedTest {
  const tests = savedTests(key);
  const [test] = tests;
  if (tests.length !== 1 || test === undefined) {
    throw new Error(`expected one saved test under ${key}, found ${String(tests.length)}`);
  }
  return test;
}

/** The top-level `headers` record of one recorded exchange. */
function headersOf(text: string): Record<string, unknown> {
  const exchange = parseJson(text);
  const headers = isRecord(exchange) ? exchange.headers : undefined;
  if (!isRecord(headers)) throw new Error("the recorded exchange has no headers");
  return headers;
}

/** Fails when the text names a credential header in any case, or holds a secret value. */
function expectNoCredential(text: string, secrets: readonly string[]) {
  const lower = text.toLowerCase();
  for (const header of CREDENTIAL_HEADERS) expect(lower).not.toContain(header);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

/**
 * A call whose request carries authorization, proxy-authorization and cookie
 * and whose response carries set-cookie, each named in a different case.
 * None of these values is a secret.
 */
function tryWithEveryCredential(): TryResult {
  return {
    ok: true,
    request: JSON.stringify({
      method: "POST",
      url: "https://billing-sandbox.internal.example/v2/invoices/in_1/refunds",
      headers: {
        accept: "application/json",
        AUTHORIZATION: "Bearer test-token",
        "Proxy-Authorization": "Basic test-proxy",
        Cookie: "session=test-session",
        "X-Request-Source": "oxagen",
      },
      body: { amount: 1200 },
    }),
    raw: JSON.stringify({
      status: 201,
      headers: {
        "content-type": "application/json",
        "SET-COOKIE": "session=test-rotated",
      },
      body: { id: "re_1", status: "succeeded" },
    }),
    shaped: JSON.stringify({ id: "re_1", status: "succeeded" }),
  };
}

const EVERY_SECRET = ["test-token", "test-proxy", "test-session", "test-rotated"];

/** A call whose request carries one cookie header and nothing else to strip. */
function tryWithCookie(): TryResult {
  const clean = answered(tryClean());
  return {
    ...clean,
    request: JSON.stringify({
      method: "GET",
      url: "https://billing-sandbox.internal.example/v2/invoices",
      headers: { accept: "application/json", cookie: "session=test-session" },
      body: null,
    }),
  };
}

describe("TryTab environment", () => {
  it("starts on the agent environment and marks the sandbox", () => {
    renderTry(BILLING);
    expect(environmentSelect()).toHaveValue("sandbox");
    expect(optionsOf(environmentSelect())).toEqual([
      "sandbox (sandbox)",
      "production",
    ]);
    expect(screen.queryByTestId("studio-try-live")).toBeNull();
  });

  it("warns that production reaches the real service and sends the environment chosen", async () => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    choose(environmentSelect(), "production");
    const live = screen.getByTestId("studio-try-live");
    expect(live).toHaveTextContent("Live");
    expect(live).toHaveTextContent(
      "This environment is not a sandbox. The call reaches the real service.",
    );
    await runToPanes();
    expect(calls).toStrictEqual([
      {
        server: "billing",
        tool: "create_refund",
        environment: "production",
        arguments: {},
      },
    ]);
    choose(environmentSelect(), "sandbox");
    expect(screen.queryByTestId("studio-try-live")).toBeNull();
  });

  it("starts on the first sandbox when the record names no agent environment", () => {
    renderTry(BILLING, {
      environments: [...studioView(BILLING).environments].reverse(),
      agentEnvironment: null,
    });
    expect(optionsOf(environmentSelect())).toEqual([
      "production",
      "sandbox (sandbox)",
    ]);
    expect(environmentSelect()).toHaveValue("sandbox");
    expect(screen.queryByTestId("studio-try-live")).toBeNull();
  });

  it("starts on the first environment when none is a sandbox", () => {
    const live = [...studioView(BILLING).environments]
      .reverse()
      .map((env) => ({ ...env, sandbox: false }));
    renderTry(BILLING, { environments: live, agentEnvironment: null });
    expect(environmentSelect()).toHaveValue("production");
    expect(screen.getByTestId("studio-try-live")).toBeInTheDocument();
  });

  it("warns on a server whose one environment is not a sandbox", () => {
    renderTry(STRIPE);
    expect(environmentSelect()).toHaveValue("default");
    expect(optionsOf(environmentSelect())).toEqual(["default"]);
    expect(screen.getByTestId("studio-try-live")).toHaveTextContent(
      "This environment is not a sandbox. The call reaches the real service.",
    );
  });

  it("sends an empty environment name when the server lists no environment", async () => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(STRIPE, { environments: [], agentEnvironment: null, call });
    expect(optionsOf(environmentSelect())).toEqual([]);
    await runToPanes();
    expect(calls.map((input) => input.environment)).toEqual([""]);
  });
});

describe("TryTab tool and arguments", () => {
  it("offers only the imported tools and starts on the first", () => {
    renderTry(BILLING);
    expect(toolSelect()).toHaveValue("create_refund");
    expect(optionsOf(toolSelect())).toEqual(["create_refund", "list_invoices"]);
  });

  it("sends the tool chosen and the arguments typed, and no credential", async () => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    choose(toolSelect(), "list_invoices");
    typeArgs('{"status": "open", "limit": 5}');
    await runToPanes();
    expect(calls).toStrictEqual([
      {
        server: "billing",
        tool: "list_invoices",
        environment: "sandbox",
        arguments: { status: "open", limit: 5 },
      },
    ]);
    // The environment's vault reference stays with the gateway: the call
    // names the environment and nothing else about its credential.
    const references = studioView(BILLING).environments.flatMap((env) =>
      env.credential === null ? [] : [env.credential],
    );
    expect(references).toContain("oxagen:credential/billing-sandbox");
    const sent = JSON.stringify(calls);
    for (const reference of references) expect(sent).not.toContain(reference);
    expect(sent).not.toContain("oxagen:credential");
    expect(
      screen.getByText(
        "The call is recorded and metered like an agent's. The request shown omits the credential because the gateway adds it after recording.",
      ),
    ).toBeInTheDocument();
  });

  it("picks a tool from a server with 600 tools", async () => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(WAREHOUSE, { call });
    const offered = optionsOf(toolSelect());
    expect(offered).toHaveLength(WAREHOUSE_IMPORTED);
    expect(offered).toContain(warehouseTool(300));
    expect(offered).not.toContain(warehouseTool(301));
    choose(toolSelect(), warehouseTool(300));
    await runToPanes();
    expect(calls.map((input) => input.tool)).toEqual(["tool_300"]);
  });

  it.each([
    { what: "text that is not JSON", text: "limit: 5" },
    { what: "a JSON array", text: "[5]" },
    { what: "JSON null", text: "null" },
    { what: "a JSON number", text: "42" },
    { what: "a JSON string", text: '"open"' },
  ])("refuses $what as the arguments and makes no call", ({ text }) => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    typeArgs(text);
    run();
    expect(screen.getByTestId("studio-try-bad-json")).toHaveTextContent(
      "The arguments are not a JSON object.",
    );
    expect(argsField()).toHaveAttribute("aria-invalid", "true");
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("studio-try-request")).toBeNull();
  });

  it("clears the arguments error once the arguments are a JSON object", async () => {
    const { call, calls } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    typeArgs("{");
    run();
    expect(screen.getByTestId("studio-try-bad-json")).toBeInTheDocument();
    typeArgs('{"limit": 1}');
    await runToPanes();
    expect(screen.queryByTestId("studio-try-bad-json")).toBeNull();
    expect(argsField()).not.toHaveAttribute("aria-invalid");
    expect(calls.map((input) => input.arguments)).toEqual([{ limit: 1 }]);
  });
});

describe("TryTab call", () => {
  it("shows Running and ignores a second submit while the call is in flight", async () => {
    const { call, calls, settle } = pendingTry();
    renderTry(BILLING, { call });
    run();
    const running = screen.getByRole("button", { name: "Running" });
    expect(running).toHaveAttribute("aria-disabled", "true");
    // The button is aria-disabled, not disabled, so this click really submits.
    fireEvent.click(running);
    expect(calls).toHaveLength(1);
    expect(screen.queryByTestId("studio-try-request")).toBeNull();
    settle(tryClean());
    await screen.findByTestId("studio-try-request");
    expect(screen.getByRole("button", { name: "Run" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("draws the upstream request, the raw result and the shaped result", async () => {
    const clean = answered(tryClean());
    const { call } = fakeTry(clean);
    renderTry(BILLING, { call });
    await runToPanes();
    for (const [testId, title, code] of [
      ["studio-try-request", "Upstream request", clean.request],
      ["studio-try-raw", "Raw result", clean.raw],
      ["studio-try-shaped", "Shaped result", clean.shaped],
    ] as const) {
      const pane = screen.getByTestId(testId);
      expect(within(pane).getByRole("heading", { name: title, level: 3 })).toBeInTheDocument();
      expect(within(pane).getByRole("group", { name: title }).textContent).toBe(code);
    }
  });

  it("keeps Run off with a note while try_studio_tool has not merged", () => {
    renderTry(BILLING);
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-capability", "try_studio_tool");
    const note = screen.getByTestId("studio-try-pending");
    expect(button).toHaveAttribute("aria-describedby", note.id);
    expect(note).toHaveAttribute("data-state", "not-available");
    expect(note).toHaveAttribute("data-capability", "try_studio_tool");
    expect(note).toHaveAttribute("data-gap", "#4742");
    expect(note).toHaveTextContent("Testing is not available yet.");
    fireEvent.submit(button);
    expect(screen.queryByTestId("studio-try-request")).toBeNull();
    expect(screen.queryByTestId("studio-try-not-built")).toBeNull();
  });

  it("draws no note once the capability is available", () => {
    const { call } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("studio-try-pending")).toBeNull();
  });

  it("says testing is not available when the call answers not built", async () => {
    const { call } = fakeTry({ ok: false, reason: "not_built", gap: "capability" });
    renderTry(BILLING, { call });
    run();
    const note = await screen.findByTestId("studio-try-not-built");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveAttribute("data-state", "not-recorded");
    expect(note).toHaveAttribute("data-gap", "#4742");
    expect(note).toHaveTextContent("Testing is not available yet.");
    expect(screen.queryByTestId("studio-try-request")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as test" })).toBeNull();
  });

  it("shows a denied call with the policy's message and offers no save", async () => {
    const { call } = fakeTry({
      ok: false,
      reason: "denied",
      message: "Refunds wait for an approver.",
    });
    renderTry(BILLING, { call });
    run();
    expect(await screen.findByTestId("studio-try-denied")).toHaveTextContent(
      "The call was denied: Refunds wait for an approver.",
    );
    expect(screen.queryByTestId("studio-try-request")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as test" })).toBeNull();
  });

  it("shows a failed call, then clears it when the next call succeeds", async () => {
    const { call, calls } = fakeTry(
      { ok: false, reason: "failed", message: "The upstream answered 502." },
      tryClean(),
    );
    renderTry(BILLING, { call });
    run();
    expect(await screen.findByTestId("studio-try-failed")).toHaveTextContent(
      "The call failed: The upstream answered 502.",
    );
    expect(screen.queryByRole("button", { name: "Save as test" })).toBeNull();
    await runToPanes();
    expect(screen.queryByTestId("studio-try-failed")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("says the call did not finish when it throws, and lets the person run it again", async () => {
    const calls: TryInput[] = [];
    const call: TryStudioTool = {
      name: "try_studio_tool",
      available: true,
      gap: "capability",
      call: (input) => {
        calls.push(input);
        return Promise.reject(new Error("fetch failed: socket hang up"));
      },
    };
    renderTry(BILLING, { call });
    run();
    const error = await screen.findByTestId("studio-try-error");
    expect(error).toHaveTextContent("The call did not finish. Try again.");
    expect(error).not.toHaveTextContent("socket hang up");
    const again = screen.getByRole("button", { name: "Run" });
    expect(again).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("button", { name: "Save as test" })).toBeNull();
    fireEvent.click(again);
    await screen.findByTestId("studio-try-error");
    expect(calls).toHaveLength(2);
  });
});

describe("TryTab Save as test", () => {
  it("stages the test without its credential headers and says which it removed", async () => {
    const recorded = answered(tryWithCredentials());
    const { call } = fakeTry(recorded);
    renderTry(BILLING, { call });
    typeArgs('{"status": "open"}');
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByRole("status")).toHaveTextContent("Saved to the draft");
    expect(screen.getByTestId("studio-try-stripped")).toHaveTextContent(
      "Removed the authorization, set-cookie headers before saving, because a saved test never holds a credential.",
    );
    const test = onlySavedTest(draftKey("billing"));
    expect(test.tool).toBe("create_refund");
    expect(test.environment).toBe("sandbox");
    expect(test.args).toBe('{"status": "open"}');
    for (const text of [test.request, test.raw, test.shaped]) {
      expectNoCredential(text, ["test-token", "test-session"]);
    }
    expect(parseJson(test.request)).toEqual({
      method: "GET",
      url: "https://billing-sandbox.internal.example/v2/invoices",
      headers: { accept: "application/json", "X-Request-Source": "oxagen" },
      body: null,
    });
    expect(headersOf(test.raw)).toEqual({ "content-type": "application/json" });
    expect(test.shaped).toBe(recorded.shaped);
    expect(parseJson(test.shaped)).toEqual({ data: [{ id: "in_1", total: 1200 }] });
  });

  it("strips all four credential headers whatever their case", async () => {
    const { call } = fakeTry(tryWithEveryCredential());
    renderTry(BILLING, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByTestId("studio-try-stripped")).toHaveTextContent(
      "Removed the authorization, cookie, proxy-authorization, set-cookie headers before saving, because a saved test never holds a credential.",
    );
    const test = onlySavedTest(draftKey("billing"));
    for (const text of [test.request, test.raw, test.shaped]) {
      expectNoCredential(text, EVERY_SECRET);
    }
    expect(headersOf(test.request)).toEqual({
      accept: "application/json",
      "X-Request-Source": "oxagen",
    });
    expect(parseJson(test.raw)).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: { id: "re_1", status: "succeeded" },
    });
  });

  it("names a single removed header in the singular", async () => {
    const { call } = fakeTry(tryWithCookie());
    renderTry(BILLING, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByTestId("studio-try-stripped")).toHaveTextContent(
      "Removed the cookie header before saving, because a saved test never holds a credential.",
    );
    expectNoCredential(onlySavedTest(draftKey("billing")).request, ["test-session"]);
  });

  it("stages a clean call as it was recorded and says nothing was removed", async () => {
    const clean = answered(tryClean());
    const { call } = fakeTry(clean);
    renderTry(STRIPE, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByRole("status")).toHaveTextContent("Saved to the draft");
    expect(screen.queryByTestId("studio-try-stripped")).toBeNull();
    expect(onlySavedTest(draftKey("stripe"))).toStrictEqual({
      kind: "test",
      tool: "create_payment",
      environment: "default",
      args: "{}",
      request: clean.request,
      raw: clean.raw,
      shaped: clean.shaped,
    });
  });

  it("saves the call that ran, not the form as it stands after", async () => {
    const { call } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    typeArgs('{ "limit": 5 }');
    await runToPanes();
    choose(environmentSelect(), "production");
    choose(toolSelect(), "list_invoices");
    typeArgs("{}");
    fireEvent.click(saveButton());
    const test = onlySavedTest(draftKey("billing"));
    expect(test.environment).toBe("sandbox");
    expect(test.tool).toBe("create_refund");
    expect(test.args).toBe('{ "limit": 5 }');
  });

  it("saves one test per call, and one more after the next call", async () => {
    const { call } = fakeTry(tryClean());
    renderTry(BILLING, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    // The button is aria-disabled, not disabled, so this click really runs.
    fireEvent.click(saveButton());
    expect(savedTests(draftKey("billing"))).toHaveLength(1);
    run();
    const again = await screen.findByRole("button", { name: "Save as test" });
    expect(again).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("studio-try-saved")).toBeNull();
    fireEvent.click(again);
    expect(savedTests(draftKey("billing"))).toHaveLength(2);
  });

  it("keeps Run off when the record names no folder, since the call names the server by it", () => {
    expect(studioView(GITHUB).serverName).toBeNull();
    const { call, calls } = fakeTry(tryClean());
    renderTry(GITHUB, { call });
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeDisabled();
    const note = screen.getByTestId("studio-try-pending");
    expect(note).toHaveAttribute("data-gap", "#4678");
    expect(note).toHaveAttribute("data-capability", "try_studio_tool");
    fireEvent.submit(button);
    expect(calls).toEqual([]);
    expect(window.sessionStorage.getItem(idDraftKey(GITHUB))).toBeNull();
  });

  it.each([
    {
      what: "request is not JSON",
      result: { ...answered(tryClean()), request: "GET /v2/invoices" },
    },
    {
      what: "response is a JSON array",
      result: { ...answered(tryClean()), raw: "[]" },
    },
    {
      what: "shaped result is not JSON",
      result: { ...answered(tryClean()), shaped: "data: []" },
    },
  ])("does not save a call whose $what", async ({ result }) => {
    const { call } = fakeTry(result);
    renderTry(BILLING, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByTestId("studio-try-bad-record")).toHaveTextContent(
      "This call's record is not in the shape a saved test needs, so the test was not saved.",
    );
    expect(screen.queryByTestId("studio-try-saved")).toBeNull();
    expect(window.sessionStorage.getItem(draftKey("billing"))).toBeNull();
  });

  it("refuses the test when the draft already holds as many edits as a draft can", async () => {
    const clean = answered(tryClean());
    const stored: DraftOp = {
      kind: "test",
      tool: "list_invoices",
      environment: "sandbox",
      args: "{}",
      request: clean.request,
      raw: clean.raw,
      shaped: clean.shaped,
    };
    seedDraft(draftKey("billing"), {
      revision: 0,
      ops: Array.from({ length: DRAFT_LIMIT }, () => stored),
    });
    const { call } = fakeTry(clean);
    renderTry(BILLING, { call });
    await runToPanes();
    fireEvent.click(saveButton());
    expect(screen.getByTestId("studio-try-too-large")).toHaveTextContent(
      "The test was not saved. It is larger than a draft allows, or the draft is full.",
    );
    expect(screen.queryByTestId("studio-try-saved")).toBeNull();
    expect(saveButton()).not.toHaveAttribute("aria-disabled");
    expect(savedTests(draftKey("billing"))).toHaveLength(DRAFT_LIMIT);
  });

  it("offers no Save as test to a person who cannot edit", async () => {
    const { call } = fakeTry(tryClean());
    renderTry(BILLING, { call, canEdit: false });
    await runToPanes();
    expect(screen.getByTestId("studio-try-shaped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as test" })).toBeNull();
  });
});

describe("TryTab empty", () => {
  it("says there is nothing to try on a server with no tools", () => {
    renderTry(SCRATCH);
    const empty = screen.getByTestId("studio-try-empty");
    expect(
      within(empty).getByRole("heading", { name: "No imported tools" }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent("Import a tool on the Tools tab to try it here.");
    expect(screen.queryByTestId("studio-try")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("says the same when the server offers tools and none is imported", () => {
    renderTry(BILLING, { tools: [studioTool("void_invoice", { imported: false })] });
    expect(screen.getByTestId("studio-try-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-try")).toBeNull();
  });
});
