import { generateKeyPairSync } from "node:crypto";
import {
  doneAttestationKey,
  doneStatement,
  publishedDoneKey,
  signDoneAttestation,
  verifyDoneAttestation,
  type DoneAttestation,
  type DoneAttestationKey,
  type DoneOutcome,
  type DoneStatement,
  type DoneVerdict,
} from "@oxagen/done-record/attestation";
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_OUTPUT_MAX,
  doneCheckRun,
  doneCheckStatus,
  postDoneCheck,
  type DoneCheckInput,
} from "./done-check";

const COMMIT = "a".repeat(40);
const RECORD = `sha256:${"b".repeat(64)}` as const;
const DECIDED_AT = "2026-09-29T12:00:00.000Z";
// Values the types forbid, for the refusal tests.
const NOT_A_VERDICT = "done" as string as DoneVerdict;
const NOT_A_REASON = "NOPE" as string as "CHECK_FAILED";

function newKey(): DoneAttestationKey {
  return doneAttestationKey(generateKeyPairSync("ed25519").privateKey);
}

function statement(outcome: Partial<DoneOutcome> = {}): DoneStatement {
  return doneStatement({
    item: "wi_0123456789ABCDEFGHJKMN",
    repository: "https://github.com/acme/api",
    commit: COMMIT,
    recordDigest: RECORD,
    outcome: {
      verdict: "held",
      reasons: [],
      criteria: [
        { id: "tests-pass", state: "held" },
        { id: "lint-clean", state: "proven" },
      ],
      ...outcome,
    },
    decidedAt: new Date(DECIDED_AT),
  });
}

function input(overrides: Partial<DoneCheckInput> = {}): DoneCheckInput {
  return { owner: "acme", repo: "api", statement: statement(), ...overrides };
}

/** A copy of a statement with a field changed after doneStatement built it. */
function edited(change: (s: DoneStatement) => void): DoneStatement {
  const copy = structuredClone(statement());
  change(copy);
  return copy;
}

describe("doneCheckStatus", () => {
  it.each<[DoneVerdict, string, string | undefined]>([
    ["proven", "completed", "success"],
    ["held", "completed", "neutral"],
    ["broken", "completed", "failure"],
    ["pending", "in_progress", undefined],
  ])("maps a %s record to a %s run with conclusion %s", (verdict, status, conclusion) => {
    const mapped = doneCheckStatus(verdict);
    expect(mapped.status).toBe(status);
    expect("conclusion" in mapped ? mapped.conclusion : undefined).toBe(conclusion);
  });

  it("throws on a verdict the contract does not define", () => {
    expect(() => doneCheckStatus(NOT_A_VERDICT)).toThrow("done check: unknown verdict done");
    expect(() => doneCheckStatus("toString" as string as DoneVerdict)).toThrow(TypeError);
  });
});

