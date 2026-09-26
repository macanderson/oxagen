import { tachoEventsColumns } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturedDiffOf,
  checkoutOf,
  readSessionConfig,
  readSessionTitle,
  readWorkContexts,
  readWorkDiffs,
  readWorkPrLinks,
  readWorkSubagents,
  runEffortOf,
  workDigest,
  type WorkContextRow,
  type WorkDiffRow,
} from "./run-work";

const chSelect = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/telemetry", async (original) => ({
  ...(await original<typeof import("@oxagen/telemetry")>()),
  chSelect,
}));
const context: WorkContextRow = {
  path: "/work/project",
  branch: "fix/one",
  head: "a".repeat(40),
  remote: workDigest("github.com/acme/repo"),
  repository: "",
  first_seq: 1,
  last_seq: 9,
};
const repository = {
  host: "github.com",
  owner: "acme",
  name: "repo",
  url: "https://github.com/acme/repo",
  connected: true,
  connectionId: "connection",
};
describe("run work evidence", () => {
  it("matches historical remote digests only against connected workspace repositories", () => {
    expect(checkoutOf(context, [repository]).repository).toMatchObject({
      connected: true,
      name: "repo",
    });
    expect(checkoutOf(context, []).repository).toBeNull();
  });
  it("keeps multiple checkout paths and branches distinct", () => {
    const original = checkoutOf(context, []);
    expect(checkoutOf({ ...context, path: "/other/worktree" }, []).id).not.toBe(
      original.id,
    );
    expect(checkoutOf({ ...context, branch: "fix/two" }, []).id).not.toBe(
      original.id,
    );
  });
  it("does not treat producer repository strings as a verified connection", () => {
    expect(
      checkoutOf(
        { ...context, repository: "https://github.com/other/repo" },
        [],
      ).repository?.connected,
    ).toBe(false);
    expect(
      checkoutOf(
        { ...context, repository: "https://secret@github.com/acme/repo" },
        [],
      ).repository,
    ).toBeNull();
  });
  it("distinguishes missing capture, withheld content, and partial retained patches", () => {
    const diff: WorkDiffRow = {
      ...context,
      seq: 9,
      observed_at: "2026-09-23",
      base: "b".repeat(40),
      content_digest: "",
      bytes_ref: "",
      complete: "true",
      limitations: "",
      omitted: "",
    };
    expect(capturedDiffOf(diff).completeness).toBe("not_captured");
    expect(
      capturedDiffOf({ ...diff, content_digest: "sha256:test" }).completeness,
    ).toBe("not_retained");
    expect(
      capturedDiffOf({
        ...diff,
        content_digest: "sha256:test",
        bytes_ref: "body",
        complete: "false",
        limitations: "patch_size_limit",
      }),
    ).toMatchObject({
      completeness: "partial",
      limitations: ["patch_size_limit"],
      seq: "9",
    });
  });
});

// Every ClickHouse read the Run page's work and header come from.
const READS = {
  readWorkContexts,
  readWorkSubagents,
  readWorkPrLinks,
  readWorkDiffs,
  readSessionConfig,
  readSessionTitle,
};
const SESSION = "0192d4a8-7c1e-7a00-8000-00000000c0de";

async function queryOf(
  read: (sessionUuid: string) => Promise<unknown>,
): Promise<string> {
  chSelect.mockClear();
  await read(SESSION);
  const [call] = chSelect.mock.calls;
  return (call?.[0] as { query: string }).query;
}

describe("run work reads", () => {
  beforeEach(() => {
    chSelect.mockResolvedValue({ data: [] });
  });
  // A ClickHouse alias applies to the whole query. `min(seq) AS seq` made
  // `argMin(ts, seq)` an aggregate inside an aggregate, and ClickHouse refused
  // every get_run_work call in production with code 184 (2026-09-24).
  it.each(Object.entries(READS))(
    "%s names no alias after a tacho_events column",
    async (_name, read) => {
      const columns = new Set(tachoEventsColumns().map(({ name }) => name));
      const query = await queryOf(read);
      const aliases = [...query.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)].map(
        (match) => match[1]!,
      );
      expect(aliases.length).toBeGreaterThan(0);
      expect(aliases.filter((alias) => columns.has(alias))).toEqual([]);
    },
  );
  // #3944: an `oxagen:pr_link` frame writes the dotted names the `pr_open`
  // effect frame writes, and one stored before the change carries the
  // underscore names. The read takes both, keyed on the frame's `pr.url`.
  it("reads a PR link under the dotted names, and under the old ones", async () => {
    const query = await queryOf(readWorkPrLinks);
    expect(query).toContain(
      "if(attrs['pr.url'] != '', attrs['pr.url'], attrs['pr_url']) AS url",
    );
    expect(query).toContain(
      "argMin(if(attrs['pr.url'] != '', attrs['pr.number'], attrs['pr_number']), seq) AS number",
    );
    expect(query).toContain(
      "AND if(attrs['pr.url'] != '', attrs['pr.url'], attrs['pr_url']) != ''",
    );
  });
  // ADR-171: a chain break is reported beside the facts, never by hiding the
  // frames past it.
  it.each(Object.entries(READS))(
    "%s reads every accepted frame, whatever its chain verdict",
    async (_name, read) => {
      expect(await queryOf(read)).not.toMatch(/chain_verified/);
    },
  );
});

describe("a run's effort and where it was read (#3891)", () => {
  const config = (row: Record<string, string> | null) => {
    chSelect.mockResolvedValueOnce({ data: row === null ? [] : [row] });
    return readSessionConfig(SESSION);
  };
  const row = (over: Record<string, string>) => ({
    requested: "",
    setting: "",
    reported_effort: "",
    thinking: "",
    ...over,
  });

  it("reads the proxied request's effort ahead of the harness's setting and report", async () => {
    await expect(
      config(row({ requested: "low", setting: "max", reported_effort: "high" })),
    ).resolves.toEqual({
      effort: "low",
      effortSource: "request",
      thinking: null,
    });
  });

  it("falls back to the harness's setting, then its report", async () => {
    await expect(
      config(row({ setting: "max", reported_effort: "high", thinking: "true" })),
    ).resolves.toEqual({
      effort: "max",
      effortSource: "harness",
      thinking: true,
    });
    await expect(config(row({ reported_effort: " high " }))).resolves.toEqual({
      effort: "high",
      effortSource: "harness",
      thinking: null,
    });
  });

  it("answers no effort and no source when no frame recorded one (negative)", async () => {
    await expect(config(null)).resolves.toEqual({
      effort: null,
      effortSource: null,
      thinking: null,
    });
    await expect(config(row({ requested: "  " }))).resolves.toMatchObject({
      effort: null,
      effortSource: null,
    });
  });

  it("reads the frames ahead of the session row, and the row as the harness's report", () => {
    expect(
      runEffortOf(
        { effort: "low", effortSource: "request", thinking: null },
        "high",
      ),
    ).toEqual({ effort: "low", effortSource: "request" });
    expect(
      runEffortOf({ effort: null, effortSource: null, thinking: null }, "high"),
    ).toEqual({ effort: "high", effortSource: "harness" });
    // A failed read leaves the row standing.
    expect(runEffortOf(null, "medium")).toEqual({
      effort: "medium",
      effortSource: "harness",
    });
    expect(runEffortOf(null, "")).toEqual({ effort: null, effortSource: null });
    expect(runEffortOf(null, null)).toEqual({
      effort: null,
      effortSource: null,
    });
  });
});
