import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { Hypothesis } from "../evaluate/diagnosis";
import {
  messageText,
  findSnapshotBoundary,
  snapshotTrunk,
  buildTailInstruction,
  planForks,
  type TrunkSnapshot,
} from "./index";

// ── messageText ────────────────────────────────────────────────────────────────

describe("messageText", () => {
  it("extracts string content as-is", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: "hello world",
    };
    expect(messageText(msg)).toBe("hello world");
  });

  it("concatenates text fields from parts array", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(messageText(msg)).toBe("hello world");
  });

  it("ignores non-text parts in array content", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "visible" },
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "search",
          input: { q: "x" },
        },
        { type: "text" as const, text: " text" },
      ],
    } as ModelMessage;
    expect(messageText(msg)).toBe("visible text");
  });

  it("returns empty string for empty parts array", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: [],
    };
    expect(messageText(msg)).toBe("");
  });

  it("returns empty string for unknown shape", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: null as unknown as string,
    };
    expect(messageText(msg)).toBe("");
  });

  it("handles mixed part types gracefully", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "start" },
        {
          type: "tool-call" as const,
          toolName: "test",
          toolCallId: "123",
          input: {},
        },
        { type: "text" as const, text: "end" },
      ],
    } as ModelMessage;
    expect(messageText(msg)).toBe("startend");
  });

  it("never throws on malformed content", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "normal" },
        { type: "text", text: "orphan" },
      ] as const,
    };
    expect(() => messageText(msg)).not.toThrow();
    expect(messageText(msg)).toBe("normalorphan");
  });
});

// ── findSnapshotBoundary ───────────────────────────────────────────────────────

describe("findSnapshotBoundary", () => {
  it("finds boundary after last DIAGNOSIS_MARKER message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "thinking DIAGNOSIS_COMPLETE here" },
      { role: "user", content: "continue" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(2);
  });

  it("returns messages.length when no marker present", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "no marker here" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(messages.length);
  });

  it("uses LAST marker when multiple present", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "first DIAGNOSIS_MARKER" },
      { role: "user", content: "middle" },
      { role: "assistant", content: "second DIAGNOSIS_MARKER content" },
      { role: "user", content: "after" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(4);
  });

  it("handles marker in array content parts", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "prefix " },
          { type: "text", text: "DIAGNOSIS_MARKER suffix" },
        ],
      },
      { role: "user", content: "after" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(3);
  });

  it("handles empty message list", () => {
    expect(findSnapshotBoundary([])).toBe(0);
  });

  it("handles marker at start", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "DIAGNOSIS_MARKER first" },
      { role: "user", content: "after" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(2);
  });

  it("handles marker at end", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "before" },
      { role: "assistant", content: "DIAGNOSIS_MARKER last" },
    ];
    const boundary = findSnapshotBoundary(messages);
    expect(boundary).toBe(2);
  });
});

// ── snapshotTrunk ────────────────────────────────────────────────────────────

