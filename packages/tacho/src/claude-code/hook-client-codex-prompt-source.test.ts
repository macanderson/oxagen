/**
 * Who sent a Codex prompt, as `tacho-hook` hands it to the daemon. Codex
 * names no sender on a prompt, so the hook adds `prompt_source` and
 * `prompt_origin` from what Codex records (`withCodexPromptSource`), and the
 * daemon's normalizer copies them onto the `turn_start`. The payloads are the
 * recorded fixtures under `fixtures/codex`.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type postUnix, runTachoHook } from "./hook-client";
import { normalizeHook } from "./hooks";

const FIXTURES = resolve(__dirname, "../../fixtures/codex");

function enrolledPaths() {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  return paths;
}

/** A recorded payload, its `transcript_path` moved to a copy of `rollout`. */
function payload(name: string, rollout?: string): Record<string, unknown> {
  const fixture = join(FIXTURES, "hooks", `UserPromptSubmit-${name}.json`);
  const { stdin } = JSON.parse(readFileSync(fixture, "utf8")) as {
    stdin: Record<string, unknown>;
  };
  if (rollout === undefined) return stdin;
  const dir = mkdtempSync(join(tmpdir(), "codex-rollout-"));
  const path = join(dir, `${rollout}.jsonl`);
  copyFileSync(join(FIXTURES, "rollout", `${rollout}.jsonl`), path);
  return { ...stdin, transcript_path: path };
}

/** Run one hook against a daemon that answers `{}`; return the payload sent. */
async function sentPayload(
  stdin: Record<string, unknown>,
  harness: "codex" | "claude-code" = "codex",
): Promise<Record<string, unknown>> {
  const seen: Array<Parameters<typeof postUnix>[0]> = [];
  const result = await runTachoHook({
    paths: enrolledPaths(),
    env: { HOME: "/h" },
    stdin: JSON.stringify(stdin),
    harness,
    harnessPid: () => undefined,
    platform: "linux",
    post: async (options) => {
      seen.push(options);
      return { status: 200, body: "{}" };
    },
  });
  expect(result.path).toBe("daemon");
  return (
    JSON.parse(seen[0]?.body ?? "{}") as { payload: Record<string, unknown> }
  ).payload;
}

/** The `turn_start` body the daemon's normalizer seals from a payload. */
function turnStartBody(sent: Record<string, unknown>): Record<string, unknown> {
  const [draft] = normalizeHook(sent, {}, {
    sessionUuid: "11111111-1111-4111-8111-111111111111",
  });
  expect(draft?.kind).toBe("turn_start");
  return draft?.body ?? {};
}

describe("the sender on a Codex prompt", () => {
  it("gives a prompt typed into a Codex thread a person started the person value", async () => {
    for (const rollout of ["cli-typed", "desktop-typed"]) {
      const sent = await sentPayload(payload("typed", rollout));
      expect(sent).toMatchObject({
        prompt_source: "typed",
        prompt_origin: { kind: "human" },
      });
      expect(turnStartBody(sent)).toMatchObject({
        prompt_source: "typed",
        prompt_origin: { kind: "human" },
      });
    }
  });

  it("gives a prompt Codex marks as automated a value other than the person one", async () => {
    const exec = await sentPayload(payload("typed", "exec"));
    expect(turnStartBody(exec)).toMatchObject({ prompt_source: "sdk" });
    expect(turnStartBody(exec)).not.toHaveProperty("prompt_origin");

    const heartbeat = await sentPayload(payload("heartbeat", "desktop-typed"));
    expect(turnStartBody(heartbeat)).toMatchObject({
      prompt_source: "system",
      prompt_origin: { kind: "heartbeat" },
    });

    const subagent = await sentPayload(payload("subagent", "subagent"));
    expect(turnStartBody(subagent)).toMatchObject({
      prompt_source: "system",
      prompt_origin: { kind: "coordinator" },
    });
  });

  it("leaves the sender null on a prompt Codex records nothing about", async () => {
    for (const sent of [
      await sentPayload(payload("no-transcript")),
      await sentPayload(payload("typed", "desktop-no-thread-source")),
      await sentPayload(payload("typed", "guardian")),
    ]) {
      expect(sent).not.toHaveProperty("prompt_source");
      expect(sent).not.toHaveProperty("prompt_origin");
      const body = turnStartBody(sent);
      expect(body).not.toHaveProperty("prompt_source");
      expect(body).not.toHaveProperty("prompt_origin");
    }
  });

  it("adds nothing to a Claude Code prompt, whose transcript carries the sender", async () => {
    const typed = payload("typed", "cli-typed");
    const sent = await sentPayload(typed, "claude-code");
    expect(sent).not.toHaveProperty("prompt_source");
    expect(sent).not.toHaveProperty("prompt_origin");
  });

  it("spools the sender with the prompt when the daemon is down", async () => {
    const paths = enrolledPaths();
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify(payload("typed", "exec")),
      harness: "codex",
      harnessPid: () => undefined,
      platform: "linux",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.path).toBe("local");
    const [file] = readdirSync(paths.spool);
    const spooled = JSON.parse(
      readFileSync(join(paths.spool, file as string), "utf8"),
    ) as { payload: Record<string, unknown> };
    expect(spooled.payload).toMatchObject({ prompt_source: "sdk" });
  });
});
