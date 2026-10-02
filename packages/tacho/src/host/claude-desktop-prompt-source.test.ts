/**
 * Who sent a prompt in Claude Desktop. The connected tier records no prompt
 * (`claude-desktop-writer.ts` says why), but the app's Code tab runs Claude
 * Code, so a prompt sent there reaches Tacho through Claude Code's
 * transcript. These lines were recorded from the Code tab in September 2026
 * (Claude Code 2.1.274 and 2.1.246, `entrypoint` `claude-desktop`). The
 * prompt text, the ids, the paths, and the peer's details are replaced. Every
 * other member is as recorded, in its recorded order.
 */
import { describe, expect, it } from "vitest";
import { normalizeTranscriptLine } from "../claude-code/transcript";

const TS = "2026-09-24T17:02:11.000Z";

const TYPED = {
  parentUuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000001",
  isSidechain: false,
  promptId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000010",
  type: "user",
  message: { role: "user", content: "Add a test for the date parser." },
  uuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000002",
  timestamp: TS,
  permissionMode: "default",
  origin: { kind: "human" },
  promptSource: "sdk",
  userType: "external",
  entrypoint: "claude-desktop",
  cwd: "/Users/kim/repo",
  sessionId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000100",
  version: "2.1.274",
  gitBranch: "main",
};

const TASK_REPORT = {
  parentUuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000003",
  isSidechain: false,
  promptId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000011",
  type: "user",
  message: {
    role: "user",
    content: "<task-notification>Build finished.</task-notification>",
  },
  uuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000004",
  timestamp: TS,
  permissionMode: "default",
  origin: { kind: "task-notification" },
  promptSource: "sdk",
  queueSkipAttachments: true,
  userType: "external",
  entrypoint: "claude-desktop",
  cwd: "/Users/kim/repo",
  sessionId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000100",
  version: "2.1.274",
  gitBranch: "main",
};

const PEER_MESSAGE = {
  parentUuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000005",
  isSidechain: false,
  promptId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000012",
  type: "user",
  message: { role: "user", content: "The review found two problems." },
  isMeta: true,
  uuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000006",
  timestamp: TS,
  permissionMode: "default",
  origin: {
    kind: "peer",
    from: "uds:/tmp/cc-peer.sock",
    verifiedPeerPid: 41234,
    msg_id: "0b7e4f2a-1c3d-4e5f-8a9b-000000000200",
    name: "reviewer",
    fromSession: "local_0b7e4f2a",
    fromMode: "prompting",
    body: "The review found two problems.",
  },
  promptSource: "sdk",
  queueSkipAttachments: true,
  userType: "external",
  entrypoint: "claude-desktop",
  cwd: "/Users/kim/repo",
  sessionId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000100",
  version: "2.1.274",
  gitBranch: "main",
};

/** Claude Code 2.1.246 wrote neither field. */
const NO_SOURCE = {
  parentUuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000007",
  isSidechain: false,
  promptId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000013",
  type: "user",
  message: { role: "user", content: "Rename the helper." },
  uuid: "0b7e4f2a-1c3d-4e5f-8a9b-000000000008",
  timestamp: TS,
  userType: "external",
  entrypoint: "claude-desktop",
  cwd: "/Users/kim/repo",
  sessionId: "0b7e4f2a-1c3d-4e5f-8a9b-000000000101",
  version: "2.1.246",
  gitBranch: "main",
};

function promptFacts(record: object): Record<string, unknown> {
  const { drafts } = normalizeTranscriptLine(JSON.stringify(record), TS);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.kind).toBe("oxagen:message");
  expect(drafts[0]?.context["entrypoint"]).toBe("claude-desktop");
  return drafts[0]?.body ?? {};
}

describe("a Claude Desktop prompt and who sent it", () => {
  it("marks a typed prompt with the human origin", () => {
    const facts = promptFacts(TYPED);
    expect(facts["prompt_source"]).toBe("sdk");
    expect(facts["prompt_origin"]).toEqual({ kind: "human" });
  });

  it("marks a background task's report with another origin, under the same source", () => {
    // The Code tab sets `sdk` on every prompt, so the source alone cannot
    // tell a person from a task. The origin can.
    const facts = promptFacts(TASK_REPORT);
    expect(facts["prompt_source"]).toBe(promptFacts(TYPED)["prompt_source"]);
    expect(facts["prompt_origin"]).toMatchObject({ kind: "task-notification" });
  });

  it("marks another agent's message with the peer origin", () => {
    const facts = promptFacts(PEER_MESSAGE);
    expect(facts["prompt_source"]).toBe("sdk");
    expect(facts["prompt_origin"]).toMatchObject({ kind: "peer" });
    expect(facts["is_meta"]).toBe(true);
  });

  it("leaves both fields out of a line that names no source", () => {
    const facts = promptFacts(NO_SOURCE);
    expect(facts).not.toHaveProperty("prompt_source");
    expect(facts).not.toHaveProperty("prompt_origin");
  });
});
