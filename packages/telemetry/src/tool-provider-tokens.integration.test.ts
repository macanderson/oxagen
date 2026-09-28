import { randomUUID } from "node:crypto";
import {
  GENESIS_CURSOR,
  sealEvent,
  sessionUuid,
  type TachoEvent,
  type UnsealedTachoEvent,
} from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { insertTachoEvents } from "./tacho-events";
import { selectToolProviderTokens } from "./tool-provider-tokens";

// CI migrates ClickHouse before the unit job, so `tacho_events` exists with
// every migration applied. Missing configuration skips local collection.
// This is the witness that the read's SQL runs on the server, through the
// tenant rewrite, against the stored part list (#4537).

const DIGEST = `sha256:${"c".repeat(64)}`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Part = {
  kind: "system" | "tool";
  name: string;
  provider?: string;
  tokens: number;
};

/** A tool part `provider` serves, as the recorder lists it. */
function tool(provider: string, name: string, tokens: number): Part {
  return { kind: "tool", name, provider, tokens };
}

/** One `llm_call` frame on `session` at `ts` that lists `parts`. */
function listing(
  session: string,
  ts: string,
  parts: readonly Part[],
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "witness",
    session_uuid: session,
    root_session_uuid: session,
    ts,
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.witness",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
    },
    attrs: {},
    kind: "llm_call",
    body: {
      model: "claude-sonnet-5",
      input_tokens: 10,
      output_tokens: 5,
      system_context_digest: DIGEST,
      system_context_parts: parts.map((part) => ({ ...part, digest: DIGEST })),
    },
  } satisfies UnsealedTachoEvent;
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "tool provider tokens against a live store",
  () => {
    it("sums each listing's tool parts per provider and keeps the newest listing in the window", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const now = Date.now();
      const at = (ms: number) => new Date(ms).toISOString();
      const frames = [
        // Before the window: its count must not reach the result.
        listing(session, at(now - 8 * DAY_MS), [
          tool("github", "mcp__github__a", 99_999),
        ]),
        // The older listing in the window: linear's newest, github's oldest.
        listing(session, at(now - 2 * HOUR_MS), [
          { kind: "system", name: "system", tokens: 5_000 },
          tool("github", "mcp__github__a", 3_000),
          tool("github", "mcp__github__b", 2_200),
          tool("linear", "mcp__linear__a", 800),
        ]),
        // The newest listing: github dropped a tool, and a builtin appears.
        listing(session, at(now - HOUR_MS), [
          tool("github", "mcp__github__a", 4_000),
          tool("builtin", "Read", 600),
        ]),
      ];
      const events: TachoEvent[] = [];
      let cursor = GENESIS_CURSOR;
      for (const frame of frames) {
        const sealed = sealEvent(frame, cursor);
        events.push(sealed.event);
        cursor = sealed.next;
      }

      const rows = await runInTenantScope({ orgId, workspaceId }, async () => {
        await insertTachoEvents(
          events.map((event) => ({ event, chainVerified: true })),
        );
        return selectToolProviderTokens({
          fromMs: now - 7 * DAY_MS,
          toMs: now + 60_000,
        });
      });

      const byProvider = new Map(rows.map((r) => [r.provider, r.tokens]));
      expect(Object.fromEntries(byProvider)).toEqual({
        github: 4_000,
        linear: 800,
        builtin: 600,
      });
    });

    it("reads another workspace's listings as nothing (negative)", async () => {
      const orgId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const now = Date.now();
      const { event } = sealEvent(
        listing(session, new Date(now - HOUR_MS).toISOString(), [
          tool("github", "mcp__github__a", 1_000),
        ]),
        GENESIS_CURSOR,
      );
      await runInTenantScope({ orgId, workspaceId: randomUUID() }, () =>
        insertTachoEvents([{ event, chainVerified: true }]),
      );

      const rows = await runInTenantScope(
        { orgId, workspaceId: randomUUID() },
        () =>
          selectToolProviderTokens({
            fromMs: now - 7 * DAY_MS,
            toMs: now + 60_000,
          }),
      );
      expect(rows).toEqual([]);
    });
  },
);
