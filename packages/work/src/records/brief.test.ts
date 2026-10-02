// brief.test.ts: criterion ids are issued once and kept, a brief's digest
// depends only on its content, and a draft that breaks a rule is refused.
import { describe, expect, it } from "vitest";
import {
  type BriefDraft,
  type BuildBriefInput,
  MAX_BRIEF_CRITERIA,
  MAX_CRITERION_TEXT,
  briefDigest,
  buildBrief,
  issuedCriterionIds,
  nextCriterionNumber,
  parseWorkBrief,
} from "./brief";
import { isWorkRecordError } from "./errors";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function draft(over: Partial<BriefDraft> = {}): BriefDraft {
  return {
    repository: "aintel/platform",
    criteria: [
      { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
      { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
    ],
    ...over,
  };
}

function input(over: Partial<BuildBriefInput> = {}): BuildBriefInput {
  return {
    item: "wi_01k6invite",
    itemRevision: 1,
    source: { url: "https://github.com/aintel/platform/issues/612", digest: DIGEST },
    draft: draft(),
    issuedIds: [],
    ...over,
  };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(isWorkRecordError(error, "invalid_input")).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("buildBrief", () => {
  it("issues c1 and c2 to the first brief's new criteria", () => {
    const brief = buildBrief(input());
    expect(brief.schema).toBe("work-brief/v1");
    expect(brief.item_revision).toBe(1);
    expect(brief.criteria.map((criterion) => criterion.id)).toEqual(["c1", "c2"]);
    expect(brief.criteria[1]?.evidence).toBe("");
  });

  it("keeps each existing id and gives a new criterion the next unused number", () => {
    const first = buildBrief(input());
    const second = buildBrief(
      input({
        itemRevision: 2,
        issuedIds: issuedCriterionIds([first]),
        draft: draft({
          criteria: [
            { id: "c2", text: "The copy follows the house voice and names the expiry.", tag: "review", intent: "review", provenance: "person" },
            { text: "The invite email links to the new page.", tag: "code", intent: "check", provenance: "triage" },
          ],
        }),
      }),
    );
    expect(second.criteria.map((criterion) => criterion.id)).toEqual(["c2", "c3"]);
  });

  it("never issues a removed id again", () => {
    const issued = ["c1", "c2", "c7"];
    const brief = buildBrief(
      input({
        issuedIds: issued,
        draft: draft({ criteria: [{ text: "A new criterion.", tag: "test", intent: "check", provenance: "person" }] }),
      }),
    );
    expect(brief.criteria[0]?.id).toBe("c8");
    expect(nextCriterionNumber(["c3", "not-an-id", "c10"])).toBe(11);
    expect(nextCriterionNumber([])).toBe(1);
  });

  it("refuses an id the item never issued, so a caller cannot mint one", () => {
    const message = refusal(() =>
      buildBrief(
        input({
          draft: draft({ criteria: [{ id: "c9", text: "Forged.", tag: "code", intent: "check", provenance: "person" }] }),
        }),
      ),
    );
    expect(message).toContain('"c9"');
  });

  it("refuses two criteria with one id", () => {
    const message = refusal(() =>
      buildBrief(
        input({
          issuedIds: ["c1"],
          draft: draft({
            criteria: [
              { id: "c1", text: "One.", tag: "code", intent: "check", provenance: "person" },
              { id: "c1", text: "Two.", tag: "code", intent: "check", provenance: "person" },
            ],
          }),
        }),
      ),
    );
    expect(message).toContain("repeats");
  });

  it("trims text and refuses an empty or oversized criterion", () => {
    const brief = buildBrief(
      input({ draft: draft({ criteria: [{ text: "  Trimmed.  ", tag: "docs", intent: "review", evidence: "  docs  ", provenance: "person" }] }) }),
    );
    expect(brief.criteria[0]?.text).toBe("Trimmed.");
    expect(brief.criteria[0]?.evidence).toBe("docs");
    refusal(() => buildBrief(input({ draft: draft({ criteria: [{ text: "   ", tag: "docs", intent: "review", provenance: "person" }] }) })));
    expect(
      refusal(() =>
        buildBrief(input({ draft: draft({ criteria: [{ text: undefined as unknown as string, tag: "docs", intent: "review", provenance: "person" }] }) })),
      ),
    ).toContain("missing");
    refusal(() =>
      buildBrief(
        input({
          draft: draft({ criteria: [{ text: "x".repeat(MAX_CRITERION_TEXT + 1), tag: "docs", intent: "review", provenance: "person" }] }),
        }),
      ),
    );
    refusal(() =>
      buildBrief(
        input({
          draft: draft({
            criteria: [{ text: "Missing.", tag: "docs", intent: "review", provenance: "person", evidence: 5 as unknown as string }],
          }),
        }),
      ),
    );
  });

  it("refuses no criteria, too many, and an unknown tag, intent, or provenance", () => {
    refusal(() => buildBrief(input({ draft: draft({ criteria: [] }) })));
    const many = Array.from({ length: MAX_BRIEF_CRITERIA + 1 }, (_, n) => ({
      text: `Criterion ${n}.`,
      tag: "code" as const,
      intent: "check" as const,
      provenance: "person" as const,
    }));
    refusal(() => buildBrief(input({ draft: draft({ criteria: many }) })));
    const base = { text: "One.", tag: "code", intent: "check", provenance: "person" } as const;
    expect(refusal(() => buildBrief(input({ draft: draft({ criteria: [{ ...base, tag: "held" as "code" }] }) })))).toContain("tag");
    expect(refusal(() => buildBrief(input({ draft: draft({ criteria: [{ ...base, intent: "proven" as "check" }] }) })))).toContain("intent");
    expect(refusal(() => buildBrief(input({ draft: draft({ criteria: [{ ...base, provenance: "model" as "person" }] }) })))).toContain(
      "provenance",
    );
  });

  it("refuses a bad repository, item id, revision, or source digest", () => {
    expect(refusal(() => buildBrief(input({ draft: draft({ repository: "platform" }) })))).toContain("owner/name");
    refusal(() => buildBrief(input({ item: "task_1" as "wi_x" })));
    refusal(() => buildBrief(input({ itemRevision: 0 })));
    refusal(() => buildBrief(input({ source: { url: null, digest: "sha256:short" as typeof DIGEST } })));
    refusal(() => buildBrief(input({ source: { url: 7 as unknown as string, digest: null } })));
  });
});

describe("briefDigest", () => {
  it("is the same for the same content however its keys were written", () => {
    const brief = buildBrief(input());
    const reordered = JSON.parse(
      JSON.stringify({ criteria: brief.criteria, source: brief.source, repository: brief.repository, item_revision: 1, item: brief.item, schema: brief.schema }),
    ) as typeof brief;
    expect(briefDigest(reordered)).toBe(briefDigest(brief));
    expect(briefDigest(brief)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when the text, the revision, or the repository changes", () => {
    const brief = buildBrief(input());
    const digest = briefDigest(brief);
    expect(briefDigest({ ...brief, item_revision: 2 })).not.toBe(digest);
    expect(briefDigest({ ...brief, repository: "aintel/other" })).not.toBe(digest);
    expect(
      briefDigest({ ...brief, criteria: [{ ...brief.criteria[0]!, text: "Something else." }, ...brief.criteria.slice(1)] }),
    ).not.toBe(digest);
  });
});

describe("parseWorkBrief", () => {
  it("reads back a stored brief with the same digest", () => {
    const brief = buildBrief(input());
    const stored = JSON.parse(JSON.stringify(brief)) as unknown;
    const parsed = parseWorkBrief(stored);
    expect(parsed).toEqual(brief);
    expect(briefDigest(parsed)).toBe(briefDigest(brief));
  });

  it("reads a source with no link or digest as null", () => {
    const brief = buildBrief(input({ source: { url: null, digest: null } }));
    const stored = JSON.parse(JSON.stringify({ ...brief, source: {} })) as unknown;
    expect(parseWorkBrief(stored).source).toEqual({ url: null, digest: null });
  });

  it("refuses a value that is not a work-brief/v1 document", () => {
    const brief = buildBrief(input());
    refusal(() => parseWorkBrief(null));
    refusal(() => parseWorkBrief([]));
    refusal(() => parseWorkBrief({ ...brief, schema: "done-record/v1" }));
    refusal(() => parseWorkBrief({ ...brief, item: 3 }));
    refusal(() => parseWorkBrief({ ...brief, source: null }));
    refusal(() => parseWorkBrief({ ...brief, criteria: [] }));
    refusal(() => parseWorkBrief({ ...brief, criteria: [{ ...brief.criteria[0], id: undefined }] }));
    refusal(() => parseWorkBrief({ ...brief, criteria: ["c1"] }));
  });
});