describe("doneCheckRun", () => {
  it.each<[DoneVerdict, "success" | "neutral" | "failure", string]>([
    ["proven", "success", "Proven"],
    ["held", "neutral", "Held"],
    ["broken", "failure", "Broken"],
  ])("posts a %s record as a completed run with conclusion %s", (verdict, conclusion, title) => {
    const run = doneCheckRun(input({ statement: statement({ verdict }) }));
    expect(run).toMatchObject({
      name: "Oxagen done",
      headSha: COMMIT,
      status: "completed",
      conclusion,
      title,
      startedAt: DECIDED_AT,
      completedAt: DECIDED_AT,
      externalId: RECORD,
    });
  });

  it("posts a pending record as a run in progress, with no conclusion and no end time", () => {
    const run = doneCheckRun(input({ statement: statement({ verdict: "pending" }) }));
    expect(run.status).toBe("in_progress");
    expect(run.title).toBe("Pending");
    expect(run.conclusion).toBeUndefined();
    expect(run.completedAt).toBeUndefined();
    expect(run.summary.startsWith("The done record is pending.")).toBe(true);
  });

  it("writes the summary from ids, states, and digests alone", () => {
    const run = doneCheckRun(input());
    expect(run.summary).toBe(
      [
        "The done record is held. Every criterion is held or proven, so the work item is done.",
        "",
        "| Criterion | State |",
        "| --- | --- |",
        "| `tests-pass` | held |",
        "| `lint-clean` | proven |",
        "",
        `Done record: \`${RECORD}\``,
      ].join("\n"),
    );
    expect(run.text).toBeUndefined();
    expect(run.detailsUrl).toBeUndefined();
  });

  it("leaves out the table when the record has no criteria", () => {
    const run = doneCheckRun(input({ statement: statement({ criteria: [] }) }));
    expect(run.summary).not.toContain("| Criterion |");
  });

  it("lists each reason with Oxagen's message, with and without a criterion", () => {
    const run = doneCheckRun(
      input({
        statement: statement({
          verdict: "broken",
          reasons: [{ code: "CHECK_FAILED", criterion: "tests-pass" }, { code: "BUDGET_EXCEEDED" }],
          criteria: [{ id: "tests-pass", state: "failed" }],
        }),
      }),
    );
    expect(run.summary).toContain(
      [
        "Reasons:",
        "",
        "- `CHECK_FAILED` (`tests-pass`): A check in the locked set did not pass.",
        "- `BUDGET_EXCEEDED`: The work went over its cost, time, or tool-call budget.",
      ].join("\n"),
    );
  });

  it("links the work item, the badge, and the public key", () => {
    const key = newKey();
    const s = statement();
    const run = doneCheckRun(
      input({
        statement: s,
        attestation: signDoneAttestation(s, key),
        detailsUrl: "https://oxagen.app/acme/main/work/wi_0123456789ABCDEFGHJKMN",
        badgeUrl: "https://api.oxagen.sh/v1/work/done/badge/abc.def.svg",
        keyUrl: "https://api.oxagen.sh/v1/work/done/key",
      }),
    );
    expect(run.detailsUrl).toBe("https://oxagen.app/acme/main/work/wi_0123456789ABCDEFGHJKMN");
    expect(run.summary).toContain("Public key: https://api.oxagen.sh/v1/work/done/key");
    expect(run.summary).toContain(
      "![Oxagen done: held](https://api.oxagen.sh/v1/work/done/badge/abc.def.svg)",
    );
  });

  it("names the key only when an attestation is shown", () => {
    const run = doneCheckRun(input({ keyUrl: "https://api.oxagen.sh/v1/work/done/key" }));
    expect(run.summary).not.toContain("Public key:");
    expect(run.summary).not.toContain("Attestation:");
  });

  it("shows the signed envelope, which verifies with the published key", () => {
    const key = newKey();
    const s = statement({ verdict: "proven" });
    const attestation = signDoneAttestation(s, key);
    const run = doneCheckRun(input({ statement: s, attestation }));

    expect(run.summary).toContain(
      `Attestation: \`${attestation.ref}\`, signed with key \`${key.keyId}\``,
    );
    const fenced = /```json\n([\s\S]+)\n```/.exec(run.text ?? "")?.[1];
    expect(fenced).toBeDefined();
    const shown: unknown = JSON.parse(fenced ?? "");
    expect(shown).toEqual(attestation.envelope);

    const published = publishedDoneKey(key.publicKeyPem);
    const check = verifyDoneAttestation(shown, published.public_key_pem);
    expect(check).toEqual({ ok: true, statement: s, keyid: published.keyid });
  });

  it("leaves out a key id that is not one", () => {
    const s = statement();
    const attestation = signDoneAttestation(s, newKey());
    const noKeyid: DoneAttestation = {
      ...attestation,
      envelope: { ...attestation.envelope, signatures: [] },
    };
    const run = doneCheckRun(input({ statement: s, attestation: noKeyid }));
    expect(run.summary.endsWith(`Attestation: \`${attestation.ref}\``)).toBe(true);
    expect(run.summary).not.toContain("signed with key");

    const badKeyid: DoneAttestation = {
      ...attestation,
      envelope: {
        ...attestation.envelope,
        signatures: [{ keyid: "`](https://evil.test)", sig: "AA==" }],
      },
    };
    expect(doneCheckRun(input({ statement: s, attestation: badKeyid })).summary).not.toContain(
      "evil.test",
    );
  });

  it("gives the envelope's digest in place of an envelope over GitHub's limit", () => {
    const s = statement();
    const attestation = signDoneAttestation(s, newKey());
    const huge: DoneAttestation = {
      ...attestation,
      envelope: {
        ...attestation.envelope,
        signatures: [{ keyid: "k".repeat(CHECK_OUTPUT_MAX), sig: "AA==" }],
      },
    };
    const run = doneCheckRun(input({ statement: s, attestation: huge }));
    expect(run.text).toBe(
      `The signed envelope is longer than GitHub allows here. Its digest is \`${attestation.ref}\`.`,
    );
  });

  it("cuts a summary over GitHub's limit and says so", () => {
    const many = edited((s) => {
      s.predicate.verdict = "broken";
      s.predicate.reasons = Array.from({ length: 2000 }, () => ({
        code: "CHECK_FAILED" as const,
        criterion: "tests-pass",
      }));
    });
    const run = doneCheckRun(input({ statement: many }));
    expect(run.summary).toHaveLength(CHECK_OUTPUT_MAX);
    expect(run.summary.endsWith("\n\nThe rest is cut to fit GitHub's limit.")).toBe(true);
  });

  it.each<[string, () => Partial<DoneCheckInput>, RegExp]>([
    [
      "a verdict the contract does not define",
      () => ({
        statement: edited((s) => {
          s.predicate.verdict = NOT_A_VERDICT;
        }),
      }),
      /unknown verdict done/,
    ],
    [
      "a short commit",
      () => ({
        statement: edited((s) => {
          s.subject[0].digest.gitCommit = "abc";
        }),
      }),
      /commit must be a lowercase hex SHA/,
    ],
    [
      "an uppercase commit",
      () => ({
        statement: edited((s) => {
          s.subject[0].digest.gitCommit = "A".repeat(40);
        }),
      }),
      /commit must be a lowercase hex SHA/,
    ],
    [
      "a criterion id that could break the table",
      () => ({
        statement: edited((s) => {
          s.predicate.criteria = [{ id: "a|b", state: "held", evidence: {} }];
        }),
      }),
      /criterion id "a\|b" is not a criterion id/,
    ],
    [
      "a reason naming a bad criterion id",
      () => ({
        statement: edited((s) => {
          s.predicate.reasons = [{ code: "CHECK_FAILED", criterion: "Tests Pass" }];
        }),
      }),
      /criterion id "Tests Pass" is not a criterion id/,
    ],
    [
      "an unknown reason code",
      () => ({
        statement: edited((s) => {
          s.predicate.reasons = [{ code: NOT_A_REASON }];
        }),
      }),
      /unknown reason code "NOPE"/,
    ],
    [
      "a record digest that is not sha256",
      () => ({
        statement: edited((s) => {
          s.predicate.record_digest = "sha256:`x`";
        }),
      }),
      /record_digest must be a sha256 digest/,
    ],
    [
      "a details link over http",
      () => ({ detailsUrl: "http://oxagen.app/w" }),
      /detailsUrl must be an https URL/,
    ],
    [
      "a badge link that is not a URL",
      () => ({ badgeUrl: "badge.svg" }),
      /badgeUrl must be an https URL/,
    ],
    [
      "a key link over javascript",
      () => ({ keyUrl: "javascript:alert(1)" }),
      /keyUrl must be an https URL/,
    ],
  ])("refuses %s", (_name, overrides, message) => {
    const bad = input(overrides());
    expect(() => doneCheckRun(bad)).toThrow(message);
    expect(() => doneCheckRun(bad)).toThrow(TypeError);
  });

  it("refuses an attestation that carries another statement", () => {
    const signed = signDoneAttestation(statement({ verdict: "proven" }), newKey());
    expect(() => doneCheckRun(input({ attestation: signed }))).toThrow(
      "done check: the attestation carries a different statement",
    );
  });

  it("refuses an attestation ref that is not a sha256 digest", () => {
    const s = statement();
    const signed = signDoneAttestation(s, newKey());
    const bad = { ...signed, ref: "sha256:nope" as DoneAttestation["ref"] };
    expect(() => doneCheckRun(input({ statement: s, attestation: bad }))).toThrow(
      "done check: the attestation ref must be a sha256 digest",
    );
  });
});

describe("postDoneCheck", () => {
  it("creates the run on the head commit and returns its page", async () => {
    const createCheckRun = vi.fn().mockResolvedValue({ id: 7, htmlUrl: "https://github.com/r/7" });
    const request = input({ statement: statement({ verdict: "broken" }) });

    await expect(postDoneCheck({ createCheckRun }, request)).resolves.toEqual({
      id: 7,
      htmlUrl: "https://github.com/r/7",
    });
    expect(createCheckRun).toHaveBeenCalledTimes(1);
    expect(createCheckRun).toHaveBeenCalledWith(doneCheckRun(request));
  });

  it("posts nothing when the input is refused", async () => {
    const createCheckRun = vi.fn();
    await expect(
      postDoneCheck({ createCheckRun }, input({ detailsUrl: "ftp://oxagen.app" })),
    ).rejects.toThrow(TypeError);
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});