describe("snapshotTrunk", () => {
  it("creates snapshot with diagnosis and messages up to marker", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "issue: bug in foo" },
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "foo returns wrong value",
  "expectedBehavior": "should return 42",
  "rootCauseHypotheses": [
    { "id": "h1", "statement": "off-by-one error", "evidence": "loop bounds" }
  ],
  "blastRadius": ["src/foo.ts"],
  "diffBudget": 50
}
\`\`\``,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.diagnosis).not.toBeNull();
    expect(snapshot.diagnosis?.problem).toBe("foo returns wrong value");
    expect(snapshot.diagnosis?.diffBudget).toBe(50);
  });

  it("falls back to diagnosis hypotheses when no verdicts present", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "issue" },
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "test problem",
  "expectedBehavior": "should work",
  "rootCauseHypotheses": [
    { "id": "h1", "statement": "cause A", "evidence": "evidence A" },
    { "id": "h2", "statement": "cause B", "evidence": "" }
  ],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\``,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.hypotheses).toHaveLength(2);
    expect(snapshot.hypotheses[0]?.id).toBe("h1");
    expect(snapshot.hypotheses[1]?.id).toBe("h2");
  });

  it("extracts survivors from verdict markers", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "issue" },
      {
        role: "assistant",
        content: `analysis
DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "test",
  "expectedBehavior": "works",
  "rootCauseHypotheses": [
    { "id": "h1", "statement": "cause", "evidence": "" }
  ],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\`

probes:
HYPOTHESIS: h1 SURVIVED — probe did not trigger
HYPOTHESIS: h2 FALSIFIED — assertion failed`,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.hypotheses).toHaveLength(1);
    expect(snapshot.hypotheses[0]?.id).toBe("h1");
    expect(snapshot.hypotheses[0]?.probeResult).toBe("survived");
  });

  it("excludes falsified hypotheses from survivors", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "test",
  "expectedBehavior": "fix",
  "rootCauseHypotheses": [],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\`

HYPOTHESIS: h1 FALSIFIED — wrong
HYPOTHESIS: h2 SURVIVED — correct
HYPOTHESIS: h3 FALSIFIED — also wrong`,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.hypotheses).toHaveLength(1);
    expect(snapshot.hypotheses[0]?.id).toBe("h2");
    expect(snapshot.hypotheses[0]?.probeResult).toBe("survived");
  });

  it("returns empty hypotheses when all verdicts falsified", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "test",
  "expectedBehavior": "fix",
  "rootCauseHypotheses": [],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\`

HYPOTHESIS: h1 FALSIFIED — nope
HYPOTHESIS: h2 FALSIFIED — nope`,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.hypotheses).toHaveLength(0);
  });

  it("never throws on malformed diagnosis JSON", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{ bad json }
\`\`\``,
      },
    ];

    expect(() => snapshotTrunk(messages)).not.toThrow();
    const snapshot = snapshotTrunk(messages);
    expect(snapshot.diagnosis).toBeNull();
  });

  it("never throws on missing diagnosis marker", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "no diagnosis" },
    ];

    expect(() => snapshotTrunk(messages)).not.toThrow();
    const snapshot = snapshotTrunk(messages);
    expect(snapshot.diagnosis).toBeNull();
    expect(snapshot.messages).toHaveLength(1);
  });

  it("caps diagnosis hypotheses at 3 on fallback", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "test",
  "expectedBehavior": "fix",
  "rootCauseHypotheses": [
    { "id": "h1", "statement": "a", "evidence": "" },
    { "id": "h2", "statement": "b", "evidence": "" },
    { "id": "h3", "statement": "c", "evidence": "" },
    { "id": "h4", "statement": "d", "evidence": "" }
  ],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\``,
      },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.hypotheses).toHaveLength(3);
    expect(snapshot.hypotheses.map((h) => h.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("handles mixed messages up to marker", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "analysis" },
      {
        role: "assistant",
        content: `DIAGNOSIS_COMPLETE
\`\`\`json
{
  "problem": "bug",
  "expectedBehavior": "fixed",
  "rootCauseHypotheses": [{ "id": "h", "statement": "root", "evidence": "" }],
  "blastRadius": [],
  "diffBudget": 100
}
\`\`\``,
      },
      { role: "user", content: "this should not be included" },
    ];

    const snapshot = snapshotTrunk(messages);
    expect(snapshot.messages).toHaveLength(3);
  });
});

// ── buildTailInstruction ───────────────────────────────────────────────────────

