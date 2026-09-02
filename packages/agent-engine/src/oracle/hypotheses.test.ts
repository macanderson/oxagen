/**
 * Tests for probe-based hypothesis falsification (F7).
 *
 * Covers: verdict-line parsing across all three separators and case variants;
 * declaration-line statement pickup; last-verdict-wins; malformed-line skipping;
 * empty-evidence probe backfill by id mention; survivors filter + cap at 3;
 * renderProbeInstruction format; realistic multi-hypothesis end-to-end.
 */

import { describe, it, expect } from "vitest";
import {
  parseHypothesisMarkers,
  pairWithProbes,
  survivors,
  renderProbeInstruction,
  type HypothesisVerdict,
} from "./hypotheses";

describe("parseHypothesisMarkers", () => {
  it("parses verdict lines with em dash separator", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED — cache not invalidated
HYPOTHESIS: h2 FALSIFIED — assertion passed
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({
      id: "h1",
      statement: "",
      verdict: "survived",
      evidence: "cache not invalidated",
    });
    expect(verdicts[1]).toEqual({
      id: "h2",
      statement: "",
      verdict: "falsified",
      evidence: "assertion passed",
    });
  });

  it("parses verdict lines with hyphen separator", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED - lock not released
HYPOTHESIS: h2 FALSIFIED - timeout never triggered
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({
      id: "h1",
      statement: "",
      verdict: "survived",
      evidence: "lock not released",
    });
    expect(verdicts[1]).toEqual({
      id: "h2",
      statement: "",
      verdict: "falsified",
      evidence: "timeout never triggered",
    });
  });

  it("parses verdict lines with colon separator", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED : error not raised
HYPOTHESIS: h2 FALSIFIED : condition was met
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({
      id: "h1",
      statement: "",
      verdict: "survived",
      evidence: "error not raised",
    });
    expect(verdicts[1]).toEqual({
      id: "h2",
      statement: "",
      verdict: "falsified",
      evidence: "condition was met",
    });
  });

  it("handles case-insensitive verdict keywords", () => {
    const transcript = `
HYPOTHESIS: h1 survived — evidence
HYPOTHESIS: h2 FALSIFIED — evidence
HYPOTHESIS: h3 Survived — evidence
HYPOTHESIS: h4 FaLsIfIeD — evidence
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(4);
    expect(verdicts[0]!.verdict).toBe("survived");
    expect(verdicts[1]!.verdict).toBe("falsified");
    expect(verdicts[2]!.verdict).toBe("survived");
    expect(verdicts[3]!.verdict).toBe("falsified");
  });

  it("picks up statement from preceding declaration lines", () => {
    const transcript = `
HYPOTHESIS: h1: The cache is never invalidated on updates
Some diagnostic output here.
HYPOTHESIS: h1 SURVIVED — cache key still matches

HYPOTHESIS: h2: The mutex is held after lock acquisition
More output.
HYPOTHESIS: h2 FALSIFIED — mutex was released correctly
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({
      id: "h1",
      statement: "The cache is never invalidated on updates",
      verdict: "survived",
      evidence: "cache key still matches",
    });
    expect(verdicts[1]).toEqual({
      id: "h2",
      statement: "The mutex is held after lock acquisition",
      verdict: "falsified",
      evidence: "mutex was released correctly",
    });
  });

  it("uses empty statement if no declaration line exists", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED — evidence
HYPOTHESIS: h2 FALSIFIED — evidence
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts[0]!.statement).toBe("");
    expect(verdicts[1]!.statement).toBe("");
  });

  it("last verdict wins for duplicate ids", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED — first evidence
HYPOTHESIS: h1 FALSIFIED — second evidence
HYPOTHESIS: h1 SURVIVED — third evidence
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toEqual({
      id: "h1",
      statement: "",
      verdict: "survived",
      evidence: "third evidence",
    });
  });

  it("skips malformed lines silently", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED — valid
HYPOTHESIS: malformed no verdict keyword
HYPOTHESIS: h2 UNKNOWN_KEYWORD — invalid
HYPOTHESIS: — no id
HYPOTHESIS: h3 FALSIFIED — valid
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.id).toBe("h1");
    expect(verdicts[1]!.id).toBe("h3");
  });

  it("handles empty evidence", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED —
HYPOTHESIS: h2 FALSIFIED -
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts[0]!.evidence).toBe("");
    expect(verdicts[1]!.evidence).toBe("");
  });

  it("returns empty array for non-string input", () => {
    const verdicts = parseHypothesisMarkers(null as unknown as string);
    expect(verdicts).toEqual([]);
  });

  it("returns empty array for transcript with no markers", () => {
    const verdicts = parseHypothesisMarkers("just some text with no markers");
    expect(verdicts).toEqual([]);
  });

  it("preserves order: first appearance of each id", () => {
    const transcript = `
HYPOTHESIS: h1 SURVIVED — first
HYPOTHESIS: h2 FALSIFIED — second
HYPOTHESIS: h1 FALSIFIED — duplicate (last wins)
HYPOTHESIS: h3 SURVIVED — third
    `.trim();

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0]!.id).toBe("h1");
    expect(verdicts[1]!.id).toBe("h2");
    expect(verdicts[2]!.id).toBe("h3");
    // h1 should have the last verdict (FALSIFIED)
    expect(verdicts[0]!.verdict).toBe("falsified");
  });
});

