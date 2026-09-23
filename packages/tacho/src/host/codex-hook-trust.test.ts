import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexAppServer } from "./codex-app-server";
import {
  codexTrustProblem,
  hooksNeedingTrust,
  oxagenHooks,
  parseHooksList,
  trustCodexHooks,
  trustKeyPath,
  trustTable,
  untrustCodexHooks,
} from "./codex-hook-trust";
import { mergeCodexHooks } from "./codex-writer";
import { hookMarker } from "./settings-writer";
import { fakeCodexAppServer, TEST_ENROLLMENT } from "./test-support";

const MARKER = hookMarker(TEST_ENROLLMENT);

function hook(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "/home/dev/.codex/hooks.json:pre_tool_use:0:0",
    currentHash: "sha256:abc",
    trustStatus: "untrusted",
    isManaged: false,
    command: `tacho hook ${MARKER} --harness codex`,
    ...over,
  };
}

const listing = (...hooks: unknown[]) => ({ data: [{ hooks }] });

describe("parseHooksList", () => {
  it("flattens every working directory and keeps the last of a repeated key", () => {
    const parsed = parseHooksList({
      data: [
        { hooks: [hook(), hook({ key: "b" })] },
        { hooks: [hook({ trustStatus: "trusted" })] },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.find((h) => h.key !== "b")?.trustStatus).toBe("trusted");
  });

  it("drops an entry it cannot read rather than guessing at it", () => {
    // A record written from a misread field would tell Codex to trust a hash
    // that is not the hook's, and Codex would go on skipping the hook — the
    // exact failure this module exists to end, with a success reported.
    expect(
      parseHooksList(
        listing(
          hook({ key: undefined }),
          hook({ key: "b", currentHash: undefined }),
          hook({ key: "c", trustStatus: "probationary" }),
          hook({ key: "d" }),
        ),
      ).map((h) => h.key),
    ).toEqual(["d"]);
  });

  it("reads nothing out of a shape it does not know", () => {
    expect(parseHooksList(undefined)).toEqual([]);
    expect(parseHooksList({ data: "no" })).toEqual([]);
    expect(parseHooksList({ data: [{ hooks: "no" }] })).toEqual([]);
  });
});

describe("selecting Tacho's hooks", () => {
  it("keeps only hooks carrying this enrollment's marker", () => {
    const hooks = parseHooksList(
      listing(
        hook(),
        hook({ key: "other", command: "some-other-tool --watch" }),
        hook({ key: "stale", command: "tacho hook --enrollment tch_old" }),
        hook({ key: "nocmd", command: undefined }),
      ),
    );
    expect(oxagenHooks(hooks, TEST_ENROLLMENT).map((h) => h.key)).toEqual([
      "/home/dev/.codex/hooks.json:pre_tool_use:0:0",
    ]);
  });

  it("leaves a managed hook alone and takes every other untrusted status", () => {
    const hooks = parseHooksList(
      listing(
        hook({ key: "untrusted", trustStatus: "untrusted" }),
        hook({ key: "modified", trustStatus: "modified" }),
        hook({ key: "trusted", trustStatus: "trusted" }),
        hook({ key: "managed", trustStatus: "managed", isManaged: true }),
      ),
    );
    expect(hooksNeedingTrust(hooks).map((h) => h.key)).toEqual([
      "untrusted",
      "modified",
    ]);
  });

  it("builds the hooks.state table Codex writes", () => {
    expect(trustTable(parseHooksList(listing(hook({ key: "k" }))))).toEqual({
      k: { trusted_hash: "sha256:abc" },
    });
  });

  it("quotes a key path so a file path with dots stays one key", () => {
    expect(trustKeyPath("/a.b/hooks.json:stop:0:1")).toBe(
      'hooks.state."/a.b/hooks.json:stop:0:1"',
    );
    expect(trustKeyPath('with"quote')).toBe('hooks.state."with\\"quote"');
  });
});

/** A `hooks.json` with Tacho's hooks in it, at a scratch path. */
function seedHooksFile(): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "tacho-codex-trust-")),
    "hooks.json",
  );
  writeFileSync(
    path,
    JSON.stringify(
      mergeCodexHooks(undefined, {
        enrollmentId: TEST_ENROLLMENT,
        hookCommand: "tacho hook",
        port: 47123,
        localToken: "local-token-0123456789abcdef",
      }).settings,
    ),
  );
  return path;
}

