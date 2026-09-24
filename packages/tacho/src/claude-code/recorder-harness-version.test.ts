/**
 * The harness version on a session that exports no OTel.
 *
 * `agent.harness_version` came from OTel's `service.version` or from a
 * `/versions/x.y.z` exec path. A session with neither stamped no version on
 * any frame, although every transcript line names it (`version`, recorded as
 * `context.app_version`). The recorder now falls back to that.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-555555555555";
const at = "2026-09-24T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

function recorder(): SessionRecorder {
  return new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: "harness-version",
  });
}

const transcriptLine = (version: string) =>
  JSON.stringify({
    type: "user",
    uuid: "u1",
    sessionId: ID,
    timestamp: at,
    cwd: "/repo",
    version,
    message: { role: "user", content: "hello" },
  });

describe("harness version from the transcript", () => {
  it("stamps the version a transcript line names on the frames after it", () => {
    const chain = recorder();
    const [genesis] = chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    // Nothing has named a version yet, and none is invented.
    expect(genesis?.agent.harness_version).toBeUndefined();

    chain.ingestTranscriptLine(transcriptLine("2.1.281"));
    const later = chain.ingestHook(
      {
        session_id: ID,
        hook_event_name: "UserPromptSubmit",
        prompt: "next",
      },
      {},
      at,
    );
    expect(later.length).toBeGreaterThan(0);
    for (const event of later)
      expect(event.agent.harness_version).toBe("2.1.281");
  });

  it("keeps the version OTel reports over the transcript's", () => {
    const chain = recorder();
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    chain.ingestTranscriptLine(transcriptLine("2.1.280"));
    chain.ingestOtlp({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.version", value: { stringValue: "2.1.281" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1790000000000000000",
                  body: { stringValue: "claude_code.user_prompt" },
                  attributes: [
                    { key: "session.id", value: { stringValue: ID } },
                    { key: "prompt_length", value: { stringValue: "4" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const later = chain.ingestHook(
      {
        session_id: ID,
        hook_event_name: "UserPromptSubmit",
        prompt: "next",
      },
      {},
      at,
    );
    for (const event of later)
      expect(event.agent.harness_version).toBe("2.1.281");
  });
});
