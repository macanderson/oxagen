import { tachoEventsColumns } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturedDiffOf,
  checkoutOf,
  foldProvisionalContexts,
  readSessionConfig,
  readSessionTitle,
  readWorkContexts,
  readWorkDiffs,
  readWorkPrLinks,
  readWorkSubagents,
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
