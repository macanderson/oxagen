// INV-35 (ARCHITECTURE.md §4): every label in messages/*.json is plain
// (CLAUDE.md, Labels and headings; ADR-226, amendment of 2026-09-29). A
// heading names the thing, a button names what it acts on, and a caption
// states one fact. The v3 mockup's wording is not the design of record, so a
// slogan ported from it fails here: "Everything written down", "Who receives
// it", "Read them", "Summary · what this run changed". An em dash fails in any
// string, a sentence included (clear-prose, rule 1). label-voice.ts holds
// the check. This file runs it over the catalogues, proves it on a probe
// catalogue, and keeps the allowlist honest.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalogs } from "@/i18n/load-catalogs";
import { labelFindings, leaves, visibleText } from "./label-voice";
import { APP_DIR } from "./parse";

const RULE = "label-voice";

/** Keys whose value is not a label, each with the reason it may keep its shape. */
const ALLOWED: Readonly<Record<string, string>> = {
  "shell.assistant.suggestions.run.stopped":
    "A question the assistant offers to send for the person, in their words.",
  "create.skill.describe.suggestions.releaseNotes":
    "A sample skill description the person can pick, in their words.",
  "create.skill.describe.suggestions.flakyTest":
    "A sample skill description the person can pick, in their words.",
};

function violations(
  messages: Record<string, unknown>,
  allowed: Readonly<Record<string, string>>,
): string[] {
  return labelFindings(leaves(messages))
    .filter((finding) => !Object.hasOwn(allowed, finding.key))
    .map(
      (finding) =>
        `${RULE} ${finding.shape} ${finding.key} ${JSON.stringify(finding.value)}`,
    );
}

/** Each allowlisted key that is missing from the catalogues or no longer breaks the rule. */
function staleAllowed(
  messages: Record<string, unknown>,
  allowed: Readonly<Record<string, string>>,
): string[] {
  const flagged = new Set(
    labelFindings(leaves(messages)).map((finding) => finding.key),
  );
  return Object.keys(allowed)
    .filter((key) => !flagged.has(key))
    .map((key) => `${RULE} stale-allowlist ${key}`);
}

/** One label of each banned shape, the slogans that started the rule among them, and plain labels beside them. */
const PROBE = {
  steering: {
    all: { title: "Everything written down" },
    assignments: { open: "Who receives it" },
    summary: { title: "Summary · what this run changed" },
    retrieval: { heading: "Retrieval, in numbers" },
    frames: { note: "ordered by the frames, not by kind" },
    delegation: { value: "subagents narrow, never widen" },
    credential: { keyValue: "shown once at issue; stored as a hash" },
    trust: { readThem: "Read them" },
    unlink: { keep: "Keep it linked" },
    tabs: { list: "Records", try: "Try it" },
    columns: { why: "Why", reason: "Reason" },
    records: {
      title: "All records",
      open: "Open the assignments",
      note: "{count, plural, one {# record} other {# records}}",
      lead: "Who receives a record is set by its scope.",
      empty: "—",
      badge: "—",
      hint: "Records reach a run, then expire.",
    },
    intro: "Records — rules, memories, and skills — reach a run.",
  },
};

describe("label voice (INV-35)", () => {
  const catalogs = loadCatalogs(path.join(APP_DIR, "messages"));

  it("every heading, button, and caption in messages/*.json is plain", () => {
    expect(violations(catalogs, ALLOWED)).toEqual([]);
  });

  it("every allowlisted key exists and still breaks the rule", () => {
    expect(staleAllowed(catalogs, ALLOWED)).toEqual([]);
  });

  it("names an allowlisted key that is missing or now plain", () => {
    expect(
      staleAllowed(PROBE, {
        "steering.assignments.open": "Still a question, so the entry holds.",
        "steering.records.title": "Plain now, so the entry is stale.",
        "steering.gone": "Missing from the catalogue.",
      }),
    ).toEqual([
      `${RULE} stale-allowlist steering.records.title`,
      `${RULE} stale-allowlist steering.gone`,
    ]);
  });

  it("flags every banned shape on the probe catalogue and passes the plain labels", () => {
    expect(violations(PROBE, {})).toEqual([
      `${RULE} heading-phrase steering.all.title "Everything written down"`,
      `${RULE} question-label steering.assignments.open "Who receives it"`,
      `${RULE} heading-punctuation steering.summary.title "Summary · what this run changed"`,
      `${RULE} heading-punctuation steering.retrieval.heading "Retrieval, in numbers"`,
      `${RULE} caption-punctuation steering.frames.note "ordered by the frames, not by kind"`,
      `${RULE} contrast-label steering.delegation.value "subagents narrow, never widen"`,
      `${RULE} semicolon-label steering.credential.keyValue "shown once at issue; stored as a hash"`,
      `${RULE} pronoun-label steering.trust.readThem "Read them"`,
      `${RULE} pronoun-label steering.unlink.keep "Keep it linked"`,
      `${RULE} pronoun-label steering.tabs.try "Try it"`,
      `${RULE} heading-phrase steering.columns.why "Why"`,
      `${RULE} em-dash steering.intro "Records — rules, memories, and skills — reach a run."`,
    ]);
  });

  it("reads the words a person sees, with tags dropped and each argument one word", () => {
    expect(
      visibleText(
        "<b>{count, plural, one {# record, {kind}} other {# records}}</b> in force",
      ),
    ).toBe("X in force");
  });
});