describe("pairWithProbes", () => {
  it("creates Hypothesis objects from verdicts", () => {
    const verdicts: HypothesisVerdict[] = [
      {
        id: "h1",
        statement: "Cache issue",
        verdict: "survived",
        evidence: "key mismatch",
      },
      {
        id: "h2",
        statement: "Lock issue",
        verdict: "falsified",
        evidence: "released",
      },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses).toHaveLength(2);
    expect(hypotheses[0]).toEqual({
      id: "h1",
      statement: "Cache issue",
      evidence: "key mismatch",
      probeResult: "survived",
    });
    expect(hypotheses[1]).toEqual({
      id: "h2",
      statement: "Lock issue",
      evidence: "released",
      probeResult: "falsified",
    });
  });

  it("backfills empty evidence from last matching command", () => {
    const verdicts: HypothesisVerdict[] = [
      { id: "h1", statement: "Cache issue", verdict: "survived", evidence: "" },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [
      { command: "some other command", exitCode: 0 },
      { command: "python -m pytest test_h1_behavior.py", exitCode: 1 },
      { command: "python -m pytest test_other.py", exitCode: 0 },
    ];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses[0]!.evidence).toBe(
      "python -m pytest test_h1_behavior.py",
    );
  });

  it("backfills evidence with case-insensitive id match", () => {
    const verdicts: HypothesisVerdict[] = [
      { id: "H1", statement: "Issue", verdict: "survived", evidence: "" },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [
      { command: "python -m pytest test_h1_behavior.py", exitCode: 1 },
    ];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses[0]!.evidence).toBe(
      "python -m pytest test_h1_behavior.py",
    );
  });

  it("leaves evidence empty if no matching command found", () => {
    const verdicts: HypothesisVerdict[] = [
      { id: "h1", statement: "Issue", verdict: "survived", evidence: "" },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [
      { command: "python -m pytest test_other.py", exitCode: 1 },
      { command: "python -m pytest test_another.py", exitCode: 0 },
    ];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses[0]?.evidence).toBe("");
  });

  it("uses last matching command when multiple mention the id", () => {
    const verdicts: HypothesisVerdict[] = [
      { id: "h1", statement: "Issue", verdict: "survived", evidence: "" },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [
      { command: "python -m pytest test_h1_v1.py", exitCode: 1 },
      { command: "python -m pytest test_other.py", exitCode: 0 },
      { command: "python -m pytest test_h1_v2.py", exitCode: 1 },
    ];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses[0]!.evidence).toBe("python -m pytest test_h1_v2.py");
  });

  it("handles empty commands array", () => {
    const verdicts: HypothesisVerdict[] = [
      { id: "h1", statement: "Issue", verdict: "survived", evidence: "" },
    ];

    const hypotheses = pairWithProbes(verdicts, []);
    expect(hypotheses[0]?.evidence).toBe("");
  });

  it("preserves non-empty evidence", () => {
    const verdicts: HypothesisVerdict[] = [
      {
        id: "h1",
        statement: "Issue",
        verdict: "survived",
        evidence: "explicit evidence",
      },
    ];
    const commands: Array<{ command: string; exitCode: number }> = [
      { command: "python -m pytest test_h1.py", exitCode: 1 },
    ];

    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses[0]!.evidence).toBe("explicit evidence");
  });
});

