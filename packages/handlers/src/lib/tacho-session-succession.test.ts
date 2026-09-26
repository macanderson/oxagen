import {
  type ChainCursor,
  GENESIS_CURSOR,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import {
  type SuccessionHost,
  continuesRecordedChain,
  succeedsHost,
} from "./tacho-session-succession";

const PREDECESSOR: SuccessionHost = {
  id: "44444444-4444-4444-8444-444444444444",
  publicId: "tch_predecessor00000000000",
  status: "revoked",
  orgId: "org-1",
  workspaceId: "ws-1",
  deviceKeyFingerprint: `sha256:${"d".repeat(64)}`,
  agentKey: "acme.core.cc-laptop",
};

const HOST: SuccessionHost = {
  ...PREDECESSOR,
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "tch_0123456789abcdefghjkmn",
  status: "active",
};

describe("succeedsHost", () => {
  it("accepts a later enrollment of the same device key in the same workspace", () => {
    expect(succeedsHost(PREDECESSOR, HOST)).toBe(true);
  });

  it.each([
    ["the predecessor is still live", { status: "active" }],
    ["the predecessor is the host itself", { id: HOST.id }],
    ["the device key differs", { deviceKeyFingerprint: "sha256:other" }],
    ["the workspace differs", { workspaceId: "ws-2" }],
    ["the organization differs", { orgId: "org-2" }],
  ])("refuses when %s", (_, overrides) => {
    expect(succeedsHost({ ...PREDECESSOR, ...overrides }, HOST)).toBe(false);
  });
});

function chain(length: number): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (let i = 0; i < length; i++) {
    const sealed = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: "00000000-0000-4000-8000-000000000001",
        root_session_uuid: "00000000-0000-4000-8000-000000000001",
        ts: "2026-09-24T10:00:00.000Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: "acme.core.laptop",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.2",
          host_enrollment_id: HOST.publicId,
        },
        context: { cwd: "/home/dev/proj", permission_mode: "default" },
        ...(i === 0
          ? {
              kind: "agent_start",
              body: { session_start_source: "startup", tools_available: [] },
            }
          : { kind: "turn_start", body: { prompt_length: i } }),
      } as unknown as UnsealedTachoEvent,
      cursor,
    );
    cursor = sealed.next;
    out.push(sealed.event);
  }
  return out;
}

describe("continuesRecordedChain", () => {
  const events = chain(5);
  const recorded = { seqCount: 3, lastHash: events[2]?.hash ?? null };

  it("accepts a batch whose first new frame links to the recorded head", () => {
    expect(continuesRecordedChain(recorded, events.slice(3))).toBe(true);
  });

  it("accepts a batch that re-sends recorded frames before the new ones", () => {
    expect(continuesRecordedChain(recorded, events.slice(1))).toBe(true);
  });

  it("refuses a batch that links to another head", () => {
    expect(
      continuesRecordedChain(
        { seqCount: 3, lastHash: `sha256:${"f".repeat(64)}` },
        events.slice(3),
      ),
    ).toBe(false);
  });

  it("refuses a batch that leaves a gap after the recorded head", () => {
    expect(continuesRecordedChain(recorded, events.slice(4))).toBe(false);
  });

  it("refuses a batch whose own chain does not verify", () => {
    const tampered = events
      .slice(3)
      .map((event, i) =>
        i === 1 ? { ...event, prev_hash: `sha256:${"a".repeat(64)}` } : event,
      );
    expect(continuesRecordedChain(recorded, tampered)).toBe(false);
  });

  it("refuses an empty batch", () => {
    expect(continuesRecordedChain(recorded, [])).toBe(false);
  });
});