describe("trustCodexHooks", () => {
  it("records every hook, and a second run finds nothing left to do", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    const first = await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(first.ok).toBe(true);
    expect(first.found).toBeGreaterThan(0);
    expect(first.recorded).toHaveLength(first.found);
    expect(first.pending).toEqual([]);
    expect(codex.trusted.size).toBe(first.found);

    const second = await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(second).toEqual({
      ok: true,
      found: first.found,
      recorded: [],
      pending: [],
    });
    // Idempotent on the wire too: the second run asks and writes nothing.
    expect(
      codex.requests.filter((r) => r.method === "config/value/write"),
    ).toHaveLength(first.found);
  });

  it("re-records after the hooks file is rewritten, because trust follows the contents", async () => {
    const path = seedHooksFile();
    const codex = fakeCodexAppServer(path);
    await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    // An upgrade moves the hook binary: the same events at the same
    // positions, a different command line, so every record Codex holds now
    // names a definition that no longer exists. The port is deliberately not
    // what changes — a Codex command hook does not carry it.
    writeFileSync(
      path,
      JSON.stringify(
        mergeCodexHooks(undefined, {
          enrollmentId: TEST_ENROLLMENT,
          hookCommand: "/opt/tacho/2.2.0/tacho hook",
          port: 47123,
          localToken: "local-token-0123456789abcdef",
        }).settings,
      ),
    );
    const problem = await codexTrustProblem({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "/opt/tacho/2.2.0/tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(problem).toContain("modified");
    const again = await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "/opt/tacho/2.2.0/tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(again.ok).toBe(true);
    expect(again.recorded).toHaveLength(again.found);
  });

  it("fails when Codex does not report Tacho's hooks at all", async () => {
    const empty = join(
      mkdtempSync(join(tmpdir(), "tacho-codex-empty-")),
      "hooks.json",
    );
    const result = await trustCodexHooks({
      appServer: fakeCodexAppServer(empty).server,
      hooksPath: empty,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("none of Tacho's hooks");
  });

  it("reports a write Codex accepted but did not apply, rather than calling it done", async () => {
    // The re-read is the whole point: without it this is a silent success
    // whose only symptom is hooks that never fire.
    const codex = fakeCodexAppServer(seedHooksFile());
    // Answers the write with a success and never applies it, so the re-read
    // still reports every hook as untrusted.
    const swallowing: CodexAppServer = async (requests) => ({
      answers: await Promise.all(
        requests.map(async (request) =>
          request.method === "config/value/write"
            ? { result: {} }
            : ((await codex.server([request])).answers[0] ?? {}),
        ),
      ),
    });
    const result = await trustCodexHooks({
      appServer: swallowing,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("still reports");
    expect(result.pending).toHaveLength(result.found);
    expect(result.recorded).toEqual([]);
  });

  it("turns a Codex that cannot be driven into a problem, not a throw", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    codex.breakWith("could not run `codex app-server`: ENOENT");
    const result = await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("ENOENT");
  });

  it("names an old Codex that answers nothing for a method it does not know", async () => {
    const result = await trustCodexHooks({
      appServer: async () => ({ answers: [{}] }),
      hooksPath: "/missing/hooks.json",
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(result.problem).toContain("too old");
  });
});

describe("codexTrustProblem", () => {
  it("says nothing once every hook is trusted", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(
      await codexTrustProblem({
        appServer: codex.server,
        hooksPath: codex.hooksPath,
        hookCommand: "tacho hook",
        enrollmentId: TEST_ENROLLMENT,
      }),
    ).toBeUndefined();
  });

  it("reports an unreadable trust state instead of claiming verification", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    codex.breakWith("could not run `codex app-server`: ENOENT");
    expect(
      await codexTrustProblem({
        appServer: codex.server,
        hooksPath: codex.hooksPath,
        hookCommand: "tacho hook",
        enrollmentId: TEST_ENROLLMENT,
      }),
    ).toContain("ENOENT");
  });
});

describe("untrustCodexHooks", () => {
  it("removes the records trust wrote and leaves every other one alone", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    codex.trusted.set("/somebody/elses/hooks.json:stop:0:0", "sha256:theirs");
    await trustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    const removed = await untrustCodexHooks({
      appServer: codex.server,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(removed.problem).toBeUndefined();
    expect(removed.removed.length).toBeGreaterThan(0);
    expect([...codex.trusted.keys()]).toEqual([
      "/somebody/elses/hooks.json:stop:0:0",
    ]);
  });

  it("removes nothing, and asks nothing, when there was nothing recorded", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    expect(
      await untrustCodexHooks({
        appServer: codex.server,
        hooksPath: codex.hooksPath,
        hookCommand: "tacho hook",
        enrollmentId: TEST_ENROLLMENT,
      }),
    ).toEqual({ removed: [] });
    expect(
      codex.requests.filter((r) => r.method === "config/value/write"),
    ).toEqual([]);
  });
});

describe("trust readback failures", () => {
  it.each([undefined, { data: [{ hooks: [] }] }, { error: "unknown shape" }])(
    "does not report success for a missing or unreadable readback: %j",
    async (result) => {
      const codex = fakeCodexAppServer(seedHooksFile());
      const answer = await trustCodexHooks({
        enrollmentId: TEST_ENROLLMENT,
        hooksPath: codex.hooksPath,
        hookCommand: "tacho hook",
        appServer: async (requests) =>
          requests.length === 1
            ? codex.server(requests)
            : {
                answers: [
                  ...requests.slice(0, -1).map(() => ({ result: {} })),
                  result === undefined
                    ? { error: { message: "read refused" } }
                    : { result },
                ],
              },
      });
      expect(answer.ok).toBe(false);
      expect(answer.recorded).toEqual([]);
      expect(answer.pending.length).toBe(answer.found);
    },
  );

  it("never trusts a foreign file or an appended command carrying the same enrollment", async () => {
    const codex = fakeCodexAppServer(seedHooksFile());
    const answer = await trustCodexHooks({
      enrollmentId: TEST_ENROLLMENT,
      hooksPath: codex.hooksPath,
      hookCommand: "tacho hook",
      appServer: async (requests) => {
        const response = await codex.server(requests);
        for (const entry of response.answers) {
          const result = entry.result as
            | { data?: Array<{ hooks: unknown[] }> }
            | undefined;
          result?.data?.[0]?.hooks.push(
            hook({ key: "foreign", sourcePath: "/tmp/foreign/hooks.json" }),
            hook({
              key: "appended",
              sourcePath: codex.hooksPath,
              command: `tacho hook ${MARKER} --harness codex; another-command`,
            }),
          );
        }
        return response;
      },
    });
    expect(answer.ok).toBe(true);
    expect(codex.trusted.has("foreign")).toBe(false);
    expect(codex.trusted.has("appended")).toBe(false);
  });
});

describe("trust readback identity", () => {
  it.each(["missing", "changed", "disabled"] as const)(
    "keeps a %s hook pending after a successful write",
    async (mode) => {
      const codex = fakeCodexAppServer(seedHooksFile());
      const result = await trustCodexHooks({
        enrollmentId: TEST_ENROLLMENT,
        hooksPath: codex.hooksPath,
        hookCommand: "tacho hook",
        appServer: async (requests) => {
          const response = await codex.server(requests);
          if (requests.length > 1) {
            const read = response.answers.at(-1)?.result as {
              data: Array<{ hooks: Record<string, unknown>[] }>;
            };
            const hooks = read.data[0]!.hooks;
            if (mode === "missing") hooks.shift();
            else if (mode === "changed")
              hooks[0]!.currentHash = "sha256:new-definition";
            else hooks[0]!.enabled = false;
          }
          return response;
        },
      });
      expect(result.ok).toBe(false);
      expect(result.pending).toHaveLength(1);
      expect(result.recorded).toHaveLength(result.found - 1);
    },
  );
});
