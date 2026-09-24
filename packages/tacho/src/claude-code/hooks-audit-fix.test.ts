/**
 * What a hook payload carries onto its frames beyond the typed body: a
 * leftover field as an attribute, cleaned and cut to the envelope's bound;
 * the pull request a `gh pr create` opened; and the `turn_end` a
 * `StopFailure` closes its turn with.
 */
import { describe, expect, it } from "vitest";
import { redactionMarker } from "../evidence/redaction";
import { normalizeHook, TURN_END_REASON_ATTR } from "./hooks";

const SESSION = "00000000-0000-4000-8000-000000000002";

function hook(event: string, extra: Record<string, unknown> = {}) {
  return normalizeHook(
    { session_id: SESSION, hook_event_name: event, ...extra },
    {},
    { sessionUuid: SESSION },
  );
}

describe("a leftover hook field", () => {
  it("ships with its credentials redacted", () => {
    const token = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
    const [draft] = hook("Notification", { note: `use ${token} to push` });
    expect(draft?.attrs["hook.note"]).toBe(
      `use ${redactionMarker("github_token")} to push`,
    );
    expect(JSON.stringify(draft?.attrs)).not.toContain(token);
  });

  it("is cut on a whole character", () => {
    // The emoji's two UTF-16 halves sit either side of the cut.
    const value = `${"x".repeat(4094)}😀tail`;
    const [draft] = hook("Notification", { note: value });
    const cut = draft?.attrs["hook.note"] ?? "";
    expect(cut.length).toBeLessThanOrEqual(4096);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toBe(`${"x".repeat(4094)}…`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
  });
});

describe("a pull request opened from the shell", () => {
  it("names the pull request on its effect frame", () => {
    const drafts = hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_pr",
      tool_input: { command: "gh pr create --fill" },
      tool_response: {
        stdout: "Creating pull request\nhttps://github.com/o/r/pull/12\n",
      },
    });
    expect(drafts.map((draft) => draft.kind)).toEqual(["tool_call", "command"]);
    expect(drafts[1]?.attrs).toMatchObject({
      "pr.url": "https://github.com/o/r/pull/12",
      "pr.number": "12",
      "pr.repository": "o/r",
    });
    expect(drafts[0]?.attrs["pr.url"]).toBeUndefined();
  });

  it("leaves an ordinary command's frame without one", () => {
    const drafts = hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_echo",
      tool_input: { command: "echo https://github.com/o/r/pull/12" },
      tool_response: { stdout: "https://github.com/o/r/pull/12" },
    });
    expect(drafts[1]?.attrs["pr.url"]).toBeUndefined();
  });
});

describe("a StopFailure", () => {
  it("records the error and closes the turn with it", () => {
    const drafts = hook("StopFailure", {
      error_type: "overloaded",
      last_assistant_message: "API Error: 529",
      extra_field: "kept",
    });
    expect(drafts.map((draft) => draft.kind)).toEqual(["error", "turn_end"]);
    const end = drafts[1];
    expect(end?.body).toMatchObject({ stop_failure_error_type: "overloaded" });
    expect(end?.attrs[TURN_END_REASON_ATTR]).toBe("api_error");
    expect(end?.attrs["hook.extra_field"]).toBe("kept");
    expect(new TextDecoder().decode(end?.content?.bytes)).toBe(
      "API Error: 529",
    );
  });
});
