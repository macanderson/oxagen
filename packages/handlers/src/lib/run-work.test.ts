import type { Tx } from "@oxagen/database";
import { canonicalRemote, digestBytes, foldedRemote } from "@oxagen/recorder";
import { tachoEventsColumns } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturedDiffOf,
  checkoutOf,
  foldProvisionalContexts,
  linkedRepositoryDigestsIn,
  readSessionConfig,
  readSessionTitle,
  readWorkContexts,
  readWorkDiffs,
  readRunPrLinks,
  readWorkPrLinks,
  readWorkSubagents,
  runEffortOf,
  workDigest,
  type WorkContextRow,
  type WorkDiffRow,
  WORK_PR_LINK_CAP,
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
      redactions: "",
      redaction_count: 0,
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

// #3791: the collector sets `diff_complete` from the snapshot, and the seal
// then redacts any credential out of the patch. The flag alone called a
// sanitized patch exact.
describe("a patch the recorder redacted", () => {
  const retained: WorkDiffRow = {
    ...context,
    seq: 9,
    observed_at: "2026-09-23",
    base: "b".repeat(40),
    content_digest: "sha256:test",
    bytes_ref: "body",
    complete: "true",
    limitations: "",
    omitted: "",
    redactions: "[]",
    redaction_count: 0,
  };
  const oneRedaction = JSON.stringify([
    {
      path: "bytes:10-50",
      reason: "github_token",
      original_digest: `sha256:${"c".repeat(64)}`,
    },
  ]);

  it("reads partial and names content_redacted when the recorder counted redactions", () => {
    expect(
      capturedDiffOf({
        ...retained,
        redactions: oneRedaction,
        redaction_count: "2",
      }),
    ).toMatchObject({
      completeness: "partial",
      limitations: ["content_redacted"],
    });
  });

  it("reads partial from the redaction list alone, for a frame with no count", () => {
    expect(
      capturedDiffOf({
        ...retained,
        redactions: oneRedaction,
        redaction_count: 0,
      }),
    ).toMatchObject({
      completeness: "partial",
      limitations: ["content_redacted"],
    });
  });

  it("keeps the collector's limitations beside the redaction", () => {
    expect(
      capturedDiffOf({
        ...retained,
        complete: "false",
        limitations: "patch_size_limit",
        redaction_count: 1,
      }).limitations,
    ).toEqual(["patch_size_limit", "content_redacted"]);
  });

  it("keeps not_retained ahead of partial when the redacted bytes were withheld", () => {
    expect(
      capturedDiffOf({ ...retained, bytes_ref: "", redaction_count: 1 }),
    ).toMatchObject({
      completeness: "not_retained",
      limitations: ["content_redacted"],
    });
  });

  it("reads a patch with no redaction complete (negative)", () => {
    for (const redactions of ["[]", ""])
      expect(
        capturedDiffOf({ ...retained, redactions, redaction_count: 0 }),
      ).toMatchObject({ completeness: "complete", limitations: [] });
    expect(
      capturedDiffOf({ ...retained, redactions: "[]", redaction_count: "0" })
        .completeness,
    ).toBe("complete");
  });
});

