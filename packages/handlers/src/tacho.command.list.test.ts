// list_commands: the delivery report reads the recorded status, derives
// `expired` only for a `queued` row past its expiry, fences the run the way
// get_run does, maps every column the report carries, names the issuer and a
// steer's text, and reads a broadcast's rows by their command ids.
import { describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import {
  type CommandRow,
  createListCommandsHandler,
  reportedStatus,
  toReportItem,
} from "./tacho.command.list";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RUN = "tse_0123456789abcdefghjkmn";
const LEDGER = "arun_5f0c2e9a1b7d4c3e8f6a02";

const CTX: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const ISSUER = "usr_0123456789abcdefghjkmn";

function row(over: Partial<CommandRow> = {}): CommandRow {
  return {
    publicId: "tcm_1",
    targetKind: "run",
    targetId: RUN,
    command: "steer",
    outcome: "applied",
    requestedMode: "interrupt",
    deliveryMode: "next_step",
    degradedReason: "harness_tier",
    reason: null,
    issuedAt: new Date("2026-09-14T09:00:00.000Z"),
    expiresAt: new Date("2026-09-14T10:00:00.000Z"),
    deliveredAt: new Date("2026-09-14T09:00:05.000Z"),
    acknowledgedAt: new Date("2026-09-14T09:00:09.000Z"),
    appliedAt: new Date("2026-09-14T09:00:09.000Z"),
    appliedAtSeq: 41,
    outcomeDetail: null,
    payloadText: "Run the migration tests before you push.",
    issuedByPublicId: ISSUER,
    issuedByName: "Ada Park",
    ...over,
  };
}

describe("reportedStatus", () => {
  it("reads expired for a queued row at or past its expiry, and the recorded status otherwise", () => {
    expect(
      reportedStatus(row({ outcome: "queued", expiresAt: NOW }), NOW),
    ).toBe("expired");
    expect(
      reportedStatus(
        row({ outcome: "queued", expiresAt: new Date(NOW.getTime() + 1) }),
        NOW,
      ),
    ).toBe("queued");
    expect(
      reportedStatus(row({ outcome: "queued", expiresAt: null }), NOW),
    ).toBe("queued");
    // A row the host holds reads as recorded past its expiry: the host
    // settles it, and the app reads `expiresAt` for the waiting state.
    for (const outcome of [
      "sent",
      "received",
      "acknowledged",
      "applied",
      "cancelled",
      "expired",
      "failed",
    ]) {
      expect(
        reportedStatus(
          row({ outcome, expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
          NOW,
        ),
      ).toBe(outcome);
    }
  });
});

describe("toReportItem", () => {
  it("carries every column, timestamps as RFC 3339, and validates against the contract", () => {
    const item = toReportItem(row(), NOW);
    expect(item).toEqual({
      id: "tcm_1",
      runId: RUN,
      agentKey: null,
      command: "steer",
      status: "applied",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
      reason: null,
      issuedAt: "2026-09-14T09:00:00.000Z",
      expiresAt: "2026-09-14T10:00:00.000Z",
      sentAt: "2026-09-14T09:00:05.000Z",
      acknowledgedAt: "2026-09-14T09:00:09.000Z",
      appliedAt: "2026-09-14T09:00:09.000Z",
      appliedAtSeq: 41,
      detail: null,
      issuedBy: { id: ISSUER, name: "Ada Park" },
      text: "Run the migration tests before you push.",
    });
    expect(
      tachoCommandList.output.safeParse({ commands: [item] }).success,
    ).toBe(true);
    const queued = toReportItem(
      row({
        command: "pause",
        outcome: "queued",
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        reason: "budget review",
        expiresAt: null,
        deliveredAt: null,
        acknowledgedAt: null,
        appliedAt: null,
        appliedAtSeq: null,
        payloadText: null,
      }),
      NOW,
    );
    expect(queued).toMatchObject({
      status: "queued",
      reason: "budget review",
      sentAt: null,
      appliedAtSeq: null,
      text: null,
    });
  });

  it("names the agent of a steer held for its next run in place of a run, and validates against the contract", () => {
    const held = toReportItem(
      row({
        targetKind: "agent",
        targetId: "acme.core.reviewer",
        outcome: "queued",
        deliveryMode: null,
        degradedReason: null,
        deliveredAt: null,
        acknowledgedAt: null,
        appliedAt: null,
        appliedAtSeq: null,
      }),
      new Date("2026-09-14T09:30:00.000Z"),
    );
    expect(held).toMatchObject({
      runId: null,
      agentKey: "acme.core.reviewer",
      status: "queued",
      text: "Run the migration tests before you push.",
    });
    expect(
      tachoCommandList.output.safeParse({ commands: [held] }).success,
    ).toBe(true);
  });

  it("names the issuer, and reads a blank name as none and a row with no user as no issuer", () => {
    expect(toReportItem(row({ issuedByName: "  " }), NOW).issuedBy).toEqual({
      id: ISSUER,
      name: null,
    });
    expect(toReportItem(row({ issuedByName: null }), NOW).issuedBy).toEqual({
      id: ISSUER,
      name: null,
    });
    expect(
      toReportItem(
        row({ issuedByPublicId: null, issuedByName: null }),
        NOW,
      ).issuedBy,
    ).toBeNull();
  });

  it("carries the text on a steer and a message only, whatever another command's payload holds", () => {
    expect(toReportItem(row({ command: "message" }), NOW).text).toBe(
      "Run the migration tests before you push.",
    );
    // A pause's payload holds its address, never text; a stray `text` on any
    // command that carries no prompt content is not what the report quotes.
    for (const command of ["pause", "resume", "cancel", "kill"]) {
      expect(
        toReportItem(row({ command, payloadText: "stray" }), NOW).text,
      ).toBeNull();
    }
    expect(toReportItem(row({ payloadText: null }), NOW).text).toBeNull();
  });
});

function handlerOver(args: {
  tacho: string[];
  ledger: Array<{ publicId: string; runId: string; inWorkspace: boolean }>;
  rows: CommandRow[];
}) {
  const commandsForRun = vi.fn(async () => args.rows);
  const commandsByIds = vi.fn(async () => args.rows);
  const handler = createListCommandsHandler({
    queries: {
      tachoSession: async (_scope, id) =>
        args.tacho.includes(id) ? ({} as never) : null,
      ledgerIdentity: async (_scope, runId) =>
        args.ledger.some((r) => r.runId === runId && r.inWorkspace)
          ? ({} as never)
          : null,
    },
    store: {
      getRunByPublicId: async (id) => {
        const run = args.ledger.find((r) => r.publicId === id);
        return run ? ({ runId: run.runId } as never) : null;
      },
    },
    commandsForRun,
    commandsByIds,
    now: () => NOW,
  });
  return { handler, commandsForRun, commandsByIds };
}

describe("list_commands handler", () => {
  it("answers the run's rows newest first, as the store returns them, with the limit passed through", async () => {
    const { handler, commandsForRun } = handlerOver({
      tacho: [RUN],
      ledger: [],
      rows: [row({ publicId: "tcm_2" }), row({ publicId: "tcm_1" })],
    });
    const output = await handler(
      tachoCommandList.input.parse({ runId: RUN, limit: 2 }),
      CTX,
    );
    expect(output.commands.map((c) => c.id)).toEqual(["tcm_2", "tcm_1"]);
    expect(commandsForRun).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId },
      RUN,
      2,
    );
  });

  it("reports a ledger run's rows when the ledger holds it in this workspace", async () => {
    const { handler } = handlerOver({
      tacho: [],
      ledger: [{ publicId: LEDGER, runId: "r1", inWorkspace: true }],
      rows: [],
    });
    expect(
      (await handler(tachoCommandList.input.parse({ runId: LEDGER }), CTX))
        .commands,
    ).toEqual([]);
  });

  it("is not_found for an unknown wrapped run, an unknown ledger run, and a ledger run in another workspace (negative)", async () => {
    const notFound = (e: unknown) =>
      isHandlerError(e) &&
      e.code === "not_found" &&
      e.reason === "run_not_found";
    const { handler, commandsForRun } = handlerOver({
      tacho: [],
      ledger: [{ publicId: LEDGER, runId: "r1", inWorkspace: false }],
      rows: [row()],
    });
    await expect(
      handler(tachoCommandList.input.parse({ runId: RUN }), CTX),
    ).rejects.toSatisfy(notFound);
    await expect(
      handler(tachoCommandList.input.parse({ runId: LEDGER }), CTX),
    ).rejects.toSatisfy(notFound);
    await expect(
      handler(
        tachoCommandList.input.parse({ runId: "arun_9999999999999999999999" }),
        CTX,
      ),
    ).rejects.toSatisfy(notFound);
    expect(commandsForRun).not.toHaveBeenCalled();
  });
});

describe("list_commands by command ids", () => {
  it("reads the rows the ids name, once each, with the limit passed through, and fences no run", async () => {
    const other = "tse_9zzzzzzzzzzzzzzzzzzzzz";
    const { handler, commandsForRun, commandsByIds } = handlerOver({
      tacho: [],
      ledger: [],
      rows: [
        row({ publicId: "tcm_2", targetId: other }),
        row({ publicId: "tcm_1" }),
      ],
    });
    const output = await handler(
      tachoCommandList.input.parse({
        commandIds: ["tcm_1", "tcm_2", "tcm_1"],
        limit: 2,
      }),
      CTX,
    );
    expect(output.commands.map((c) => [c.id, c.runId])).toEqual([
      ["tcm_2", other],
      ["tcm_1", RUN],
    ]);
    expect(commandsByIds).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId },
      ["tcm_1", "tcm_2"],
      2,
    );
    expect(commandsForRun).not.toHaveBeenCalled();
    expect(tachoCommandList.output.safeParse(output).success).toBe(true);
  });

  it("refuses a read that names both a run and command ids, or neither, as run_or_commands (negative)", async () => {
    const { handler, commandsForRun, commandsByIds } = handlerOver({
      tacho: [RUN],
      ledger: [],
      rows: [row()],
    });
    const refused = (e: unknown) =>
      e instanceof CapabilityError &&
      e.code === "invalid_input" &&
      e.message === "run_or_commands";
    await expect(
      handler(
        tachoCommandList.input.parse({ runId: RUN, commandIds: ["tcm_1"] }),
        CTX,
      ),
    ).rejects.toSatisfy(refused);
    await expect(
      handler(tachoCommandList.input.parse({}), CTX),
    ).rejects.toSatisfy(refused);
    expect(commandsForRun).not.toHaveBeenCalled();
    expect(commandsByIds).not.toHaveBeenCalled();
  });
});
