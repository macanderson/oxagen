import { describe, expect, it, vi } from "vitest";
import { recordIdSchema, sha256Schema } from "@oxagen/oxagen/steering-repo/common";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  ledgerChainBreaks,
  promotionLineHash,
  promotionSchema,
  type PromotionLine,
} from "@oxagen/oxagen/steering-repo/promotion";
import {
  branchPrefixForPath,
  branchScopeRefusal,
  buildLedgerLine,
  chooseLedgerTarget,
  isStampedRecordPath,
  ledgerInstant,
  ledgerPeriodBounds,
  mergeTrailers,
  stampRecordText,
  steeringBranch,
  type LedgerLineInput,
} from "./stamp";

const RECORD_PATH =
  "steering/platform/a-intel.platform.headings-sentence-case.md";

const UNSTAMPED = [
  "---",
  "schema: steering-record/v1",
  "lineage: a-intel.platform.release-notes",
  "label: Release notes",
  "kind: rule",
  "force: must",
  "scope: workspace",
  "status: active",
  "origin: user",
  "---",
  "",
  "Every release has notes.",
  "",
].join("\n");

describe("stampRecordText", () => {
  it("gives back a record the fixture already stamped, byte for byte", () => {
    const text = fixtureRepo().get(RECORD_PATH)!;
    const stamped = stampRecordText(text);
    expect(stamped).toMatchObject({
      ok: true,
      text,
      lineage: "a-intel.platform.headings-sentence-case",
    });
  });

  it("writes id and hash as the last two keys of an unstamped record", () => {
    const stamped = stampRecordText(UNSTAMPED);
    if (!stamped.ok) throw new Error(stamped.message);
    expect(recordIdSchema.safeParse(stamped.id).success).toBe(true);
    expect(sha256Schema.safeParse(stamped.hash).success).toBe(true);
    expect(stamped.id).toMatch(/^rec_a_intel_platform_release_notes_/);
    const lines = stamped.text.split("\n");
    const close = lines.indexOf("---", 1);
    expect(lines.slice(close - 2, close)).toEqual([
      `id: ${stamped.id}`,
      `hash: ${stamped.hash}`,
    ]);
    expect(stamped.text.endsWith("\nEvery release has notes.\n")).toBe(true);
  });

  it("is idempotent", () => {
    const once = stampRecordText(UNSTAMPED);
    if (!once.ok) throw new Error(once.message);
    expect(stampRecordText(once.text)).toEqual(once);
  });

  it("replaces a stale id and hash wherever they sit", () => {
    const stale = UNSTAMPED.replace(
      "label: Release notes\n",
      "id: rec_a_intel_platform_release_notes_000000000000\nlabel: Release notes\nhash: sha256:" +
        "0".repeat(64) +
        "\n",
    );
    const fresh = stampRecordText(UNSTAMPED);
    const restamped = stampRecordText(stale);
    expect(restamped).toEqual(fresh);
  });

  it("drops a stale value's indented continuation lines", () => {
    const stale = UNSTAMPED.replace(
      "origin: user\n",
      "origin: user\nhash:\n  sha256:abc\n",
    );
    expect(stampRecordText(stale)).toEqual(stampRecordText(UNSTAMPED));
  });

  it("gives a different hash when the statement changes", () => {
    const a = stampRecordText(UNSTAMPED);
    const b = stampRecordText(UNSTAMPED.replace("has notes", "has short notes"));
    if (!a.ok || !b.ok) throw new Error("stamp failed");
    expect(b.hash).not.toBe(a.hash);
    expect(b.id).not.toBe(a.id);
  });

  it("keeps the same id and hash when only the label changes", () => {
    const a = stampRecordText(UNSTAMPED);
    const b = stampRecordText(UNSTAMPED.replace("Release notes", "Notes"));
    if (!a.ok || !b.ok) throw new Error("stamp failed");
    expect(b.id).toBe(a.id);
    expect(b.hash).toBe(a.hash);
  });

  it("refuses a file with no frontmatter", () => {
    expect(stampRecordText("Every release has notes.\n")).toMatchObject({
      ok: false,
    });
  });

  it("refuses frontmatter that is not YAML in the strict subset", () => {
    expect(
      stampRecordText("---\nlineage: a\nlineage: b\n---\nBody.\n"),
    ).toMatchObject({ ok: false });
  });

  it("refuses a record that names no lineage", () => {
    expect(stampRecordText("---\nkind: rule\n---\nBody.\n")).toEqual({
      ok: false,
      message: "the record names no lineage",
    });
  });
});

