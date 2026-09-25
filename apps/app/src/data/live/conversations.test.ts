// The conversations port: one get_conversation read with no id, mapped into
// the thread the assistant flyout reopens, with a refusal passed through, an
// empty history read as null, and an unmappable record reported once.
import { conversationGet } from "@oxagen/oxagen/contracts/conversation.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { conversations } = await import("./conversations");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const CARD = {
  approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
  capability: "set_budget",
  expiresAt: "2026-09-25T10:05:00.000Z",
};

const message = (over: Record<string, unknown>) => ({
  publicId: "msg_a1",
  role: "user",
  content: "what is live?",
  createdAt: "2026-09-25T10:00:00.000Z",
  runId: null,
  parkedCards: [],
  toolCalls: [],
  ...over,
});

// The reply's calls as get_conversation reads them from its run: a read, and
// the write it parked on CARD's approval.
const CALLS = [
  {
    toolCallId: "tc-1",
    toolName: "get_budget",
    outcome: "completed",
    durationMs: 12,
    approvalId: null,
  },
  {
    toolCallId: "tc-2",
    toolName: "set_budget",
    outcome: "parked",
    durationMs: 88,
    approvalId: CARD.approvalId,
  },
];

const conversation = (messages: unknown[]) => ({
  publicId: "cnv_01k9x2",
  title: null,
  status: "active",
  archivedAt: null,
  createdAt: "2026-09-25T09:59:00.000Z",
  updatedAt: "2026-09-25T10:01:00.000Z",
  messages,
  truncated: false,
});

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("conversations.latest", () => {
  it("reads get_conversation with no id and maps each turn the flyout draws", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        conversation: conversation([
          message({}),
          message({ publicId: "msg_s1", role: "system", content: "rules" }),
          message({
            publicId: "msg_a2",
            role: "assistant",
            content: "One write waits on a person.",
            runId: "arun_0002",
            parkedCards: [CARD],
            toolCalls: CALLS,
          }),
        ]),
      }),
    );

    const read = await conversations.latest(ctx);

    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: conversationGet,
      input: { conversationId: null, limit: 100 },
      page: "shell",
    });
    // The model's own instruction is not a turn the person had.
    expect(read).toEqual(
      readOk({
        id: "cnv_01k9x2",
        messages: [
          {
            id: "msg_a1",
            role: "user",
            text: "what is live?",
            runId: null,
            parked: [],
            toolCalls: [],
          },
          {
            id: "msg_a2",
            role: "assistant",
            text: "One write waits on a person.",
            runId: "arun_0002",
            parked: [CARD],
            toolCalls: CALLS,
          },
        ],
        truncated: false,
      }),
    );
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers null when the viewer has no conversation yet", async () => {
    kernelRead.mockResolvedValue(readOk({ conversation: null }));
    await expect(conversations.latest(ctx)).resolves.toEqual(readOk(null));
  });

  it("passes a refusal through unchanged (negative)", async () => {
    const refused = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(refused);
    await expect(conversations.latest(ctx)).resolves.toBe(refused);
  });

  it("answers record_unmappable and reports once for a record the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        conversation: conversation([message({ publicId: "not a public id" })]),
      }),
    );
    await expect(conversations.latest(ctx)).resolves.toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("refuses a reply whose tool call names an outcome the flyout does not draw (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        conversation: conversation([
          message({
            publicId: "msg_a2",
            role: "assistant",
            runId: "arun_0002",
            toolCalls: [{ ...CALLS[0], outcome: "skipped" }],
          }),
        ]),
      }),
    );
    await expect(conversations.latest(ctx)).resolves.toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