describe("survivors", () => {
  it("filters to survived hypotheses only", () => {
    const hypotheses = [
      {
        id: "h1",
        statement: "s1",
        evidence: "e1",
        probeResult: "survived" as const,
      },
      {
        id: "h2",
        statement: "s2",
        evidence: "e2",
        probeResult: "falsified" as const,
      },
      {
        id: "h3",
        statement: "s3",
        evidence: "e3",
        probeResult: "survived" as const,
      },
    ];

    const result = survivors(hypotheses);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("h1");
    expect(result[1]!.id).toBe("h3");
  });

  it("caps at 3 survivors", () => {
    const hypotheses = [
      {
        id: "h1",
        statement: "s1",
        evidence: "e1",
        probeResult: "survived" as const,
      },
      {
        id: "h2",
        statement: "s2",
        evidence: "e2",
        probeResult: "survived" as const,
      },
      {
        id: "h3",
        statement: "s3",
        evidence: "e3",
        probeResult: "survived" as const,
      },
      {
        id: "h4",
        statement: "s4",
        evidence: "e4",
        probeResult: "survived" as const,
      },
      {
        id: "h5",
        statement: "s5",
        evidence: "e5",
        probeResult: "survived" as const,
      },
    ];

    const result = survivors(hypotheses);
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("h1");
    expect(result[1]!.id).toBe("h2");
    expect(result[2]!.id).toBe("h3");
  });

  it("returns empty array if no survivors", () => {
    const hypotheses = [
      {
        id: "h1",
        statement: "s1",
        evidence: "e1",
        probeResult: "falsified" as const,
      },
      {
        id: "h2",
        statement: "s2",
        evidence: "e2",
        probeResult: "falsified" as const,
      },
    ];

    const result = survivors(hypotheses);
    expect(result).toEqual([]);
  });

  it("preserves order of survivors", () => {
    const hypotheses = [
      {
        id: "h1",
        statement: "s1",
        evidence: "e1",
        probeResult: "falsified" as const,
      },
      {
        id: "h2",
        statement: "s2",
        evidence: "e2",
        probeResult: "survived" as const,
      },
      {
        id: "h3",
        statement: "s3",
        evidence: "e3",
        probeResult: "falsified" as const,
      },
      {
        id: "h4",
        statement: "s4",
        evidence: "e4",
        probeResult: "survived" as const,
      },
    ];

    const result = survivors(hypotheses);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("h2");
    expect(result[1]!.id).toBe("h4");
  });

  it("handles hypotheses without probeResult field", () => {
    const hypotheses: Array<{
      id: string;
      statement: string;
      evidence: string;
      probeResult?: "survived" | "falsified";
    }> = [
      { id: "h1", statement: "s1", evidence: "e1" },
      {
        id: "h2",
        statement: "s2",
        evidence: "e2",
        probeResult: "survived" as const,
      },
    ];

    const result = survivors(hypotheses);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("h2");
  });
});

