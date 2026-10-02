/**
 * The backfill's pre-flight client (#4028, ADR-161): what it sends, how it
 * keys the answer, and that every failure answers undefined so the pass
 * seals nothing it could not check.
 */
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../host/control-client";
import { createSessionHeads, SESSION_HEADS_PATH } from "./session-heads";

const HOST = {
  api_url: "https://api.example.test/",
  api_key: "oxk_host",
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
};
const ASKED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EARLIER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_ID = "0b1f0000-0000-4000-8000-00000000b001";

function client(answer: { status: number; body: string } | Error) {
  const sent: Array<{ url: string; body: unknown; auth?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({
      url,
      body: JSON.parse(init.body ?? "null"),
      auth: init.headers["Authorization"],
    });
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body,
    };
  };
  const logs: string[] = [];
  const heads = createSessionHeads({
    host: () => HOST,
    fetch,
    log: (line) => logs.push(line),
  });
  return { heads, sent, logs };
}

const row = (uuid: string, basis: string) => ({
  session_uuid: uuid,
  harness_session_id: SESSION_ID,
  seq_count: 12,
  record_basis: basis,
  backfill_normalizer: basis === "backfill" ? "1" : null,
});

describe("the backfill pre-flight client", () => {
  it("asks by uuid and by session id with the host key", async () => {
    const { heads, sent } = client({
      status: 200,
      body: JSON.stringify({ sessions: [row(ASKED, "live")] }),
    });
    const answer = await heads([
      { sessionUuid: ASKED, sessionId: SESSION_ID },
      { sessionUuid: EARLIER, sessionId: "not an id the route takes" },
    ]);
    expect(sent).toEqual([
      {
        url: `https://api.example.test${SESSION_HEADS_PATH}`,
        auth: "Bearer oxk_host",
        body: {
          host_enrollment_id: HOST.host_enrollment_id,
          session_uuids: [ASKED, EARLIER],
          harness_session_ids: [SESSION_ID],
        },
      },
    ]);
    expect(answer?.get(ASKED)?.record_basis).toBe("live");
    expect(answer?.has(EARLIER)).toBe(false);
  });

  it("answers a session an earlier enrollment recorded for the uuid asked", async () => {
    const { heads } = client({
      status: 200,
      body: JSON.stringify({ sessions: [row(EARLIER, "backfill")] }),
    });
    const answer = await heads([{ sessionUuid: ASKED, sessionId: SESSION_ID }]);
    expect(answer?.get(ASKED)).toMatchObject({
      session_uuid: EARLIER,
      record_basis: "backfill",
      backfill_normalizer: "1",
    });
  });

  it.each([
    ["an unreachable control plane", new Error("ECONNREFUSED")],
    ["a route this control plane does not serve", { status: 404, body: "{}" }],
    ["an error status", { status: 503, body: "{}" }],
    ["an answer it cannot read", { status: 200, body: "{\"sessions\":7}" }],
  ])("answers undefined for %s", async (_name, answer) => {
    const { heads, logs } = client(answer);
    expect(
      await heads([{ sessionUuid: ASKED, sessionId: SESSION_ID }]),
    ).toBeUndefined();
    expect(logs.join("\n")).toMatch(/seals nothing it cannot check/);
  });
});
