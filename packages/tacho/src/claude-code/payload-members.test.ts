/**
 * The JSON objects a hook payload hands Tacho keep their identifying members
 * and lose their free text (#4969). The `Stop` payload is the one Claude Code
 * 2.1.263 sent (`fixtures/claude-code/hooks/16-Stop.json`), with a shell task
 * and a session cron added in the shapes Claude Code 2.1.287's hook schema
 * gives them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIND_BODIES } from "../envelope";
import { normalizeHook } from "./hooks";

const KEY = "sk-ant-api03-SyntheticKeyForTachoTests0123456789abcdefghijkl";

const STOP = (
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "fixtures",
        "claude-code",
        "hooks",
        "16-Stop.json",
      ),
      "utf8",
    ),
  ) as { stdin: Record<string, unknown> }
).stdin;

function turnEnd(extra: Record<string, unknown>) {
  const [draft] = normalizeHook({ ...STOP, ...extra }, {}, {
    sessionUuid: "11111111-1111-4111-8111-111111111111",
  });
  expect(draft?.kind).toBe("turn_end");
  return draft!;
}

describe("pending work on a Stop", () => {
  it("keeps the recorded subagent task without its description", () => {
    const draft = turnEnd({});
    expect(draft.body["background_tasks"]).toEqual([
      {
        id: "aebd5e72360a0fb91",
        type: "subagent",
        status: "running",
        agent_type: "Explore",
      },
    ]);
    expect(draft.body["session_crons"]).toEqual([]);
    expect(KIND_BODIES.turn_end.safeParse(draft.body).success).toBe(true);
  });

  it("puts a shell task's command and a cron's prompt in no body member", () => {
    const draft = turnEnd({
      background_tasks: [
        {
          id: "b7k2m9",
          type: "shell",
          status: "running",
          description: "Watch the deploy log",
          command: `curl -H "x-api-key: ${KEY}" https://api.example.com/v1`,
        },
        {
          id: "m1",
          type: "monitor",
          status: "pending",
          description: "Poll the queue",
          server: "queue",
          tool: "poll",
        },
      ],
      session_crons: [
        {
          id: "cron-1",
          schedule: "*/5 * * * *",
          recurring: true,
          prompt: `check the build, the key is ${KEY}`,
        },
      ],
    });
    expect(draft.body["background_tasks"]).toEqual([
      { id: "b7k2m9", type: "shell", status: "running" },
      {
        id: "m1",
        type: "monitor",
        status: "pending",
        server: "queue",
        tool: "poll",
      },
    ]);
    expect(draft.body["session_crons"]).toEqual([
      { id: "cron-1", schedule: "*/5 * * * *", recurring: true },
    ]);
    const shipped = JSON.stringify({ body: draft.body, attrs: draft.attrs });
    expect(shipped).not.toContain(KEY);
    expect(shipped).not.toContain("Watch the deploy log");
    expect(shipped).not.toContain("check the build");
  });

  it("keeps an entry it cannot read as an empty one, so the list keeps its length", () => {
    const draft = turnEnd({
      background_tasks: ["not an object", null],
      session_crons: [42],
    });
    expect(draft.body["background_tasks"]).toEqual([{}, {}]);
    expect(draft.body["session_crons"]).toEqual([{}]);
  });

  it("leaves out a list that is not a list", () => {
    const draft = turnEnd({ background_tasks: "none", session_crons: {} });
    expect(draft.body).not.toHaveProperty("background_tasks");
    expect(draft.body).not.toHaveProperty("session_crons");
  });
});

describe("the sender an adapter puts on a prompt", () => {
  it("keeps the sender's members and drops a message body", () => {
    const [draft] = normalizeHook(
      {
        session_id: "00000000-0000-4000-8000-000000000001",
        hook_event_name: "UserPromptSubmit",
        cwd: "/home/dev/proj",
        prompt: "fix the build",
        prompt_source: "system",
        prompt_origin: { kind: "peer", name: "reviewer", body: KEY },
      },
      {},
      { sessionUuid: "11111111-1111-4111-8111-111111111111" },
    );
    expect(draft?.kind).toBe("turn_start");
    expect(draft?.body["prompt_origin"]).toEqual({
      kind: "peer",
      name: "reviewer",
    });
    expect(JSON.stringify(draft?.body)).not.toContain(KEY);
  });
});
