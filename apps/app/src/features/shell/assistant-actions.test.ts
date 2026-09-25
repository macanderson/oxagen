// The assistant turn through the real kernel seam: the viewer resolution and
// the kernel's invoke() are the only fakes, so each case shows what the person
// gets back and what ask_assistant was asked.
//
// `ask_assistant` is workspace-scoped, so the viewer this action resolves is a
// WsCtx. A turn run at organization scope would be refused by the kernel for
// want of a scope, which is why the flyout offers no composer outside one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { askAssistant, stopAssistantTurn } = await import("./assistant-actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const REPLY = {
  conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
  conversationPublicId: "cnv_01k9c0de",
  userMessageId: "6f1f5a8e-0000-4000-8000-00000000a111",
  assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a222",
  runId: "arun_01k9",
  reply: "Three runs are live.",
  parkedCards: [],
  stopped: false,
};

const TURN_ID = "0192d4a8-7c1e-7a00-8000-0000000000f1";

const onFleet = {
  conversationId: null,
  content: "what is live?",
  route: "fleet",
  entityId: null,
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("askAssistant", () => {
  it("resolves a workspace viewer, never an organization one", async () => {
    invoke.mockResolvedValue(REPLY);
    await askAssistant("acme", "core-platform", onFleet);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
  });

  it("takes the turn and answers with the reply the handler returned", async () => {
    invoke.mockResolvedValue(REPLY);
    const result = await askAssistant("acme", "core-platform", onFleet);
    expect(result).toEqual({ ok: true, value: REPLY });
    expect(invoke).toHaveBeenCalledWith(
      "ask_assistant",
      {
        conversationId: null,
        content: "what is live?",
        pageContext: {
          route: "fleet",
          orgSlug: "acme",
          workspaceSlug: "core-platform",
          entityId: null,
          entityLabel: null,
        },
      },
      expect.anything(),
    );
  });

  it("carries the page the question was asked from, so the agent is asked about what is on screen", async () => {
    invoke.mockResolvedValue(REPLY);
    await askAssistant("acme", "core-platform", {
      conversationId: null,
      content: "why did this fail?",
      route: "runs",
      entityId: "arun_01k9",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      pageContext: { route: "runs", entityId: "arun_01k9", entityLabel: null },
    });
  });

  // The Run page names its run, so a question asked there reaches the turn
  // with the title the person sees beside the id the agent can look up.
  it("forwards the label the page gave its record, beside the record's id", async () => {
    invoke.mockResolvedValue(REPLY);
    const result = await askAssistant("acme", "core-platform", {
      conversationId: null,
      content: "why did this fail?",
      route: "runs",
      entityId: "arun_01k9",
      entityLabel: "Fix the flaky checkout test",
    });
    expect(result).toEqual({ ok: true, value: REPLY });
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      conversationId: null,
      content: "why did this fail?",
      pageContext: {
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "core-platform",
        entityId: "arun_01k9",
        entityLabel: "Fix the flaky checkout test",
      },
    });
  });

  // The flyout cuts a long label before it sends one. A label that arrives
  // past the cap anyway is refused as invalid by the contract, before the
  // turn starts, rather than reaching the model.
  it("refuses a label past the contract's cap before the turn starts (negative)", async () => {
    const result = await askAssistant("acme", "core-platform", {
      conversationId: null,
      content: "why did this fail?",
      route: "runs",
      entityId: "arun_01k9",
      entityLabel: "x".repeat(257),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "pageContext.entityLabel",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends a null page context when the caller has no page", async () => {
    invoke.mockResolvedValue(REPLY);
    await askAssistant("acme", "core-platform", {
      conversationId: null,
      content: "hello",
      route: null,
      entityId: null,
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ pageContext: null });
  });

  it("continues an existing conversation when it is given one", async () => {
    invoke.mockResolvedValue(REPLY);
    await askAssistant("acme", "core-platform", {
      ...onFleet,
      conversationId: REPLY.conversationId,
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      conversationId: REPLY.conversationId,
    });
  });

  it("answers denied with nothing said, when the handler refuses (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "forbidden", reason: "not_a_member" }),
    );
    const result = await askAssistant("acme", "core-platform", onFleet);
    expect(result).toMatchObject({ ok: false, reason: "denied" });
  });

  // The flyout names each turn so its Stop control can reach it (#4164).
  it("names the turn with the id the flyout minted, so the turn can be stopped", async () => {
    invoke.mockResolvedValue(REPLY);
    await askAssistant("acme", "core-platform", {
      ...onFleet,
      turnId: TURN_ID,
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ turnId: TURN_ID });
  });

  it("hands back a stopped turn's partial reply with the stop marked", async () => {
    const stopped = { ...REPLY, reply: "Three runs", stopped: true };
    invoke.mockResolvedValue(stopped);
    const result = await askAssistant("acme", "core-platform", {
      ...onFleet,
      turnId: TURN_ID,
    });
    expect(result).toEqual({ ok: true, value: stopped });
  });
});

describe("stopAssistantTurn", () => {
  it("stops the viewer's own turn in the workspace, by the id it was asked under", async () => {
    invoke.mockResolvedValue({ turnId: TURN_ID, found: true });
    const result = await stopAssistantTurn("acme", "core-platform", TURN_ID);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "cancel_assistant_turn",
      { turnId: TURN_ID },
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: { turnId: TURN_ID, found: true },
    });
  });

  it("answers found false for a turn that is not running, not an error", async () => {
    invoke.mockResolvedValue({ turnId: TURN_ID, found: false });
    const result = await stopAssistantTurn("acme", "core-platform", TURN_ID);
    expect(result).toEqual({
      ok: true,
      value: { turnId: TURN_ID, found: false },
    });
  });

  it("refuses an id that is not a uuid before the kernel is asked (negative)", async () => {
    const result = await stopAssistantTurn("acme", "core-platform", "t1");
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers denied when the handler refuses the caller (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "forbidden", reason: "no_principal" }),
    );
    const result = await stopAssistantTurn("acme", "core-platform", TURN_ID);
    expect(result).toMatchObject({ ok: false, reason: "denied" });
  });
});
