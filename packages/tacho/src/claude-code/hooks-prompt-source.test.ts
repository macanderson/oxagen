/**
 * The sender a harness adapter puts on a prompt payload (`prompt_source`,
 * `prompt_origin`) lands on the `turn_start` body, where detector 7's
 * first-prompt read finds it. Claude Code's own hook carries neither: its
 * transcript copy of the prompt does.
 */
import { describe, expect, it } from "vitest";
import { normalizeHook } from "./hooks";
import { SessionRecorder } from "./recorder";

const SESSION = "00000000-0000-4000-8000-000000000001";

function prompt(extra: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    hook_event_name: "UserPromptSubmit",
    cwd: "/home/dev/proj",
    prompt: "fix the build",
    ...extra,
  };
}

function draftOf(extra: Record<string, unknown> = {}) {
  const [draft] = normalizeHook(prompt(extra), {}, {
    sessionUuid: "11111111-1111-4111-8111-111111111111",
  });
  expect(draft?.kind).toBe("turn_start");
  return draft;
}

describe("the sender on a turn_start", () => {
  it("copies the sender an adapter set onto the body, and not into attrs", () => {
    const draft = draftOf({
      prompt_source: "typed",
      prompt_origin: { kind: "human" },
    });
    expect(draft?.body).toMatchObject({
      prompt_source: "typed",
      prompt_origin: { kind: "human" },
    });
    expect(draft?.attrs).not.toHaveProperty("hook.prompt_source");
    expect(draft?.attrs).not.toHaveProperty("hook.prompt_origin");
  });

  it("copies a source with no origin, as `codex exec` sends", () => {
    const draft = draftOf({ prompt_source: "sdk" });
    expect(draft?.body).toMatchObject({ prompt_source: "sdk" });
    expect(draft?.body).not.toHaveProperty("prompt_origin");
  });

  it("leaves both out when the payload names no sender", () => {
    const draft = draftOf();
    expect(draft?.body).not.toHaveProperty("prompt_source");
    expect(draft?.body).not.toHaveProperty("prompt_origin");
  });

  it("leaves out a source past the envelope's bound and an origin that is not an object", () => {
    const draft = draftOf({
      prompt_source: "s".repeat(513),
      prompt_origin: "human",
    });
    expect(draft?.body).not.toHaveProperty("prompt_source");
    expect(draft?.body).not.toHaveProperty("prompt_origin");
  });

  it("seals a turn_start the envelope accepts", () => {
    const recorder = new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.codex-laptop",
          fleet_id: "wrk_test",
          runtime: "codex",
          harness: "codex",
          wrapper_version: "2.1.1",
          host_enrollment_id: "he_0000000000000000000000000000",
        },
      },
      harnessSessionId: SESSION,
      scope: "he_0000000000000000000000000000",
    });
    const events = recorder.ingestHook(
      prompt({
        prompt_source: "system",
        prompt_origin: { kind: "heartbeat" },
      }),
      {},
    );
    const turn = events.find((event) => event.kind === "turn_start");
    expect(turn?.body).toMatchObject({
      prompt_source: "system",
      prompt_origin: { kind: "heartbeat" },
    });
  });
});