describe("renderProbeInstruction", () => {
  it("returns a string under 120 words", () => {
    const instruction = renderProbeInstruction();
    const wordCount = instruction.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(120);
  });

  it("mentions the HYPOTHESIS marker format", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/HYPOTHESIS:\s*<id>/i);
  });

  it("mentions SURVIVED and FALSIFIED keywords", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/SURVIVED/);
    expect(instruction).toMatch(/FALSIFIED/);
  });

  it("mentions the em dash separator", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/—/);
  });

  it("includes example output", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/HYPOTHESIS:\s*h\d+/i);
  });

  it("instructs to enumerate 2-3 hypotheses", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/2.*3|3.*2/);
  });

  it("instructs to design probes", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/probe/i);
  });

  it("instructs to run probes", () => {
    const instruction = renderProbeInstruction();
    expect(instruction).toMatch(/run/i);
  });
});

describe("end-to-end: realistic multi-hypothesis transcript", () => {
  it("parses, pairs, and filters a complete workflow", () => {
    const transcript = `
Investigation phase:
- Examined the cache invalidation logic
- Checked the lock release mechanism
- Traced the timeout handler

HYPOTHESIS: h1: Cache is never invalidated on concurrent updates
HYPOTHESIS: h2: Mutex is incorrectly held after acquisition
HYPOTHESIS: h3: Timeout handler is not registered

Running probes...

HYPOTHESIS: h1 SURVIVED — cache.invalidate() was not called in the update path
HYPOTHESIS: h2 FALSIFIED — mutex was correctly released in all branches
HYPOTHESIS: h3 SURVIVED — timeout handler callback exists but is never invoked
    `.trim();

    const commands = [
      {
        command: "python -m pytest test_cache_h1.py::test_concurrent",
        exitCode: 1,
      },
      {
        command: "python -m pytest test_mutex_h2.py::test_release",
        exitCode: 0,
      },
      {
        command: "python -m pytest test_timeout_h3.py::test_registration",
        exitCode: 1,
      },
    ];

    // Parse verdicts
    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0]!.id).toBe("h1");
    expect(verdicts[0]!.statement).toBe(
      "Cache is never invalidated on concurrent updates",
    );
    expect(verdicts[0]!.verdict).toBe("survived");

    expect(verdicts[1]!.id).toBe("h2");
    expect(verdicts[1]!.statement).toBe(
      "Mutex is incorrectly held after acquisition",
    );
    expect(verdicts[1]!.verdict).toBe("falsified");

    expect(verdicts[2]!.id).toBe("h3");
    expect(verdicts[2]!.statement).toBe("Timeout handler is not registered");
    expect(verdicts[2]!.verdict).toBe("survived");

    // Pair with probes
    const hypotheses = pairWithProbes(verdicts, commands);
    expect(hypotheses).toHaveLength(3);
    expect(hypotheses[0]!.probeResult).toBe("survived");
    expect(hypotheses[1]!.probeResult).toBe("falsified");
    expect(hypotheses[2]!.probeResult).toBe("survived");

    // Filter survivors
    const result = survivors(hypotheses);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("h1");
    expect(result[1]!.id).toBe("h3");
  });

  it("handles transcript with mixed separators and case variants", () => {
    const transcript = `
HYPOTHESIS: issue1: The first problem
Running first probe...
HYPOTHESIS: issue1 survived — first evidence

HYPOTHESIS: issue2: The second problem
Running second probe...
HYPOTHESIS: issue2 FALSIFIED - second evidence

HYPOTHESIS: issue3: The third problem
Running third probe...
HYPOTHESIS: issue3 Survived : third evidence
    `.trim();

    const commands: Array<{ command: string; exitCode: number }> = [];

    const verdicts = parseHypothesisMarkers(transcript);
    expect(verdicts).toHaveLength(3);

    const hypotheses = pairWithProbes(verdicts, commands);
    const result = survivors(hypotheses);

    expect(result).toHaveLength(2);
    expect(result.map((h) => h.id)).toEqual(["issue1", "issue3"]);
  });
});