// #3791: the daemon seals a session's first hook before its first Git read,
// so that frame names the path alone. Grouped on its own, it was a second
// checkout that no repository or branch could match.
describe("foldProvisionalContexts", () => {
  const pathOnly: WorkContextRow = {
    path: "/work/project",
    branch: "",
    head: "",
    remote: "",
    repository: "",
    first_seq: 1,
    last_seq: 1,
  };
  const located: WorkContextRow = { ...context, first_seq: 2, last_seq: 9 };

  it("folds a path-only row into the Git context read after it at the same path", () => {
    const { rows, alias } = foldProvisionalContexts([pathOnly, located]);
    expect(rows).toEqual([{ ...located, first_seq: 1, last_seq: 9 }]);
    expect(alias).toEqual(
      new Map([[checkoutOf(pathOnly, []).id, checkoutOf(located, []).id]]),
    );
  });

  it("keeps each branch at the path its own checkout, and folds the path-only row into the first (negative)", () => {
    const second: WorkContextRow = {
      ...context,
      branch: "fix/two",
      head: "d".repeat(40),
      first_seq: 10,
      last_seq: 20,
    };
    const { rows, alias } = foldProvisionalContexts([
      pathOnly,
      located,
      second,
    ]);
    expect(rows.map(({ branch, first_seq }) => [branch, first_seq])).toEqual([
      ["fix/one", 1],
      ["fix/two", 10],
    ]);
    expect(alias.get(checkoutOf(pathOnly, []).id)).toBe(
      checkoutOf(located, []).id,
    );
  });

  it("keeps two repositories at the same path apart (negative)", () => {
    const other: WorkContextRow = {
      ...context,
      remote: workDigest("github.com/acme/other"),
      first_seq: 10,
      last_seq: 20,
    };
    const { rows, alias } = foldProvisionalContexts([located, other]);
    expect(rows).toEqual([located, other]);
    expect(alias.size).toBe(0);
  });

  it("folds a path-only row seen after every Git read into the latest context before it", () => {
    const second: WorkContextRow = {
      ...context,
      branch: "fix/two",
      first_seq: 10,
      last_seq: 20,
    };
    const late: WorkContextRow = { ...pathOnly, first_seq: 30, last_seq: 31 };
    const { rows, alias } = foldProvisionalContexts([located, second, late]);
    expect(rows).toEqual([located, { ...second, last_seq: 31 }]);
    expect(alias.get(checkoutOf(late, []).id)).toBe(checkoutOf(second, []).id);
  });

  // Review round 3 on #4382: the fold read only when each context started.
  // A session on fix/one visited fix/two and came back, so fix/one's row
  // spans 2 to 40 with its early start. A path-only frame at 30 folded into
  // fix/two, the context that started last before it, and stretched fix/two
  // over the frames fix/one holds.
  describe("a Git context the session came back to", () => {
    const back: WorkContextRow = { ...context, first_seq: 2, last_seq: 40 };
    const frame: WorkContextRow = { ...pathOnly, first_seq: 30, last_seq: 30 };

    it("folds a frame into the Git context whose span holds it, and stretches nothing (negative)", () => {
      const visit: WorkContextRow = {
        ...context,
        branch: "fix/two",
        head: "d".repeat(40),
        first_seq: 13,
        last_seq: 20,
      };
      const { rows, alias } = foldProvisionalContexts([back, visit, frame]);
      expect(rows).toEqual([back, visit]);
      expect(alias.get(checkoutOf(frame, []).id)).toBe(checkoutOf(back, []).id);
    });

    it("folds a frame two Git contexts span into the one that started last", () => {
      const visit: WorkContextRow = {
        ...context,
        branch: "fix/two",
        head: "d".repeat(40),
        first_seq: 13,
        last_seq: 35,
      };
      const { rows, alias } = foldProvisionalContexts([back, visit, frame]);
      expect(rows).toEqual([back, visit]);
      expect(alias.get(checkoutOf(frame, []).id)).toBe(
        checkoutOf(visit, []).id,
      );
    });
  });

  it("keeps a path-only row with no Git context at its path (negative)", () => {
    const elsewhere: WorkContextRow = { ...pathOnly, path: "/tmp/scratch" };
    const { rows, alias } = foldProvisionalContexts([elsewhere, located]);
    expect(rows).toEqual([elsewhere, located]);
    expect(alias.size).toBe(0);
  });

  it("does not fold a detached HEAD, which records its head (negative)", () => {
    const detached: WorkContextRow = { ...pathOnly, head: "e".repeat(40) };
    const { rows, alias } = foldProvisionalContexts([detached, located]);
    expect(rows).toEqual([detached, located]);
    expect(alias.size).toBe(0);
  });

  // Review round 1 on #4382: the read groups every path-only frame at a path
  // into one row. That row folded whole into the Git context after its first
  // frame, so a path-only frame seen later stretched that context over a
  // later branch's checkout.
  describe("a path-only row seen at two times", () => {
    const early: WorkContextRow = { ...located, last_seq: 10 };
    const elsewhere: WorkContextRow = {
      ...context,
      path: "/work/other",
      remote: workDigest("github.com/acme/other"),
      first_seq: 11,
      last_seq: 29,
    };

    it("folds each end into its own neighbour, so no folded span overlaps a later branch (negative)", () => {
      const second: WorkContextRow = {
        ...context,
        branch: "fix/two",
        head: "d".repeat(40),
        first_seq: 13,
        last_seq: 20,
      };
      const twice: WorkContextRow = { ...pathOnly, first_seq: 1, last_seq: 25 };
      const { rows, alias } = foldProvisionalContexts([twice, early, second]);
      // fix/one keeps 1 to 10, and fix/two takes the frame seen at 25.
      expect(rows).toEqual([
        { ...early, first_seq: 1 },
        { ...second, last_seq: 25 },
      ]);
      expect(alias.get(checkoutOf(twice, []).id)).toBe(
        checkoutOf(early, []).id,
      );
    });

    it("keeps a path-only frame that another checkout separates from the Git context before it (negative)", () => {
      const late: WorkContextRow = { ...pathOnly, first_seq: 30, last_seq: 30 };
      const { rows, alias } = foldProvisionalContexts([
        early,
        elsewhere,
        late,
      ]);
      expect(rows).toEqual([early, elsewhere, late]);
      expect(alias.size).toBe(0);
    });

    it("folds the first frame and keeps the later one when another checkout separates them (negative)", () => {
      const twice: WorkContextRow = { ...pathOnly, first_seq: 1, last_seq: 30 };
      const { rows, alias } = foldProvisionalContexts([
        twice,
        early,
        elsewhere,
      ]);
      expect(rows).toEqual([
        { ...early, first_seq: 1 },
        elsewhere,
        { ...pathOnly, first_seq: 30, last_seq: 30 },
      ]);
      // The row stays in part, so a diff on it keeps its own checkout.
      expect(alias.size).toBe(0);
    });

    it("folds a frame into the Git context after it only when no other context starts first (negative)", () => {
      const hook: WorkContextRow = { ...pathOnly, first_seq: 10, last_seq: 10 };
      const later: WorkContextRow = { ...located, first_seq: 30, last_seq: 40 };
      const between: WorkContextRow = { ...elsewhere, first_seq: 20 };
      const { rows, alias } = foldProvisionalContexts([hook, between, later]);
      expect(rows).toEqual([hook, between, later]);
      expect(alias.size).toBe(0);
    });
  });
});

