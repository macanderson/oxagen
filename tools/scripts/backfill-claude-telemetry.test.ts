/**
 * One bad transcript must not turn into an unexplained number (#2556).
 *
 * `parseAllFiles` isolates a file that throws — a truncated JSONL from a
 * crashed session, a hand-edited line — from the rest of the scan. Before
 * this test the isolating `catch` threw the file path and the error message
 * away and kept only a count, so a backfill run that printed "Parsed 40
 * files, 3 errors" gave the operator nothing to act on short of re-running
 * under a debugger to rediscover which three and why.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAllFiles,
  insertRows,
  type FileRef,
} from "./backfill-claude-telemetry.js";
import type { ClaudeSessionRow } from "./backfill-claude-telemetry.js";

describe("parseAllFiles (#2556)", () => {
  it("names the file and keeps the error message for a failing parse", async () => {
    const files: FileRef[] = [
      { path: "/home/mac/.claude/projects/x/good.jsonl", isSubagent: false },
      {
        path: "/home/mac/.claude/projects/x/truncated.jsonl",
        isSubagent: false,
      },
    ];
    const lines: string[] = [];

    const summary = await parseAllFiles(
      files,
      async (path) => {
        if (path.endsWith("truncated.jsonl")) {
          throw new Error("Unexpected end of JSON input");
        }
        return [{ session_id: "s1" } as unknown as ClaudeSessionRow];
      },
      (line) => lines.push(line),
    );

    expect(summary.ok).toBe(1);
    expect(summary.fail).toBe(1);
    expect(summary.failures).toEqual([
      {
        path: "/home/mac/.claude/projects/x/truncated.jsonl",
        message: "Unexpected end of JSON input",
      },
    ]);
    // The old behavior only ever incremented a counter — nothing written for
    // a failing file. The fix must write a line naming it, not just tally it.
    expect(lines.some((l) => l.includes("truncated.jsonl"))).toBe(true);
    expect(lines.some((l) => l.includes("Unexpected end of JSON input"))).toBe(
      true,
    );
  });

  it("does not lose rows already parsed before a later file fails", async () => {
    const files: FileRef[] = [
      { path: "/a.jsonl", isSubagent: false },
      { path: "/b.jsonl", isSubagent: true },
    ];

    const summary = await parseAllFiles(
      files,
      async (path, isSubagent) => {
        if (isSubagent) throw new Error("boom");
        return [{ session_id: "kept" } as unknown as ClaudeSessionRow];
      },
      () => {},
    );

    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ session_id: "kept" });
    expect(summary.fail).toBe(1);
    expect(summary.failures[0]?.path).toBe("/b.jsonl");
  });

  it("stringifies a non-Error throw rather than dropping it", async () => {
    const files: FileRef[] = [{ path: "/weird.jsonl", isSubagent: false }];

    const summary = await parseAllFiles(
      files,
      async () => {
        throw "not an Error instance";
      },
      () => {},
    );

    expect(summary.failures).toEqual([
      { path: "/weird.jsonl", message: "not an Error instance" },
    ]);
  });
});

describe("legacy backfill address retirement", () => {
  it("produces identical rows for transcripts that differ only in email metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oxagen-backfill-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T01:00:00.000Z"));
    try {
      const files: FileRef[] = [];
      for (const [index, email] of [
        "first@example.test",
        "second@example.test",
      ].entries()) {
        const path = join(dir, `${index}.jsonl`);
        await writeFile(
          path,
          JSON.stringify({
            type: "assistant",
            uuid: "11111111-1111-4111-8111-111111111111",
            sessionId: "22222222-2222-4222-8222-222222222222",
            timestamp: "2026-09-20T00:00:00.000Z",
            user_email: email,
            anthropic: { user_email: email },
            message: {
              model: "claude-sonnet-4-6",
              content: [],
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          }),
        );
        files.push({ path, isSubagent: false });
      }
      const { rows, fail } = await parseAllFiles(files, undefined, () => {});
      expect(fail).toBe(0);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[0]).not.toHaveProperty("user_email");
      expect(JSON.stringify(rows)).not.toContain("@example.test");
      expect(rows[0]).toMatchObject({ tokens_in: 10, tokens_out: 2 });
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy replacement keys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const old = {
    session_id: "22222222-2222-4222-8222-222222222222",
    entry_uuid: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-09-20T00:00:00.000Z",
    tokens_in: 10,
  } as ClaudeSessionRow;
  const next = { ...old, entry_uuid: "33333333-3333-4333-8333-333333333333" };
  function env() {
    vi.stubEnv("PRODUCTION_ANALYTICS_URL", "https://analytics.example.test");
    vi.stubEnv("PRODUCTION_ANALYTICS_USER", "test");
    vi.stubEnv("PRODUCTION_ANALYTICS_PASSWORD", "test");
  }
  it("skips identities stored under the retired key and inserts only new identities", async () => {
    env();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: old.session_id,
            entry_uuid: old.entry_uuid,
            timestamp_ms: String(Date.parse(old.timestamp)),
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(""));
    expect(await insertRows([old, next, next], request)).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    const query = String(request.mock.calls[0]?.[1]?.body);
    expect(query).toContain("(session_id, timestamp, entry_uuid) IN");
    expect(query).not.toContain("user_email");
    const body = String(request.mock.calls[1]?.[1]?.body);
    expect(body).toContain(next.entry_uuid);
    expect(body).not.toContain(old.entry_uuid);
    expect(body).not.toContain("user_email");
    request.mockReset().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session_id: next.session_id,
          entry_uuid: next.entry_uuid,
          timestamp_ms: Date.parse(next.timestamp),
        }),
      ),
    );
    expect(await insertRows([next], request)).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });
  it("refuses a malformed identity response before insertion", async () => {
    env();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session_id: old.session_id })),
      );
    await expect(insertRows([next], request)).rejects.toThrow(
      "Invalid ClickHouse identity response",
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("refuses insertion when it cannot read the existing identities", async () => {
    env();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(insertRows([next], request)).rejects.toThrow(
      "identity lookup 503",
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("names the three settings it needs rather than reaching a store it cannot address", async () => {
    // An empty password is a password. Only an unset one is a missing setting,
    // which is why the guard reads `pass === undefined` and not `!pass`.
    for (const missing of [
      "PRODUCTION_ANALYTICS_URL",
      "PRODUCTION_ANALYTICS_USER",
      "PRODUCTION_ANALYTICS_PASSWORD",
    ]) {
      env();
      vi.stubEnv(missing, "");
      if (missing === "PRODUCTION_ANALYTICS_PASSWORD") {
        // Empty is accepted, so this one has to be genuinely unset to refuse.
        const request = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(""))
          .mockResolvedValueOnce(new Response(""));
        expect(await insertRows([next], request)).toBe(1);
        vi.stubEnv(missing, undefined);
      }
      const request = vi.fn<typeof fetch>();
      await expect(insertRows([next], request)).rejects.toThrow(
        "Set PRODUCTION_ANALYTICS_URL, PRODUCTION_ANALYTICS_USER, PRODUCTION_ANALYTICS_PASSWORD",
      );
      expect(request).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    }
  });
  it("refuses an entry whose identity is not a pair of UUIDs", async () => {
    // The identity goes into the lookup as SQL literals, so a value that is
    // not a UUID is refused before it is interpolated rather than quoted.
    env();
    for (const row of [
      { ...next, session_id: "not-a-uuid" },
      { ...next, entry_uuid: "'); drop table internal.claude_sessions; --" },
    ]) {
      const request = vi.fn<typeof fetch>();
      await expect(insertRows([row], request)).rejects.toThrow(
        "Invalid backfill entry identity",
      );
      expect(request).not.toHaveBeenCalled();
    }
  });
  it("reports the store's refusal of the insert, with its status and body", async () => {
    env();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(new Response("TOO_MANY_PARTS", { status: 500 }));
    await expect(insertRows([next], request)).rejects.toThrow(
      "ClickHouse 500: TOO_MANY_PARTS",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it.skipIf(!process.env["CLICKHOUSE_URL"])(
  "does not duplicate a legacy replacement key in ClickHouse",
  async () => {
    const url = process.env["CLICKHOUSE_URL"]!;
    const user = process.env["CLICKHOUSE_USERNAME"] ?? "default";
    const pass = process.env["CLICKHOUSE_PASSWORD"] ?? "";
    const session = randomUUID();
    const oldId = randomUUID();
    const nextId = randomUUID();
    const database = process.env["CLICKHOUSE_DATABASE"] ?? "default";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database))
      throw new Error("Invalid test database");
    const table = `${database}.backfill_${session.replaceAll("-", "")}`;
    const request: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        body: String(init?.body ?? "").replaceAll(
          "internal.claude_sessions",
          table,
        ),
      });
    const timestamp = "2026-09-20T00:00:00.000Z";
    const query = async (body: string) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${user}:${pass}`)}` },
        body,
      });
      if (!response.ok) throw new Error(await response.text());
      return response.text();
    };
    vi.stubEnv("PRODUCTION_ANALYTICS_URL", url);
    vi.stubEnv("PRODUCTION_ANALYTICS_USER", user);
    vi.stubEnv("PRODUCTION_ANALYTICS_PASSWORD", pass);
    const old = {
      session_id: session,
      entry_uuid: oldId,
      timestamp,
      tokens_in: 10,
    } as ClaudeSessionRow;
    const next = { ...old, entry_uuid: nextId };
    try {
      await query(`CREATE TABLE ${table} AS ${database}.claude_sessions`);
      await query(
        `INSERT INTO ${table} SETTINGS date_time_input_format = 'best_effort' FORMAT JSONEachRow\n${JSON.stringify({ ...old, user_email: "legacy@example.test" })}`,
      );
      expect(await insertRows([old, next], request)).toBe(1);
      expect(await insertRows([old, next], request)).toBe(0);
      const count = await query(
        `SELECT count(), sum(tokens_in) FROM ${table} FINAL WHERE session_id = '${session}' FORMAT TabSeparated`,
      );
      expect(count.trim()).toBe("2\t20");
    } finally {
      vi.unstubAllEnvs();
      await query(`DROP TABLE IF EXISTS ${table}`);
    }
  },
);
