// The pause state (#3972): which rows make a run pausing, paused or resuming,
// in the order `appliedHaltIsPause` reads them, and the one ClickHouse read
// that counts the turn and step at the pause frame.
import { tachoEventsColumns } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickhousePausePosition,
  type PauseCommandRow,
  pauseStateOf,
} from "./run-pause";

const chSelect = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/telemetry", async (original) => ({
  ...(await original<typeof import("@oxagen/telemetry")>()),
  chSelect,
}));

const NOW = new Date("2026-09-11T10:00:00.000Z");
const at = (minute: number) =>
  new Date(`2026-09-11T09:${String(minute).padStart(2, "0")}:00.000Z`);

function row(over: Partial<PauseCommandRow>): PauseCommandRow {
  return {
    publicId: "tcm_1",
    command: "pause",
    outcome: "applied",
    reason: null,
    issuedAt: at(1),
    expiresAt: null,
    appliedAt: at(2),
    appliedAtSeq: 10,
    issuedByPublicId: null,
    issuedByName: null,
    ...over,
  };
}

describe("pauseStateOf", () => {
  it("names the last pause the host applied, in applied order, as the pause in force", () => {
    const older = row({ publicId: "tcm_old", appliedAt: at(2) });
    const newer = row({
      publicId: "tcm_new",
      issuedAt: at(5),
      appliedAt: at(6),
    });
    expect(pauseStateOf([older, newer], true, NOW)).toEqual({
      state: "paused",
      pause: newer,
      resume: null,
    });
  });

  it("reads a resume issued before the pause in force as no resume on its way (negative)", () => {
    const pause = row({ issuedAt: at(5), appliedAt: at(6) });
    const stale = row({
      publicId: "tcm_resume",
      command: "resume",
      outcome: "sent",
      issuedAt: at(3),
      appliedAt: null,
    });
    expect(pauseStateOf([stale, pause], true, NOW)?.state).toBe("paused");
  });

  it("reads a pause issued before the last applied resume as no pause on its way (negative)", () => {
    const resume = row({
      publicId: "tcm_resume",
      command: "resume",
      issuedAt: at(5),
      appliedAt: at(6),
    });
    const stale = row({
      publicId: "tcm_pause",
      outcome: "acknowledged",
      issuedAt: at(3),
      appliedAt: null,
    });
    expect(pauseStateOf([resume, stale], false, NOW)).toBeNull();
  });

  it("reads a pause the host holds past its expiry as on its way, and a queued one past it as not", () => {
    const held = row({
      outcome: "sent",
      expiresAt: at(30),
      appliedAt: null,
    });
    expect(pauseStateOf([held], false, NOW)?.state).toBe("pausing");
    const queued = row({ outcome: "queued", expiresAt: at(30), appliedAt: null });
    expect(pauseStateOf([queued], false, NOW)).toBeNull();
  });

  it("reads a held run whose rows name no applied pause as no pause (negative)", () => {
    expect(pauseStateOf([], true, NOW)).toBeNull();
    expect(
      pauseStateOf(
        [row({ outcome: "queued", appliedAt: null, appliedAtSeq: null })],
        true,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("clickhousePausePosition", () => {
  beforeEach(() => {
    chSelect.mockReset();
  });

  it("counts turns and steps on one chain up to the frame, under the header's rules", async () => {
    chSelect.mockResolvedValue({
      data: [{ turns: "3", model_calls: "5", tool_calls: "7" }],
    });
    const SESSION = "0192d4a8-7c1e-7a00-8000-00000000c0de";
    expect(await clickhousePausePosition(SESSION, 41)).toEqual({
      turn: 3,
      step: 12,
    });
    const [call] = chSelect.mock.calls;
    const q = call?.[0] as { query: string; params: Record<string, unknown> };
    expect(q.query).toContain("session_uuid = {sessionUuid:UUID}");
    expect(q.query).toContain("seq <= {seq:UInt64}");
    expect(q.query).toContain("countIf(kind = 'turn_start')");
    expect(q.params).toMatchObject({ sessionUuid: SESSION, seq: 41 });
    // A ClickHouse alias applies to the whole query, so none may shadow a
    // column the counts read (see run-work.test.ts, code 184).
    const columns = new Set(tachoEventsColumns().map(({ name }) => name));
    const aliases = [...q.query.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)].map(
      (match) => match[1] ?? "",
    );
    expect(aliases).toEqual(["turns", "model_calls", "tool_calls"]);
    expect(aliases.filter((alias) => columns.has(alias))).toEqual([]);
  });

  it("answers null for a turn or a step none was counted for", async () => {
    chSelect.mockResolvedValue({
      data: [{ turns: 0, model_calls: 0, tool_calls: 0 }],
    });
    expect(await clickhousePausePosition("s", 0)).toEqual({
      turn: null,
      step: null,
    });
    chSelect.mockResolvedValue({ data: [] });
    expect(await clickhousePausePosition("s", 0)).toEqual({
      turn: null,
      step: null,
    });
  });
});
