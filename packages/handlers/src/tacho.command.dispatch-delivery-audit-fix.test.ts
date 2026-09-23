// dispatch_command: what a recipient can actually be given. A Stella run
// reads text only at its one SessionStart, which a live run is past, so a
// steer or message to it is refused (direct) or recorded `failed` (broadcast).
// And `interrupt` is not reported achieved on a tier whose proxy can cut a
// call but cannot put the steer into the next request.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: vi.fn(() => Promise.resolve()),
  resolveActingUserId: vi.fn((ctx: CapabilityContext) =>
    Promise.resolve(ctx.userId),
  ),
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  type CommandRowInput,
  type CommandStore,
  createDispatchCommandHandler,
  type RecipientSession,
  resolveDeliveryMode,
} from "./tacho.command.dispatch";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-14T10:00:00.000Z");

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: "00000000-0000-4000-8000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

function session(over: Partial<RecipientSession> = {}): RecipientSession {
  return {
    id: "s1",
    publicId: "tse_0123456789abcdefghjkmn",
    sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
    hostId: "11111111-1111-4111-8111-111111111111",
    agentKey: "acme.core.cc-laptop",
    outcome: "running",
    enforcementTier: "harness",
    harness: "claude-code",
    ...over,
  };
}

const STELLA = session({
  id: "s2",
  publicId: "tse_1123456789abcdefghjkmn",
  sessionUuid: "4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
  agentKey: "acme.core.stella",
  harness: "stella",
});

class MemoryStore implements CommandStore {
  rows: CommandRowInput[] = [];
  constructor(readonly sessions: RecipientSession[]) {}
  async session(_scope: unknown, publicId: string) {
    return this.sessions.find((s) => s.publicId === publicId) ?? null;
  }
  async liveSessions() {
    return this.sessions.filter((s) => s.outcome === "running");
  }
  async ledgerRunExists() {
    return false;
  }
  async setLedgerPaused(): Promise<string> {
    throw new Error("not used");
  }
  async cancelLedgerRun(): Promise<string> {
    throw new Error("not used");
  }
  async insert(row: CommandRowInput) {
    this.rows.push(row);
    return { publicId: `tcm_${this.rows.length}` };
  }
  async supersede() {
    return 0;
  }
}

const handlerOver = (store: CommandStore) =>
  createDispatchCommandHandler({
    withStore: (fn) => fn(store),
    now: () => NOW,
  });
const parse = (input: unknown) => tachoCommandDispatch.input.parse(input);
const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prompt commands to a Stella run", () => {
  it.each(["steer", "message"])(
    "refuses a %s addressed to a Stella run directly",
    async (command) => {
      const store = new MemoryStore([STELLA]);
      await expect(
        handlerOver(store)(
          parse({
            target: { kind: "run", id: STELLA.publicId },
            command,
            payload: { text: "Wrap up." },
          }),
          OPERATOR,
        ),
      ).rejects.toSatisfy(conflict("no_text_channel"));
      expect(store.rows).toEqual([]);
    },
  );

  it("records a broadcast's Stella recipient as failed and queues the rest", async () => {
    const store = new MemoryStore([session(), STELLA]);
    const { commandIds } = await handlerOver(store)(
      parse({
        target: { kind: "workspace", id: WORKSPACE },
        command: "steer",
        payload: { text: "Wrap up." },
      }),
      OPERATOR,
    );
    expect(commandIds).toHaveLength(2);
    expect(
      store.rows.map((r) => [
        r.session.harness,
        r.outcome,
        r.outcomeDetail,
        r.deliveryMode,
      ]),
    ).toEqual([
      ["claude-code", "queued", null, "next_step"],
      ["stella", "failed", "no_text_channel", null],
    ]);
  });

  it("still carries pause, resume and cancel to a Stella run", async () => {
    for (const command of ["pause", "resume", "cancel"]) {
      const store = new MemoryStore([STELLA]);
      await handlerOver(store)(
        parse({ target: { kind: "run", id: STELLA.publicId }, command }),
        OPERATOR,
      );
      expect(store.rows[0]).toMatchObject({ outcome: "queued" });
    }
  });
});

describe("interrupt", () => {
  it("degrades to next_step on every tier until the proxy can inject", () => {
    for (const tier of ["gateway", "contained"]) {
      expect(resolveDeliveryMode("interrupt", tier)).toEqual({
        deliveryMode: "next_step",
        degradedReason: "no_mid_step_injection",
      });
    }
    expect(resolveDeliveryMode("interrupt", "harness")).toEqual({
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
    expect(resolveDeliveryMode("next_step", "gateway")).toEqual({
      deliveryMode: "next_step",
      degradedReason: null,
    });
    expect(resolveDeliveryMode("turn_boundary", "gateway")).toEqual({
      deliveryMode: "turn_boundary",
      degradedReason: null,
    });
  });

  it("records both modes and the degradation on a gateway run's row", async () => {
    const store = new MemoryStore([session({ enforcementTier: "gateway" })]);
    await handlerOver(store)(
      parse({
        target: { kind: "run", id: session().publicId },
        command: "steer",
        payload: { text: "Stop now.", requestedMode: "interrupt" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      outcome: "queued",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "no_mid_step_injection",
    });
  });
});

describe("steer text", () => {
  it("is refused past 8,000 characters", () => {
    expect(() =>
      parse({
        target: { kind: "run", id: session().publicId },
        command: "steer",
        payload: { text: "x".repeat(8_001) },
      }),
    ).toThrow();
    expect(
      parse({
        target: { kind: "run", id: session().publicId },
        command: "steer",
        payload: { text: "x".repeat(8_000) },
      }).payload?.text,
    ).toHaveLength(8_000);
  });
});