describe("isStampedRecordPath", () => {
  it("is true for records and skill records only", () => {
    expect(isStampedRecordPath(RECORD_PATH)).toBe(true);
    expect(
      isStampedRecordPath("steering/skills/a-intel.brand.voice/SKILL.md"),
    ).toBe(true);
    expect(
      isStampedRecordPath("steering/skills/a-intel.brand.voice/words.md"),
    ).toBe(false);
    expect(isStampedRecordPath("steering/promotions/2026-09.jsonl")).toBe(
      false,
    );
    expect(isStampedRecordPath("workspace.toml")).toBe(false);
  });
});

describe("ledgerPeriodBounds", () => {
  it("bounds a year, a month, and a day in UTC", () => {
    expect(ledgerPeriodBounds("2026")).toEqual({
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2027, 0, 1),
    });
    expect(ledgerPeriodBounds("2026-12")).toEqual({
      start: Date.UTC(2026, 11, 1),
      end: Date.UTC(2027, 0, 1),
    });
    expect(ledgerPeriodBounds("2026-09-26")).toEqual({
      start: Date.UTC(2026, 8, 26),
      end: Date.UTC(2026, 8, 27),
    });
  });

  it("starts an ISO week on its Monday", () => {
    expect(ledgerPeriodBounds("2026-W39")?.start).toBe(Date.UTC(2026, 8, 21));
    expect(ledgerPeriodBounds("2021-W01")?.start).toBe(Date.UTC(2021, 0, 4));
    expect(ledgerPeriodBounds("2020-W53")).toEqual({
      start: Date.UTC(2020, 11, 28),
      end: Date.UTC(2021, 0, 4),
    });
  });

  it("is null for a name that is not a period", () => {
    expect(ledgerPeriodBounds("september")).toBeNull();
  });
});

// ── Ledger fixtures ──────────────────────────────────────────────────────────

const BASE_LINE: Omit<LedgerLineInput, "seq" | "prev" | "at"> = {
  provider: "github",
  number: 7,
  branch: "steering/a-intel.platform.release-notes",
  mode: "team",
  approvedBy: ["dana"],
  mergedBy: "priya",
  withoutReview: false,
  changes: [
    {
      path: "steering/platform/a-intel.platform.release-notes.md",
      action: "added",
    },
  ],
};

/** `count` chained lines from `seq`, as one file's text, and the last hash. */
function ledgerText(
  count: number,
  from: { seq: number; prev: string | null; at: Date },
): { text: string; last: string | null } {
  let prev = from.prev;
  let text = "";
  for (let i = 0; i < count; i += 1) {
    const built = buildLedgerLine({
      ...BASE_LINE,
      seq: from.seq + i,
      prev,
      at: new Date(from.at.getTime() + i * 1000),
    });
    if (!built.ok) throw new Error(built.message);
    text += built.line;
    prev = built.hash;
  }
  return { text, last: prev };
}

function repo(files: Record<string, string>) {
  const read = vi.fn(async (path: string) => files[path] ?? null);
  return { paths: Object.keys(files), read };
}

const SEP_26 = new Date("2026-09-26T12:00:00.123Z");

