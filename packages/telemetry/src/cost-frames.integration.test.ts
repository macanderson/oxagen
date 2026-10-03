import { randomUUID } from "node:crypto";
import {
  GENESIS_CURSOR,
  LLM_CALL_DUPLICATE_OF_ATTR,
  sealEvent,
  sessionUuid,
  type TachoEvent,
  type UnsealedTachoEvent,
} from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import {
  readModelCallFrames,
  RUN_SESSIONS_PARAMS_MAX,
  RUN_SESSIONS_PER_PARAM,
} from "./cost-frames";
import { insertTachoEvents } from "./tacho-events";

// CI migrates ClickHouse before the unit job, so `tacho_events` exists with
// every migration applied. Missing configuration skips local collection.
// This is the witness that the wrapped frame read joins a model call's proxy
// sighting back when another source sealed the call first (#4508), and that
// its SQL runs on the server.

const DIGEST = `sha256:${"a".repeat(64)}`;
const PART_DIGEST = `sha256:${"b".repeat(64)}`;

/** One `llm_call` frame on `session` at `ts`, from `source`. */
function modelCall(
  session: string,
  ts: string,
  sighting: Pick<UnsealedTachoEvent, "source" | "fidelity">,
  body: Record<string, unknown>,
  attrs: Record<string, string> = {},
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "witness",
    session_uuid: session,
    root_session_uuid: session,
    ts,
    ...sighting,
    agent: {
      agent_key: "acme.core.witness",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
    },
    attrs,
    kind: "llm_call",
    body: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      input_tokens: 1_000,
      output_tokens: 200,
      ...body,
    },
  } as UnsealedTachoEvent;
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "the wrapped model-call read against a live store",
  () => {
    it("prices an OTel sighting with the token sources of the proxy sighting stamped its duplicate", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const now = Date.now();
      const at = (ms: number) => new Date(ms).toISOString();
      const otel = { source: "otel_log", fidelity: "sdk" } as const;
      const proxy = { source: "collector", fidelity: "proxy" } as const;
      const frames = [
        // Call one: the OTel row seals first, so the host stamps the proxy
        // row that follows it. Only the proxy row measured the request.
        modelCall(session, at(now - 4_000), otel, {
          request_id: "req_one",
          message_id: "msg_one",
        }),
        modelCall(
          session,
          at(now - 3_900),
          proxy,
          {
            request_id: "req_one",
            message_id: "msg_one",
            tool_definition_tokens: 12_400,
            tool_definition_tokens_basis: "estimated",
            steering_tokens: 80,
            steering_tokens_basis: "estimated",
            system_context_digest: DIGEST,
            system_context_parts: [
              {
                kind: "tool",
                name: "Read",
                provider: "builtin",
                digest: PART_DIGEST,
                tokens: 12_400,
              },
            ],
          },
          { [LLM_CALL_DUPLICATE_OF_ATTR]: "otel_log" },
        ),
        // Call two: the proxy row carries only the message id, which the
        // host's ledger also matches on.
        modelCall(session, at(now - 2_000), otel, {
          request_id: "req_two",
          message_id: "msg_two",
        }),
        modelCall(
          session,
          at(now - 1_900),
          proxy,
          {
            message_id: "msg_two",
            tool_definition_tokens: 900,
            tool_definition_tokens_basis: "estimated",
          },
          { [LLM_CALL_DUPLICATE_OF_ATTR]: "otel_log" },
        ),
        // Call three: no proxy sighting, so nothing measured its sources
        // (negative). A join must not lend it another call's counts.
        modelCall(session, at(now - 1_000), otel, {
          request_id: "req_three",
          message_id: "msg_three",
        }),
      ];
      const events: TachoEvent[] = [];
      let cursor = GENESIS_CURSOR;
      for (const frame of frames) {
        const sealed = sealEvent(frame, cursor);
        events.push(sealed.event);
        cursor = sealed.next;
      }
      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents(
          events.map((event) => ({ event, chainVerified: true })),
        ),
      );

      const priced = await readModelCallFrames({
        orgId,
        workspaceId,
        run: {
          kind: "tacho",
          rootSessionUuid: session,
          sessionUuids: [session],
        },
      });

      // One priced frame per call, each priced from its OTel row.
      expect(priced).toHaveLength(3);
      expect(priced.map((frame) => frame.inputUncached)).toEqual([
        1_000, 1_000, 1_000,
      ]);
      expect(priced[0]).toMatchObject({
        toolDefinitionTokens: 12_400,
        contextFrameTokens: null,
        steeringTokens: 80,
        systemContextDigest: DIGEST,
        systemContextParts: [
          expect.objectContaining({ name: "Read", tokens: 12_400 }),
        ],
      });
      expect(priced[1]).toMatchObject({
        toolDefinitionTokens: 900,
        contextFrameTokens: null,
        steeringTokens: null,
      });
      expect(priced[1]).not.toHaveProperty("systemContextDigest");
      expect(priced[2]).toMatchObject({
        toolDefinitionTokens: null,
        contextFrameTokens: null,
        steeringTokens: null,
      });
      expect(priced[2]).not.toHaveProperty("systemContextDigest");
    });

    // A long-lived root can register thousands of subagent sessions. Bound
    // as one array parameter, 3,000 of them take about 135 KB of the request
    // URL, and ClickHouse refused the read with "HTML Form Exception: Field
    // value too long" before it ran, which failed every rollup and findings
    // pass of that run's workspace (#5311).
    it("reads a run whose session list passes one URL field, and one past the URL budget", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const root = sessionUuid("tch_witness", randomUUID());
      const child = sessionUuid("tch_witness", randomUUID());
      const now = Date.now();
      const otel = { source: "otel_log", fidelity: "sdk" } as const;
      const rootCall = modelCall(root, new Date(now - 2_000).toISOString(), otel, {
        request_id: "req_root",
        message_id: "msg_root",
      });
      const childCall = {
        ...modelCall(child, new Date(now - 1_000).toISOString(), otel, {
          request_id: "req_child",
          message_id: "msg_child",
        }),
        root_session_uuid: root,
        parent_session_uuid: root,
      } as UnsealedTachoEvent;
      // Each chain is sealed from its own genesis.
      const events = [rootCall, childCall].map(
        (frame) => sealEvent(frame, GENESIS_CURSOR).event,
      );
      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents(
          events.map((event) => ({ event, chainVerified: true })),
        ),
      );

      // Registered chains that wrote no model call.
      const idle = (n: number) => Array.from({ length: n }, () => randomUUID());
      for (const sessionUuids of [
        [root, ...idle(2_998), child],
        [root, ...idle(RUN_SESSIONS_PER_PARAM * RUN_SESSIONS_PARAMS_MAX), child],
      ]) {
        const priced = await readModelCallFrames({
          orgId,
          workspaceId,
          run: { kind: "tacho", rootSessionUuid: root, sessionUuids },
        });
        expect(priced.map((frame) => frame.sessionUuid)).toEqual([root, child]);
      }
    });
  },
);
