import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { journalFromNdjson } from "./journal";
import { reportPassed } from "./report";
import { ALL_CHECKS, runOracles } from "./oracles";
import { TRACE_FORMAT } from "./types";

const FIXTURES = resolve(__dirname, "../../fixtures/contextgraph-trace");

interface Manifest {
  upstream_commit: string;
  trace_format: string;
  files: Record<string, string>;
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, "manifest.json"), "utf8"),
  ) as Manifest;
}

describe("contextgraph-trace oracle port", () => {
  it("pins the upstream fixtures byte for byte and the trace format", () => {
    const manifest = readManifest();
    expect(manifest.trace_format).toBe(TRACE_FORMAT);
    const onDisk = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
    for (const [name, digest] of Object.entries(manifest.files)) {
      const bytes = readFileSync(resolve(FIXTURES, name));
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        digest,
      );
    }
  });

  it("passes every check on the golden journal, skipping only what it does not exercise", () => {
    const report = runOracles(
      journalFromNdjson(
        readFileSync(resolve(FIXTURES, "golden.ndjson"), "utf8"),
      ),
    );
    expect(reportPassed(report)).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([...ALL_CHECKS]);
    const skipped = report.checks
      .filter((check) => check.status === "skipped")
      .map((check) => check.name);
    expect(skipped).toEqual(["resume-integrity"]);
    expect(report.target).toContain("sess_golden");
  });

  it("passes the crash-and-resume journal, exercising resume integrity", () => {
    const report = runOracles(
      journalFromNdjson(
        readFileSync(resolve(FIXTURES, "golden-resume.ndjson"), "utf8"),
      ),
    );
    expect(reportPassed(report)).toBe(true);
    const resume = report.checks.find(
      (check) => check.name === "resume-integrity",
    );
    expect(resume?.status).toBe("pass");
  });

  for (const check of ALL_CHECKS) {
    it(`trip-${check}.ndjson fails exactly ${check}`, () => {
      const journal = journalFromNdjson(
        readFileSync(resolve(FIXTURES, `trip-${check}.ndjson`), "utf8"),
      );
      const report = runOracles(journal);
      const failed = report.checks
        .filter((result) => result.status === "fail")
        .map((result) => result.name);
      expect(failed).toEqual([check]);
      const evidence =
        report.checks.find((result) => result.name === check)?.evidence ?? "";
      expect(evidence).toMatch(/seq \d+/);
    });
  }

  it("declares unexercised oracles as skipped, never as passed", () => {
    const report = runOracles(
      journalFromNdjson(
        [
          '{"seq":1,"at":"2026-07-23T09:00:00Z","session":"s","event":"session_start","agent":"a","harness":"h"}',
          '{"seq":2,"at":"2026-07-23T09:00:01Z","session":"s","event":"session_end","outcome":"completed"}',
        ].join("\n"),
      ),
    );
    expect(reportPassed(report)).toBe(true);
    expect(
      report.checks.filter((c) => c.status === "skipped").map((c) => c.name),
    ).toEqual([
      "staleness-at-use",
      "deterministic-composition",
      "resume-integrity",
    ]);
  });
});
