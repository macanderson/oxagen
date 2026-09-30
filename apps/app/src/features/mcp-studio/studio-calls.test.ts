// Studio's calls beyond the draft and Review (#4678, part 3): each binds one
// capability to the page's workspace through Studio's server actions. The
// actions are the only fakes. Each case shows what a screen reads back: the
// output with `ok: true` on success, and a refusal as one code. Try it and
// Draft read a refusal as the message the tab prints, and Try it keeps the
// handler's own denial and failure.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_AT } from "./studio.builders";
import {
  draftStudioDescription,
  getStudioDiscovery,
  listStudioFindings,
  listStudioTools,
  setMcpCredential,
  startStudioDiscovery,
  tryStudioTool,
} from "./studio-calls";

const actions = vi.hoisted(() => ({
  saveStudioDraftAction: vi.fn(),
  saveNewStudioServerAction: vi.fn(),
  getStudioDraftAction: vi.fn(),
  openStudioReviewAction: vi.fn(),
  startStudioDiscoveryAction: vi.fn(),
  getStudioDiscoveryAction: vi.fn(),
  listStudioToolsAction: vi.fn(),
  tryStudioToolAction: vi.fn(),
  draftStudioDescriptionAction: vi.fn(),
  listStudioFindingsAction: vi.fn(),
  setMcpCredentialAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});

/** A refusal that names the handler's reason. */
const NOT_FOUND = {
  ok: false,
  reason: "not_found",
  code: "server_not_found",
} as const;

/** A refusal whose code is its kind: the role gate names no reason the tab shows. */
const DENIED = { ok: false, reason: "denied", code: "tool.studio" } as const;

/** A refusal for spend: the tab names the kind. */
const EXHAUSTED = {
  ok: false,
  reason: "exhausted",
  code: "gau_exhausted",
} as const;

const DISCOVERY = {
  id: "3f1c2b9a-0d4e-4c8b-9a7f-1e2d3c4b5a69",
  server: "billing",
  status: "queued",
};

describe("the server reads", () => {
  it.each([
    {
      name: "start_studio_discovery",
      call: () => startStudioDiscovery.call(STUDIO_AT, { server: "billing" }),
      action: actions.startStudioDiscoveryAction,
      value: { discovery: DISCOVERY },
    },
    {
      name: "get_studio_discovery",
      call: () => getStudioDiscovery.call(STUDIO_AT, { server: "billing" }),
      action: actions.getStudioDiscoveryAction,
      value: { discovery: null },
    },
    {
      name: "list_studio_tools",
      call: () => listStudioTools.call(STUDIO_AT, { server: "billing" }),
      action: actions.listStudioToolsAction,
      value: { server: "billing", imported: 2, offered: 5, tools: [] },
    },
    {
      name: "list_studio_findings",
      call: () => listStudioFindings.call(STUDIO_AT, { server: "billing" }),
      action: actions.listStudioFindingsAction,
      value: {
        server: "billing",
        basis: "draft",
        revision: 3,
        tokens: { definitions: 1200, budget: 8000 },
        findings: [],
      },
    },
  ])("$name answers its output for the page's workspace", async ({ call, action, value }) => {
    action.mockResolvedValue({ ok: true, value });
    expect(await call()).toEqual({ ok: true, ...value });
    expect(action).toHaveBeenCalledWith(STUDIO_AT.org, STUDIO_AT.ws, "billing");
  });

  it.each([
    { refusal: NOT_FOUND, code: "server_not_found" },
    { refusal: DENIED, code: "denied" },
  ])("reads a refusal as the code $code", async ({ refusal, code }) => {
    actions.listStudioFindingsAction.mockResolvedValue(refusal);
    actions.getStudioDiscoveryAction.mockResolvedValue(refusal);
    const expected = { ok: false, reason: "failed", code };
    expect(
      await listStudioFindings.call(STUDIO_AT, { server: "billing" }),
    ).toEqual(expected);
    expect(
      await getStudioDiscovery.call(STUDIO_AT, { server: "billing" }),
    ).toEqual(expected);
  });
});

describe("set_mcp_credential", () => {
  it("sends the form's input and answers the reference", async () => {
    // Joined at run time, so no secret-shaped literal reaches the repository.
    const secret = ["sk", "test", "9a8b7c"].join("_");
    const stored = {
      name: "stripe-restricted",
      reference: "oxagen:credential/stripe-restricted",
      created: true,
    };
    actions.setMcpCredentialAction.mockResolvedValue({ ok: true, value: stored });
    const input = { name: "stripe-restricted", kind: "secret", secret } as const;
    expect(await setMcpCredential.call(STUDIO_AT, input)).toEqual({
      ok: true,
      ...stored,
    });
    expect(actions.setMcpCredentialAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      input,
    );
  });

  it("reads the role gate's refusal as its kind", async () => {
    actions.setMcpCredentialAction.mockResolvedValue(DENIED);
    expect(
      await setMcpCredential.call(STUDIO_AT, {
        name: "stripe-restricted",
        kind: "oauth_client",
        clientId: "client",
        clientSecret: "value",
      }),
    ).toEqual({ ok: false, reason: "failed", code: "denied" });
  });
});

describe("try_studio_tool", () => {
  const INPUT = {
    server: "billing",
    tool: "list_invoices",
    environment: "sandbox",
    arguments: { limit: 5 },
  };

  it("sends the call and keeps the three panes of an answer", async () => {
    actions.tryStudioToolAction.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        server: "billing",
        tool: "billing__list_invoices",
        environment: "sandbox",
        agent: "billing-agent",
        request: '{"method":"GET"}',
        raw: '{"data":[]}',
        shaped: "[]",
        exchanges: 1,
        cut: [],
      },
    });
    expect(await tryStudioTool.call(STUDIO_AT, INPUT)).toEqual({
      ok: true,
      request: '{"method":"GET"}',
      raw: '{"data":[]}',
      shaped: "[]",
    });
    expect(actions.tryStudioToolAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      INPUT,
    );
  });

  it.each([
    { reason: "denied", message: "Refunds wait for an approver." },
    { reason: "failed", message: "The upstream answered 502." },
  ] as const)("keeps the handler's $reason answer and its message", async ({ reason, message }) => {
    actions.tryStudioToolAction.mockResolvedValue({
      ok: true,
      value: { ok: false, reason, message, request: "{}", raw: "{}" },
    });
    expect(await tryStudioTool.call(STUDIO_AT, INPUT)).toEqual({
      ok: false,
      reason,
      message,
    });
  });

  it("reads an action that was refused before the call as failed, with its code", async () => {
    actions.tryStudioToolAction.mockResolvedValue(EXHAUSTED);
    expect(await tryStudioTool.call(STUDIO_AT, INPUT)).toEqual({
      ok: false,
      reason: "failed",
      message: "exhausted",
    });
  });
});

describe("draft_studio_description", () => {
  it("answers the suggestion", async () => {
    actions.draftStudioDescriptionAction.mockResolvedValue({
      ok: true,
      value: {
        server: "billing",
        tool: "list_invoices",
        description: "List the invoices of one customer.",
      },
    });
    expect(
      await draftStudioDescription.call(STUDIO_AT, {
        server: "billing",
        tool: "list_invoices",
      }),
    ).toEqual({ ok: true, description: "List the invoices of one customer." });
    expect(actions.draftStudioDescriptionAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      { server: "billing", tool: "list_invoices" },
    );
  });

  it("reads a refusal as failed, with its code as the message", async () => {
    actions.draftStudioDescriptionAction.mockResolvedValue(EXHAUSTED);
    expect(
      await draftStudioDescription.call(STUDIO_AT, {
        server: "billing",
        tool: "list_invoices",
      }),
    ).toEqual({ ok: false, reason: "failed", message: "exhausted" });
  });
});
