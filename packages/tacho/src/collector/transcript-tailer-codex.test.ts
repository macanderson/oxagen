/**
 * The tailer on a Codex session: it reads the rollout, keeps the reader's
 * state on the file's cursor so a restart between a response's text and its
 * usage record loses nothing, leaves a torn last line on disk, starts the
 * state over with a replaced file, and opens a subagent's rollout from the
 * subagent's hooks rather than from a directory listing.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptDraft } from "../claude-code/transcript";
import { normalizeRolloutLine, type TranscriptCarry } from "../codex/rollout";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { sessionMapKey } from "./registry";
import { type TailedSession, TranscriptTailer } from "./transcript-tailer";

const AT = "2026-09-30T12:00:00.000Z";
const FIXTURES = join(__dirname, "..", "..", "fixtures", "codex", "transcript");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * A Codex session whose recorder runs the real rollout reader against the
 * carry the tailer hands it, and remembers what it drafted.
 */
function codexSession(
  id: string,
  transcriptPath: string,
  harness: TailedSession["harness"] = "codex",
) {
  const drafts: Array<{ draft: TranscriptDraft; subagentId?: string }> = [];
  const session: TailedSession & { drafts: typeof drafts } = {
    harnessSessionId: id,
    harness,
    transcriptPath,
    sealed: false,
    drafts,
    recorder: {
      ingestTranscriptLine(
        line: string,
        subagentId?: string,
        carry?: TranscriptCarry,
      ): TachoEvent[] {
        const { normalized, state } = normalizeRolloutLine(
          line,
          carry?.codex,
          AT,
        );
        if (carry !== undefined) carry.codex = state;
        for (const draft of normalized.drafts)
          drafts.push(
            subagentId !== undefined ? { draft, subagentId } : { draft },
          );
        return [];
      },
      takeBodies(): FrameBody[] {
        return [];
      },
      markChain() {
        return {} as ReturnType<TailedSession["recorder"]["markChain"]>;
      },
      rollbackChain() {
        return undefined;
      },
      sealCollectorEvent(kind: string): TachoEvent {
        return { kind, attrs: {} } as unknown as TachoEvent;
      },
    },
  };
  return session;
}

function messageIds(
  drafts: ReadonlyArray<{ draft: TranscriptDraft }>,
): unknown[] {
  return drafts.map(({ draft }) => draft.body["message_id"]);
}

function bodyText(draft: TranscriptDraft | undefined): string | undefined {
  const bytes = draft?.content?.bytes;
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

describe("TranscriptTailer on a Codex rollout", () => {
  const dirs: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "tacho-codex-tail-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  function tailer(sessions: TailedSession[], statePath?: string) {
    return new TranscriptTailer({
      sessions: () => sessions,
      session: (id) => sessions.find((s) => s.harnessSessionId === id),
      record: () => undefined,
      ...(statePath !== undefined ? { statePath } : {}),
    });
  }

  it("reads a Codex session's rollout", async () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, fixture("tool-calls.jsonl"));
    const session = codexSession("s1", path);
    await tailer([session]).tick();
    expect(session.drafts).toHaveLength(3);
  });

  it("keeps a response's text across a restart, and leaves a torn usage line unread", async () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    const statePath = join(dir, "state", "transcript-tail.json");
    mkdirSync(join(dir, "state"), { recursive: true });
    const all = fixture("final-answer.jsonl").split("\n");
    const at = all.findIndex((line) => line.includes('"token_usage_record"'));
    const usage = all[at] as string;
    // Codex has written the answer and half of the usage record.
    const torn = usage.slice(0, 40);
    writeFileSync(path, `${all.slice(0, at).join("\n")}\n${torn}`);
    const first = codexSession("s1", path);
    const before = tailer([first], statePath);
    await before.tick();
    expect(first.drafts).toEqual([]);
    const key = sessionMapKey("s1", { harness: "codex" });
    const cursor = before.state().cursors[key];
    // The torn line is left on disk, and the text waits on the cursor.
    expect(cursor?.offset).toBe(
      Buffer.byteLength(`${all.slice(0, at).join("\n")}\n`),
    );
    expect(cursor?.codex?.held?.parts).toHaveLength(1);

    // The daemon restarts, then Codex finishes the line.
    appendFileSync(path, `${usage.slice(40)}\n`);
    const again = codexSession("s1", path);
    await tailer([again], statePath).tick();
    expect(messageIds(again.drafts)).toEqual([
      (JSON.parse(usage) as { payload: { response_id: string } }).payload
        .response_id,
    ]);
    const answer = all.find((line) => line.includes('"role":"assistant"'));
    const text = (
      JSON.parse(answer ?? "{}") as {
        payload: { content: Array<{ text: string }> };
      }
    ).payload.content[0]?.text;
    expect(bodyText(again.drafts[0]?.draft)).toBe(text);
  });

  it("starts the reader's state over when the rollout is replaced", async () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    const all = fixture("final-answer.jsonl").split("\n");
    const at = all.findIndex((line) => line.includes('"token_usage_record"'));
    writeFileSync(path, `${all.slice(0, at).join("\n")}\n`);
    const session = codexSession("s1", path);
    const instance = tailer([session]);
    await instance.tick();
    const key = sessionMapKey("s1", { harness: "codex" });
    expect(instance.state().cursors[key]?.codex?.held).toBeDefined();
    // A shorter file at the same path: the text held from the old one is
    // gone with it.
    writeFileSync(path, `${all[0]}\n`);
    await instance.tick();
    expect(instance.state().cursors[key]?.codex?.held).toBeUndefined();
  });

  it("tails a subagent's rollout that its hooks name, fed with the subagent id", async () => {
    const dir = scratch();
    const parent = join(dir, "rollout-parent.jsonl");
    const child = join(dir, "rollout-child.jsonl");
    writeFileSync(parent, fixture("final-answer.jsonl"));
    writeFileSync(child, fixture("subagent-fork.jsonl"));
    const session = codexSession("s1", parent);
    const instance = tailer([session]);
    // The session's own path names no subagent.
    instance.noteSubagentTranscript("s1", "agent-1", parent);
    instance.noteSubagentTranscript("s1", "agent-1", child);
    await instance.tick();
    const fromChild = session.drafts.filter((d) => d.subagentId === "agent-1");
    expect(fromChild).toHaveLength(2);
    const own = session.drafts.filter((d) => d.subagentId === undefined);
    expect(own).toHaveLength(1);
    // SubagentStop drains it and retires the cursor.
    const fed = await instance.ingestSubagentTranscript("s1", "agent-1", child);
    expect(fed).toBe(0);
    const key = sessionMapKey("s1", { harness: "codex" });
    expect(instance.state().cursors[key]?.subagents).toEqual(["agent-1"]);
    expect(instance.state().cursors[key]?.agents).toBeUndefined();
  });

  it("opens no subagent cursor from a Claude Code session's hooks", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(path, "");
    writeFileSync(other, fixture("tool-calls.jsonl"));
    const session = codexSession("s1", path, "claude-code");
    const instance = tailer([session]);
    instance.noteSubagentTranscript("s1", "agent-1", other);
    await instance.tick();
    expect(session.drafts).toEqual([]);
    const key = sessionMapKey("s1", { harness: "claude-code" });
    expect(instance.state().cursors[key]?.agents).toBeUndefined();
  });
});