describe("buildTailInstruction", () => {
  it("includes hypothesis id and statement", () => {
    const h: Hypothesis = {
      id: "h1",
      statement: "off-by-one error in loop",
      evidence: "bounds check",
    };
    const instruction = buildTailInstruction(h);

    expect(instruction).toContain("h1");
    expect(instruction).toContain("off-by-one error in loop");
  });

  it("includes evidence when present", () => {
    const h: Hypothesis = {
      id: "h2",
      statement: "race condition",
      evidence: "missing lock on shared state",
    };
    const instruction = buildTailInstruction(h);

    expect(instruction).toContain("missing lock on shared state");
  });

  it("omits evidence when empty", () => {
    const h: Hypothesis = {
      id: "h3",
      statement: "null pointer dereference",
      evidence: "",
    };
    const instruction = buildTailInstruction(h);

    expect(instruction).toContain("h3");
    expect(instruction).toContain("null pointer dereference");
    expect(instruction.match(/Evidence:/g) || []).toHaveLength(0);
  });

  it("keeps instruction under 120 words for typical hypothesis", () => {
    const h: Hypothesis = {
      id: "h1",
      statement: "off-by-one in array index calculation",
      evidence: "loop bounds check missing upper limit validation",
    };
    const instruction = buildTailInstruction(h);
    const wordCount = instruction.split(/\s+/).length;

    expect(wordCount).toBeLessThanOrEqual(120);
  });

  it("never throws", () => {
    const h: Hypothesis = {
      id: "",
      statement: "",
      evidence: "",
    };
    expect(() => buildTailInstruction(h)).not.toThrow();
  });

  it("mentions minimal patch implementation", () => {
    const h: Hypothesis = {
      id: "h1",
      statement: "test",
      evidence: "",
    };
    const instruction = buildTailInstruction(h);

    expect(instruction.toLowerCase()).toContain("minimal");
  });

  it("mentions repro and tests", () => {
    const h: Hypothesis = {
      id: "h1",
      statement: "test",
      evidence: "",
    };
    const instruction = buildTailInstruction(h);

    expect(instruction.toLowerCase()).toContain("repro");
    expect(instruction.toLowerCase()).toContain("test");
  });
});

// ── planForks ────────────────────────────────────────────────────────────────

describe("planForks", () => {
  it("creates one plan per hypothesis up to maxTails", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "cause1", evidence: "" },
      { id: "h2", statement: "cause2", evidence: "" },
      { id: "h3", statement: "cause3", evidence: "" },
    ];
    const messages: ModelMessage[] = [{ role: "user", content: "test" }];
    const snapshot: TrunkSnapshot = {
      messages,
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 2);
    expect(plans).toHaveLength(2);
    expect(plans[0]?.hypothesis.id).toBe("h1");
    expect(plans[1]?.hypothesis.id).toBe("h2");
  });

  it("caps at maxTails", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "cause1", evidence: "" },
      { id: "h2", statement: "cause2", evidence: "" },
    ];
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 1);
    expect(plans).toHaveLength(1);
  });

  it("respects minimum cap of 1", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "test", evidence: "" },
    ];
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 0);
    expect(plans).toHaveLength(1);
  });

  it("returns empty array for zero hypotheses", () => {
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses: [],
    };

    const plans = planForks(snapshot, 5);
    expect(plans).toHaveLength(0);
  });

  it("includes history for each plan", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
    ];
    const snapshot: TrunkSnapshot = {
      messages,
      diagnosis: null,
      hypotheses: [{ id: "h1", statement: "test", evidence: "" }],
    };

    const plans = planForks(snapshot, 5);
    expect(plans[0]?.history).toEqual(messages);
  });

  it("includes instruction for each plan", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "cause A", evidence: "evidence A" },
    ];
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 5);
    expect(plans[0]?.instruction).toContain("h1");
    expect(plans[0]?.instruction).toContain("cause A");
    expect(plans[0]?.instruction).toContain("evidence A");
  });

  it("never throws on empty snapshot", () => {
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses: [],
    };

    expect(() => planForks(snapshot, 5)).not.toThrow();
  });

  it("plans for maxTails equal to hypothesis count", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "a", evidence: "" },
      { id: "h2", statement: "b", evidence: "" },
    ];
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 2);
    expect(plans).toHaveLength(2);
  });

  it("plans all hypotheses when maxTails exceeds count", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "a", evidence: "" },
      { id: "h2", statement: "b", evidence: "" },
    ];
    const snapshot: TrunkSnapshot = {
      messages: [],
      diagnosis: null,
      hypotheses,
    };

    const plans = planForks(snapshot, 10);
    expect(plans).toHaveLength(2);
  });
});