describe("chooseLedgerTarget", () => {
  it("opens the period's first file when the ledger is empty", async () => {
    const { paths, read } = repo({ "steering/promotions/.gitkeep": "" });
    await expect(
      chooseLedgerTarget({
        paths,
        read,
        at: SEP_26,
        rotate: "month",
        maxLines: 10_000,
      }),
    ).resolves.toEqual({
      ok: true,
      path: "steering/promotions/2026-09.jsonl",
      existing: "",
      prev: null,
      seq: 1,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("appends to the fixture ledger and continues its chain", async () => {
    const fixture = fixtureRepo();
    const ledgerPath = "steering/promotions/2026-09.jsonl";
    const text = fixture.get(ledgerPath)!;
    const { paths, read } = repo({ [ledgerPath]: text });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target).toEqual({
      ok: true,
      path: ledgerPath,
      existing: text,
      prev: "sha256:50cbbe698cb887bc28af63fe00d92e8c5d2f39bc1f324fbb4e8e7b7589073a91",
      seq: 21,
    });
  });

  it("opens the next file at max_lines and carries the chain across files", async () => {
    const first = ledgerText(3, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": first.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 3,
    });
    expect(target).toEqual({
      ok: true,
      path: "steering/promotions/2026-09.002.jsonl",
      existing: "",
      prev: first.last,
      seq: 4,
    });
    if (!target.ok) return;
    const next = buildLedgerLine({
      ...BASE_LINE,
      seq: target.seq,
      prev: target.prev,
      at: SEP_26,
    });
    if (!next.ok) throw new Error(next.message);
    const lines = (first.text + next.line)
      .trimEnd()
      .split("\n")
      .map((line) => promotionSchema.parse(JSON.parse(line)) as PromotionLine);
    expect(ledgerChainBreaks(lines, null)).toEqual([]);
  });

  it("reads only the highest-numbered file of a period", async () => {
    const first = ledgerText(2, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const second = ledgerText(1, {
      seq: 3,
      prev: first.last,
      at: new Date("2026-09-10T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": first.text,
      "steering/promotions/2026-09.002.jsonl": second.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 2,
    });
    expect(target).toEqual({
      ok: true,
      path: "steering/promotions/2026-09.002.jsonl",
      existing: second.text,
      prev: second.last,
      seq: 4,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("steering/promotions/2026-09.002.jsonl");
  });

  it("opens a new period's file with the last hash of the period before", async () => {
    const september = ledgerText(2, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-08.jsonl": "not read\n",
      "steering/promotions/2026-09.jsonl": september.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: new Date("2026-10-01T00:00:00Z"),
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target).toEqual({
      ok: true,
      path: "steering/promotions/2026-10.jsonl",
      existing: "",
      prev: september.last,
      seq: 3,
    });
    expect(read).not.toHaveBeenCalledWith("steering/promotions/2026-08.jsonl");
  });

  it("follows the chain when rotate changes from month to day", async () => {
    const month = ledgerText(2, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const day = ledgerText(2, {
      seq: 3,
      prev: month.last,
      at: new Date("2026-09-25T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": month.text,
      "steering/promotions/2026-09-25.jsonl": day.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "day",
      maxLines: 10_000,
    });
    expect(target).toEqual({
      ok: true,
      path: "steering/promotions/2026-09-26.jsonl",
      existing: "",
      prev: day.last,
      seq: 5,
    });
  });

  it("opens a new file rather than append to a period file that is not the tail", async () => {
    const month = ledgerText(2, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const day = ledgerText(2, {
      seq: 3,
      prev: month.last,
      at: new Date("2026-09-25T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": month.text,
      "steering/promotions/2026-09-25.jsonl": day.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target).toEqual({
      ok: true,
      path: "steering/promotions/2026-09.002.jsonl",
      existing: "",
      prev: day.last,
      seq: 5,
    });
  });

  it("uses ISO week files when rotate is week", async () => {
    const { paths, read } = repo({});
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "week",
      maxLines: 10_000,
    });
    expect(target).toMatchObject({
      ok: true,
      path: "steering/promotions/2026-W39.jsonl",
    });
  });

  it("refuses a tail file whose chain is broken", async () => {
    const good = ledgerText(3, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const lines = good.text.trimEnd().split("\n");
    const tampered = JSON.parse(lines[1]!) as PromotionLine;
    tampered.merged_by = "mallory";
    lines[1] = JSON.stringify(tampered);
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": `${lines.join("\n")}\n`,
    });
    await expect(
      chooseLedgerTarget({
        paths,
        read,
        at: SEP_26,
        rotate: "month",
        maxLines: 10_000,
      }),
    ).resolves.toEqual({
      ok: false,
      message: "steering/promotions/2026-09.jsonl breaks the ledger chain at line 2",
    });
  });

  it("refuses a tail file that is not ledger lines", async () => {
    const { paths, read } = repo({
      "steering/promotions/2026-09.jsonl": "{}\n",
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target.ok).toBe(false);
    if (!target.ok) {
      expect(target.message).toMatch(/^steering\/promotions\/2026-09\.jsonl line 1: /);
    }
  });

  it("refuses a listed file that cannot be read", async () => {
    const target = await chooseLedgerTarget({
      paths: ["steering/promotions/2026-09.jsonl"],
      read: async () => null,
      at: SEP_26,
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target).toEqual({
      ok: false,
      message: "steering/promotions/2026-09.jsonl is listed but cannot be read",
    });
  });

  it("refuses when the period already holds 999 full files", async () => {
    const full = ledgerText(1, {
      seq: 1,
      prev: null,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const { paths, read } = repo({
      "steering/promotions/2026-09.999.jsonl": full.text,
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 1,
    });
    expect(target.ok).toBe(false);
  });

  it("ignores files that are not ledger files", async () => {
    const { paths, read } = repo({
      "steering/promotions/README.md": "notes\n",
      "steering/promotions/old/2026-01.jsonl": "{}\n",
      "steering/governance.toml": "mode = 'team'\n",
    });
    const target = await chooseLedgerTarget({
      paths,
      read,
      at: SEP_26,
      rotate: "month",
      maxLines: 10_000,
    });
    expect(target).toMatchObject({ ok: true, seq: 1, prev: null });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("buildLedgerLine", () => {
  it("writes a promotion/v1 line whose hash covers the line", () => {
    const built = buildLedgerLine({
      ...BASE_LINE,
      seq: 1,
      prev: null,
      at: SEP_26,
      changes: [
        { path: "steering/b.md", action: "added" },
        { path: "steering/a.md", action: "removed" },
      ],
    });
    if (!built.ok) throw new Error(built.message);
    expect(built.line.endsWith("\n")).toBe(true);
    const line = promotionSchema.parse(JSON.parse(built.line)) as PromotionLine;
    expect(line.hash).toBe(built.hash);
    expect(promotionLineHash(line)).toBe(built.hash);
    expect(line.at).toBe("2026-09-26T12:00:00Z");
    expect(line.changes.map((c) => c.path)).toEqual([
      "steering/a.md",
      "steering/b.md",
    ]);
  });

  it("refuses a branch without a steering prefix", () => {
    const built = buildLedgerLine({
      ...BASE_LINE,
      branch: "context/a-intel.platform.release-notes",
      seq: 1,
      prev: null,
      at: SEP_26,
    });
    expect(built.ok).toBe(false);
  });

  it("refuses an actor the schema does not allow", () => {
    const built = buildLedgerLine({
      ...BASE_LINE,
      mergedBy: "Priya Rao",
      seq: 1,
      prev: null,
      at: SEP_26,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toMatch(/promotion\/v1/);
  });
});

describe("ledgerInstant", () => {
  it("writes whole seconds in UTC", () => {
    expect(ledgerInstant(new Date("2026-09-26T12:00:00.999Z"))).toBe(
      "2026-09-26T12:00:00Z",
    );
  });
});

describe("mergeTrailers", () => {
  it("names the approvers, the checks, and the version", () => {
    expect(
      mergeTrailers({
        approvedBy: ["dana", "priya"],
        withoutReviewBy: null,
        checks: ["schema", "lineage", "hash"],
        version: 413,
      }),
    ).toBe(
      "Oxagen-Approved-By: dana, priya\nOxagen-Checks: schema,lineage,hash\nOxagen-Version: 413",
    );
  });

  it("names who merged without review", () => {
    expect(
      mergeTrailers({
        approvedBy: [],
        withoutReviewBy: "priya",
        checks: ["schema"],
        version: 1,
      }).split("\n")[0],
    ).toBe("Oxagen-Approved-By: none; merged without review by priya");
  });
});

describe("branches", () => {
  it("names a record's branch after its lineage", () => {
    expect(steeringBranch("a-intel.platform.release-notes")).toBe(
      "steering/a-intel.platform.release-notes",
    );
  });

  it("puts each path under the prefix the spec gives it", () => {
    expect(branchPrefixForPath("workspace.toml")).toBe("workspace");
    expect(branchPrefixForPath("AGENTS.md")).toBe("workspace");
    expect(branchPrefixForPath("steering/memory/platform/x.md")).toBe("memory");
    expect(branchPrefixForPath("steering/platform/x.md")).toBe("steering");
    expect(branchPrefixForPath("steering/governance.toml")).toBe("steering");
    expect(branchPrefixForPath("tools/servers/crm/server.toml")).toBe("tools");
    expect(branchPrefixForPath("agents/support.toml")).toBe("agents");
    expect(branchPrefixForPath("policy/billing.cedar")).toBe("policy");
    expect(branchPrefixForPath("docs/readme.md")).toBeNull();
  });
});

describe("branchScopeRefusal", () => {
  it("accepts one record on a steering/ branch", () => {
    expect(
      branchScopeRefusal("steering/a-intel.platform.release-notes", [
        "steering/platform/a-intel.platform.release-notes.md",
      ]),
    ).toBeNull();
  });

  it("accepts a skill's folder as one change", () => {
    expect(
      branchScopeRefusal("steering/a-intel.brand.voice", [
        "steering/skills/a-intel.brand.voice/SKILL.md",
        "steering/skills/a-intel.brand.voice/words.md",
      ]),
    ).toBeNull();
  });

  it("accepts a policy group's policy and tests as one change", () => {
    expect(
      branchScopeRefusal("policy/billing", [
        "policy/billing.cedar",
        "policy/billing.tests.jsonl",
      ]),
    ).toBeNull();
  });

  it("accepts many files on memory/ and tools/ branches", () => {
    expect(
      branchScopeRefusal("memory/2026-09-26", [
        "steering/memory/platform/a.md",
        "steering/memory/platform/b.md",
      ]),
    ).toBeNull();
    expect(
      branchScopeRefusal("tools/crm", [
        "tools/servers/crm/server.toml",
        "tools/servers/crm/tools.toml",
        "tools/toolbelts/sales.toml",
      ]),
    ).toBeNull();
  });

  it("refuses a branch with no steering prefix", () => {
    expect(
      branchScopeRefusal("context/a-intel.platform.release-notes", [
        "steering/platform/a-intel.platform.release-notes.md",
      ]),
    ).toMatchObject({ reason: "branch_prefix" });
  });

  it("refuses a path outside the branch's folder", () => {
    expect(
      branchScopeRefusal("steering/x", ["steering/memory/platform/a.md"]),
    ).toMatchObject({
      reason: "branch_scope",
      message: "steering/memory/platform/a.md belongs on a memory/ branch, not steering/x",
    });
    expect(
      branchScopeRefusal("workspace/rename", ["docs/readme.md"]),
    ).toMatchObject({
      reason: "branch_scope",
      message: "docs/readme.md is outside every folder a steering PR may change",
    });
  });

  it("refuses two records on one steering/ branch", () => {
    expect(
      branchScopeRefusal("steering/x", [
        "steering/platform/a.md",
        "steering/platform/b.md",
      ]),
    ).toMatchObject({ reason: "one_change" });
  });

  it("refuses a change to the ledger", () => {
    expect(
      branchScopeRefusal("steering/x", [
        "steering/platform/a.md",
        "steering/promotions/2026-09.jsonl",
      ]),
    ).toMatchObject({ reason: "ledger_owned" });
  });
});