const SESSION = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";

// Every ClickHouse read the Run page's work, header and spine come from.
const READS = {
  readWorkContexts,
  readWorkSubagents,
  readWorkPrLinks,
  readRunPrLinks: (sessionUuid: string) => readRunPrLinks(sessionUuid, [CHILD]),
  readWorkDiffs,
  readSessionConfig,
  readSessionTitle,
};

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
  // A pull request opened with `gh pr create` or an MCP tool is recorded on
  // a `pr_open` effect frame and may never get a pr_link frame. The work
  // read and the spine count it, as `list_runs` does (#5259).
  it.each([
    ["readWorkPrLinks", readWorkPrLinks],
    ["readRunPrLinks", READS.readRunPrLinks],
  ] as const)(
    "%s counts a pr_open frame that carries a URL",
    async (_name, read) => {
      const query = await queryOf(read);
      expect(query).toContain(
        "(kind = 'oxagen:pr_link' OR attrs['pr.url'] != '')",
      );
    },
  );
  // #3823: a subagent records on a chain of its own, so the spine reads its
  // PR links too. Each subagent chain is fenced by the run's root, so a chain
  // of another run named in the list reads nothing.
  it("reads a PR link on the run's own chain and on each listed subagent chain, fenced by the root", async () => {
    chSelect.mockClear();
    await readRunPrLinks(SESSION, [CHILD]);
    const [call] = chSelect.mock.calls;
    const { query, params } = call?.[0] as {
      query: string;
      params: Record<string, unknown>;
    };
    expect(query).toContain("session_uuid IN {sessionUuids:Array(UUID)}");
    expect(query).toMatch(
      /\(session_uuid = \{rootSessionUuid:UUID\}\s+OR root_session_uuid = \{rootSessionUuid:UUID\}\)/,
    );
    expect(query).toContain("GROUP BY url");
    expect(params).toMatchObject({
      rootSessionUuid: SESSION,
      sessionUuids: [SESSION, CHILD],
    });
  });
  // #5311: a run with thousands of subagent chains named more than one URL
  // field holds, and ClickHouse refused the read before it ran.
  it("splits a long chain list across parameters, and reads by the root past the URL budget", async () => {
    const chains = Array.from(
      { length: 10_000 },
      (_, i) => `0192d4a8-7c1e-7a00-8000-${i.toString(16).padStart(12, "0")}`,
    );
    const sent = () =>
      chSelect.mock.calls[0]?.[0] as {
        query: string;
        params: Record<string, unknown>;
      };
    chSelect.mockClear();
    // The run's own chain and 1,000 subagent chains: 1,001 in all.
    await readRunPrLinks(SESSION, chains.slice(0, 1_000));
    const split = sent();
    expect(split.query).toContain(
      "AND (session_uuid IN {sessionUuids:Array(UUID)} OR session_uuid IN {sessionUuids1:Array(UUID)})",
    );
    expect(split.params["sessionUuids"]).toEqual([
      SESSION,
      ...chains.slice(0, 999),
    ]);
    expect(split.params["sessionUuids1"]).toEqual([chains[999]]);
    chSelect.mockClear();
    // 10,001 chains pass the URL budget, and the root predicate alone reads them.
    await readRunPrLinks(SESSION, chains);
    const byRoot = sent();
    expect(byRoot.query).not.toContain("sessionUuids");
    expect(byRoot.query).toMatch(
      /\(session_uuid = \{rootSessionUuid:UUID\}\s+OR root_session_uuid = \{rootSessionUuid:UUID\}\)/,
    );
    expect(byRoot.params).toEqual({
      rootSessionUuid: SESSION,
      limit: WORK_PR_LINK_CAP + 1,
    });
  });
  // The read grouped by chain and URL, so a PR the run and a subagent both
  // linked took two of the 51 rows the limit allows: 30 shared PRs filled
  // the cap, and a PR only another subagent linked never reached the spine.
  // One row per URL keeps the limit a count of pull requests.
  it("reads one row per PR across the run's chains, at the run's own frame first", async () => {
    chSelect.mockClear();
    chSelect.mockResolvedValueOnce({
      data: [
        {
          url: "https://github.com/acme/app/pull/41",
          chain: SESSION,
          number: "41",
          repository: "acme/app",
          first_seq: 10,
          first_ts: "2026-09-24 10:00:10.000",
        },
        {
          url: "https://github.com/acme/app/pull/43",
          chain: CHILD,
          number: "43",
          repository: "acme/app",
          first_seq: 2,
          first_ts: "2026-09-24 10:01:02.000",
        },
      ],
    });
    const rows = await readRunPrLinks(SESSION, [CHILD]);
    const [call] = chSelect.mock.calls;
    const { query, params } = call?.[0] as {
      query: string;
      params: Record<string, unknown>;
    };
    expect(query).toMatch(/GROUP BY url\s+ORDER BY/);
    expect(query).not.toMatch(/GROUP BY session_uuid/);
    // The chain, number, first frame and time all come from one frame: the
    // run's own chain ranks ahead of any subagent chain.
    const first =
      "(session_uuid != {rootSessionUuid:UUID}, session_uuid, seq)";
    for (const column of ["session_uuid", "seq"]) {
      expect(query).toContain(`argMin(${column}, ${first})`);
    }
    expect(query).toContain(`toString(argMin(ts, ${first})) AS first_ts`);
    expect(params["limit"]).toBe(WORK_PR_LINK_CAP + 1);
    expect(rows.map((row) => [row.session_uuid, row.url])).toEqual([
      [SESSION, "https://github.com/acme/app/pull/41"],
      [CHILD, "https://github.com/acme/app/pull/43"],
    ]);
    expect(rows[0]).not.toHaveProperty("chain");
  });
  // #3791: a captured diff reads the redactions the seal recorded, so a
  // sanitized patch is not called exact.
  it("reads a captured diff's redaction list and count", async () => {
    const query = await queryOf(readWorkDiffs);
    expect(query).toMatch(/\bomitted, redactions,/);
    expect(query).toContain(
      "toUInt32OrZero(attrs['oxagen.content_redactions_total']) AS redaction_count",
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

// ADR-212: ingest stamps `repository_unlinked` from these digests. They must
// match the session's `git_remote_digest`, which the host computes with
// `canonicalRemote` and keeps the remote's case.
describe("linkedRepositoryDigestsIn", () => {
  const scope = { orgId: "org-1", workspaceId: "ws-1" };
  function txAnswering(read: () => Promise<unknown[]>) {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: read,
    };
    const savepoint = { select: () => chain };
    const transaction = vi.fn(
      (fn: (savepoint: unknown) => Promise<unknown>) => fn(savepoint),
    );
    return { tx: { transaction } as unknown as Tx, transaction };
  }

  it("digests every head in the workspace, GitLab ones too, in the host's case and folded", async () => {
    const { tx, transaction } = txAnswering(async () => [
      { provider: "github", fullName: "Acme/Platform" },
      { provider: "gitlab", fullName: "group/sub/api" },
    ]);
    const digests = await linkedRepositoryDigestsIn(tx, scope);
    const github = canonicalRemote("github.com/Acme/Platform");
    const gitlab = canonicalRemote("gitlab.com/group/sub/api");
    expect(digests.has(digestBytes(github))).toBe(true);
    expect(digests.has(digestBytes(foldedRemote(github)))).toBe(true);
    expect(digests.has(digestBytes(gitlab))).toBe(true);
    // The read runs in one savepoint on the caller's transaction.
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("answers no digest for a workspace with no linked repository (negative)", async () => {
    const { tx } = txAnswering(async () => []);
    expect(await linkedRepositoryDigestsIn(tx, scope)).toEqual(new Set());
  });

  it("rejects when the read fails, so the caller logs it and opens the session unflagged (negative)", async () => {
    const { tx } = txAnswering(() =>
      Promise.reject(new Error("canceling statement due to statement timeout")),
    );
    await expect(linkedRepositoryDigestsIn(tx, scope)).rejects.toThrow(
      "statement timeout",
    );
  });
});
