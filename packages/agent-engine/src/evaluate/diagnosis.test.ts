import { describe, it, expect } from "vitest";
import {
  extractDiagnosis,
  renderDiagnosisInstruction,
  mergeDiagnoses,
  DIAGNOSIS_MARKER,
  type Diagnosis,
  type Hypothesis,
} from "./diagnosis";

describe("diagnosis", () => {
  describe("extractDiagnosis", () => {
    it("extracts diagnosis from a transcript with ```json fence", () => {
      const transcript = `
        Some analysis...
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        {
          "problem": "The bug is in the parser",
          "expectedBehavior": "Parser should handle null values",
          "rootCauseHypotheses": [
            { "id": "h1", "statement": "Missing null check", "evidence": "Line 42 lacks guard" }
          ],
          "blastRadius": ["parser.ts"],
          "diffBudget": 50
        }
        \`\`\`
        More text after.
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        problem: "The bug is in the parser",
        expectedBehavior: "Parser should handle null values",
        rootCauseHypotheses: [
          {
            id: "h1",
            statement: "Missing null check",
            evidence: "Line 42 lacks guard",
          },
        ],
        blastRadius: ["parser.ts"],
        diffBudget: 50,
      });
    });

    it("extracts diagnosis from a bare ``` fence (no language tag)", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`
        {
          "problem": "Issue",
          "expectedBehavior": "Fixed",
          "rootCauseHypotheses": [
            { "id": "h1", "statement": "Root cause", "evidence": "" }
          ],
          "blastRadius": [],
          "diffBudget": 100
        }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.problem).toBe("Issue");
      expect(result!.rootCauseHypotheses[0]!.evidence).toBe("");
    });

    it("uses last marker when multiple markers present", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "First", "expectedBehavior": "First", "rootCauseHypotheses": [{ "id": "h1", "statement": "s1", "evidence": "" }], "blastRadius": [], "diffBudget": 10 }
        \`\`\`
        More text...
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Second", "expectedBehavior": "Second", "rootCauseHypotheses": [{ "id": "h2", "statement": "s2", "evidence": "" }], "blastRadius": [], "diffBudget": 20 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.problem).toBe("Second");
      expect(result!.diffBudget).toBe(20);
    });

    it("returns null when marker is absent", () => {
      const transcript = `
        Some analysis without marker.
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).toBeNull();
    });

    it("returns null when fence is absent after marker", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        No fence here, just text.
      `;
      const result = extractDiagnosis(transcript);
      expect(result).toBeNull();
    });

    it("parses JSON with trailing commas (the sanitizer strips them)", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        {
          "problem": "Issue",
          "expectedBehavior": "Fixed",
          "rootCauseHypotheses": [
            { "id": "h1", "statement": "s", "evidence": "" },
          ],
          "blastRadius": [],
          "diffBudget": 100,
        }
        \`\`\`
      `;
      // The sanitizer should strip trailing commas, so this should parse.
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.problem).toBe("Issue");
    });

    it("returns null on completely unparseable JSON", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { not valid json at all !!!
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).toBeNull();
    });

    it("validates problem is non-empty string", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).toBeNull();
    });

    it("validates expectedBehavior is non-empty string", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).toBeNull();
    });

    it("validates rootCauseHypotheses is an array with 1-3 entries", () => {
      const transcriptEmpty = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      expect(extractDiagnosis(transcriptEmpty)).toBeNull();

      const transcriptTooMany = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [
          { "id": "h1", "statement": "s1", "evidence": "" },
          { "id": "h2", "statement": "s2", "evidence": "" },
          { "id": "h3", "statement": "s3", "evidence": "" },
          { "id": "h4", "statement": "s4", "evidence": "" }
        ], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcriptTooMany);
      expect(result).not.toBeNull();
      expect(result!.rootCauseHypotheses).toHaveLength(3);
    });

    it("validates hypothesis id and statement are non-empty strings", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      expect(extractDiagnosis(transcript)).toBeNull();

      const transcript2 = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "", "evidence": "" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      expect(extractDiagnosis(transcript2)).toBeNull();
    });

    it("defaults evidence to empty string if missing", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s" }], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.rootCauseHypotheses[0]!.evidence).toBe("");
    });

    it("defaults blastRadius to [] if missing", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.blastRadius).toEqual([]);
    });

    it("defaults diffBudget to 120 if missing or invalid", () => {
      const transcriptMissing = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [] }
        \`\`\`
      `;
      expect(extractDiagnosis(transcriptMissing)!.diffBudget).toBe(120);

      const transcriptNegative = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": -10 }
        \`\`\`
      `;
      expect(extractDiagnosis(transcriptNegative)!.diffBudget).toBe(120);

      const transcriptZero = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [{ "id": "h1", "statement": "s", "evidence": "" }], "blastRadius": [], "diffBudget": 0 }
        \`\`\`
      `;
      expect(extractDiagnosis(transcriptZero)!.diffBudget).toBe(120);
    });

    it("deduplicates hypothesis ids by suffixing", () => {
      const transcript = `
        ${DIAGNOSIS_MARKER}
        \`\`\`json
        { "problem": "Issue", "expectedBehavior": "Fixed", "rootCauseHypotheses": [
          { "id": "h1", "statement": "s1", "evidence": "" },
          { "id": "h1", "statement": "s2", "evidence": "" },
          { "id": "h1", "statement": "s3", "evidence": "" }
        ], "blastRadius": [], "diffBudget": 100 }
        \`\`\`
      `;
      const result = extractDiagnosis(transcript);
      expect(result).not.toBeNull();
      expect(result!.rootCauseHypotheses.map((h) => h.id)).toEqual([
        "h1",
        "h1-2",
        "h1-3",
      ]);
    });

    it("never throws on any input", () => {
      const badInputs = [
        "",
        "no marker",
        "DIAGNOSIS_COMPLETE but no fence",
        `${DIAGNOSIS_MARKER}\n\`\`\`\nnot json\n\`\`\``,
        null,
        undefined,
        123,
      ];

      for (const input of badInputs) {
        expect(() => extractDiagnosis(input as string)).not.toThrow();
      }
    });
  });

  describe("renderDiagnosisInstruction", () => {
    it("returns a string under 120 words", () => {
      const instruction = renderDiagnosisInstruction();
      expect(typeof instruction).toBe("string");
      const wordCount = instruction.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(120);
    });

    it("mentions the DIAGNOSIS_MARKER", () => {
      const instruction = renderDiagnosisInstruction();
      expect(instruction).toContain(DIAGNOSIS_MARKER);
    });

    it("mentions every field name from Diagnosis", () => {
      const instruction = renderDiagnosisInstruction();
      expect(instruction).toContain("problem");
      expect(instruction).toContain("expectedBehavior");
      expect(instruction).toContain("rootCauseHypotheses");
      expect(instruction).toContain("blastRadius");
      expect(instruction).toContain("diffBudget");
    });

    it("includes fenced JSON example", () => {
      const instruction = renderDiagnosisInstruction();
      expect(instruction).toContain("```json");
      expect(instruction).toContain("```");
    });
  });

  describe("mergeDiagnoses", () => {
    it("keeps a's problem when non-empty", () => {
      const a: Diagnosis = {
        problem: "Problem A",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "Problem B",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.problem).toBe("Problem A");
    });

    it("uses b's problem when a's is empty", () => {
      const a: Diagnosis = {
        problem: "",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "Problem B",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.problem).toBe("Problem B");
    });

    it("keeps a's expectedBehavior when non-empty and same as b", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "Behavior",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.expectedBehavior).toBe("Behavior");
    });

    it("appends disagreement annotation to expectedBehavior when different", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "Behavior A",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "Behavior B",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.expectedBehavior).toContain("Behavior A");
      expect(merged.expectedBehavior).toContain("[DISAGREEMENT:");
      expect(merged.expectedBehavior).toContain("Behavior B");
    });

    it("does not append disagreement when only one has expectedBehavior", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "Behavior A",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.expectedBehavior).toBe("Behavior A");
      expect(merged.expectedBehavior).not.toContain("[DISAGREEMENT:");
    });

    it("deduplicates hypotheses by mechanism (exact match)", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h1", statement: "Missing null check", evidence: "e1" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h2", statement: "Missing null check", evidence: "e2" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.rootCauseHypotheses).toHaveLength(1);
      expect(merged.rootCauseHypotheses[0]!.id).toBe("h1");
    });

    it("deduplicates hypotheses by mechanism (containment)", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h1", statement: "Missing null check in parser", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h2", statement: "null check", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.rootCauseHypotheses).toHaveLength(1);
      expect(merged.rootCauseHypotheses[0]!.id).toBe("h1");
    });

    it("deduplicates hypotheses case-insensitively and whitespace-collapsed", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h1", statement: "Missing   NULL   Check", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h2", statement: "missing null check", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.rootCauseHypotheses).toHaveLength(1);
    });

    it("caps merged hypotheses at 3 (a's first)", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h1", statement: "s1", evidence: "" },
          { id: "h2", statement: "s2", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [
          { id: "h3", statement: "s3", evidence: "" },
          { id: "h4", statement: "s4", evidence: "" },
          { id: "h5", statement: "s5", evidence: "" },
        ],
        blastRadius: [],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.rootCauseHypotheses).toHaveLength(3);
      expect(merged.rootCauseHypotheses[0]!.id).toBe("h1");
      expect(merged.rootCauseHypotheses[1]!.id).toBe("h2");
      expect(merged.rootCauseHypotheses[2]!.id).toBe("h3");
    });

    it("merges blastRadius as set-union preserving order (a first)", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: ["a.ts", "b.ts"],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: ["b.ts", "c.ts"],
        diffBudget: 100,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.blastRadius).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    it("merges diffBudget as max of the two", () => {
      const a: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [{ id: "h1", statement: "s1", evidence: "" }],
        blastRadius: [],
        diffBudget: 100,
      };
      const b: Diagnosis = {
        problem: "P",
        expectedBehavior: "B",
        rootCauseHypotheses: [{ id: "h2", statement: "s2", evidence: "" }],
        blastRadius: [],
        diffBudget: 200,
      };
      const merged = mergeDiagnoses(a, b);
      expect(merged.diffBudget).toBe(200);
    });

    it("merges complex scenario correctly", () => {
      const a: Diagnosis = {
        problem: "Parser fails on null",
        expectedBehavior: "Parser handles null gracefully",
        rootCauseHypotheses: [
          { id: "h1", statement: "Missing null check", evidence: "Line 42" },
          {
            id: "h2",
            statement: "Type guard missing",
            evidence: "Type is any",
          },
        ],
        blastRadius: ["parser.ts", "validator.ts"],
        diffBudget: 80,
      };
      const b: Diagnosis = {
        problem: "Parser fails on undefined",
        expectedBehavior: "Parser handles null and undefined gracefully",
        rootCauseHypotheses: [
          { id: "h3", statement: "null check", evidence: "Related to null" },
          { id: "h4", statement: "Boundary condition", evidence: "" },
        ],
        blastRadius: ["parser.ts", "index.ts"],
        diffBudget: 120,
      };
      const merged = mergeDiagnoses(a, b);

      // problem: keep a's
      expect(merged.problem).toBe("Parser fails on null");

      // expectedBehavior: different, so append disagreement
      expect(merged.expectedBehavior).toContain(
        "Parser handles null gracefully",
      );
      expect(merged.expectedBehavior).toContain("[DISAGREEMENT:");

      // hypotheses: h1, h2, h3 (h4 dropped due to cap at 3; h3 is different from h1/h2)
      expect(merged.rootCauseHypotheses).toHaveLength(3);
      expect(merged.rootCauseHypotheses.map((h) => h.id)).toContain("h1");
      expect(merged.rootCauseHypotheses.map((h) => h.id)).toContain("h2");

      // blastRadius: union of both
      expect(merged.blastRadius).toEqual([
        "parser.ts",
        "validator.ts",
        "index.ts",
      ]);

      // diffBudget: max
      expect(merged.diffBudget).toBe(120);
    });
  });
});
