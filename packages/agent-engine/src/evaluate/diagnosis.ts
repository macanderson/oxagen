/**
 * Structured diagnosis artifact (F10).
 *
 * Pure schema, parser, and merge module for diagnosis extraction from agent
 * transcripts. No I/O, no external deps, no `any` (TS 6). Exports interfaces,
 * extraction logic, rendering, and merge rules for root-cause hypotheses.
 *
 * Marker-based extraction: finds DIAGNOSIS_COMPLETE followed by a fenced JSON
 * block, parses it, validates shape, and tolerates common malformations
 * (trailing commas, markdown noise, missing fields). Never throws; returns null
 * on unparseable input.
 *
 * Merge deduplicates hypotheses by mechanism (statement containment or equality,
 * case-insensitive, whitespace-collapsed), caps at 3, and flags disagreement on
 * expectedBehavior only.
 */

// ── Schema ─────────────────────────────────────────────────────────────────────

/**
 * A root-cause hypothesis with optional probe result.
 */
export interface Hypothesis {
  /** Unique identifier for this hypothesis (auto-suffixed on dedupe). */
  id: string;
  /** Concise statement of the hypothesized mechanism. */
  statement: string;
  /** Supporting evidence (may be empty). */
  evidence: string;
  /** Probe result if tested: 'survived' or 'falsified'. */
  probeResult?: "survived" | "falsified";
}

/**
 * Structured diagnosis: problem restatement, expected behavior, root-cause
 * hypotheses, blast radius, and estimated diff budget.
 */
export interface Diagnosis {
  /** One-paragraph restatement of the problem. */
  problem: string;
  /** What "fixed" means, testably. */
  expectedBehavior: string;
  /** 1–3 distinct root-cause mechanisms. */
  rootCauseHypotheses: Hypothesis[];
  /** Files or systems a fix may touch. */
  blastRadius: string[];
  /** Self-estimated lines changed (informs F3 budget). */
  diffBudget: number;
}

// ── Marker and protocol ────────────────────────────────────────────────────────

/**
 * Protocol marker emitted by the agent before the diagnosis JSON block.
 * Used to delimit the diagnosis artifact in the transcript.
 */
export const DIAGNOSIS_MARKER = "DIAGNOSIS_COMPLETE";

// ── Extraction ─────────────────────────────────────────────────────────────────

/**
 * Extract a diagnosis from a transcript.
 *
 * Finds the LAST occurrence of DIAGNOSIS_MARKER in the transcript; after it,
 * locates the first fenced code block (```json ... ``` or bare ``` ... ```)
 * and attempts JSON.parse.
 *
 * Validation:
 * - problem and expectedBehavior must be non-empty strings.
 * - rootCauseHypotheses must be an array with 1–3 entries, each with non-empty
 *   id and statement (evidence defaults to "" if missing).
 * - blastRadius defaults to [] if missing; must be an array of strings.
 * - diffBudget must be a positive finite number; defaults to 120 if missing or invalid.
 * - Hypothesis ids must be unique; duplicates are suffixed (-2, -3, etc.).
 * - If more than 3 hypotheses, keeps the first 3.
 *
 * Tolerances:
 * - Trailing commas before `}` / `]` are stripped before parsing, so a model
 *   that emits them still yields a diagnosis.
 * - Markdown text around the fence is ignored.
 * - A marker with no following fence → null.
 * - Unparseable JSON → null.
 * - Never throws; always returns Diagnosis | null.
 */
export function extractDiagnosis(transcript: string): Diagnosis | null {
  // Guard against non-string input.
  if (typeof transcript !== "string") {
    return null;
  }

  // Find the LAST occurrence of DIAGNOSIS_MARKER.
  const lastMarkerIndex = transcript.lastIndexOf(DIAGNOSIS_MARKER);
  if (lastMarkerIndex === -1) {
    return null;
  }

  // Search for the first fenced code block after the marker.
  const afterMarker = transcript.slice(
    lastMarkerIndex + DIAGNOSIS_MARKER.length,
  );

  // Match ```json ... ``` or bare ``` ... ```.
  // Regex: ``` (optionally followed by "json" or other language tag) ... ```.
  // Allow optional whitespace before closing backticks.
  const fenceMatch = afterMarker.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (!fenceMatch || !fenceMatch[1]) {
    return null;
  }

  const jsonText = fenceMatch[1].trim();

  // Attempt to parse JSON. Tolerate trailing commas by stripping them before parse.
  let parsed: unknown;
  try {
    // Replace trailing commas (simple heuristic: comma followed by ] or }).
    const sanitized = jsonText.replace(/,(\s*[}\]])/g, "$1");
    parsed = JSON.parse(sanitized);
  } catch {
    return null;
  }

  // Validate and normalize the parsed object.
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate problem.
  if (typeof obj.problem !== "string" || obj.problem.trim() === "") {
    return null;
  }
  const problem = obj.problem.trim();

  // Validate expectedBehavior.
  if (
    typeof obj.expectedBehavior !== "string" ||
    obj.expectedBehavior.trim() === ""
  ) {
    return null;
  }
  const expectedBehavior = obj.expectedBehavior.trim();

  // Validate rootCauseHypotheses.
  if (!Array.isArray(obj.rootCauseHypotheses)) {
    return null;
  }
  const rawHypotheses = obj.rootCauseHypotheses;
  // Zero hypotheses is invalid; more than 3 is fine — the slice below keeps
  // the first 3.
  if (rawHypotheses.length < 1) {
    return null;
  }

  const hypotheses: Hypothesis[] = [];
  const seenIds = new Set<string>();

  for (const h of rawHypotheses.slice(0, 3)) {
    if (typeof h !== "object" || h === null) {
      return null;
    }
    const hyp = h as Record<string, unknown>;

    // Validate id and statement.
    if (typeof hyp.id !== "string" || hyp.id.trim() === "") {
      return null;
    }
    if (typeof hyp.statement !== "string" || hyp.statement.trim() === "") {
      return null;
    }

    let id = hyp.id.trim();
    // Deduplicate ids by suffixing.
    let counter = 2;
    const originalId = id;
    while (seenIds.has(id)) {
      id = `${originalId}-${counter}`;
      counter += 1;
    }
    seenIds.add(id);

    const evidence =
      typeof hyp.evidence === "string" ? hyp.evidence.trim() : "";

    hypotheses.push({
      id,
      statement: hyp.statement.trim(),
      evidence,
    });
  }

  if (hypotheses.length === 0) {
    return null;
  }

  // Validate blastRadius (default to []).
  let blastRadius: string[] = [];
  if (Array.isArray(obj.blastRadius)) {
    blastRadius = obj.blastRadius.filter((x) => typeof x === "string");
  }

  // Validate diffBudget (default to 120).
  let diffBudget = 120;
  if (
    typeof obj.diffBudget === "number" &&
    Number.isFinite(obj.diffBudget) &&
    obj.diffBudget > 0
  ) {
    diffBudget = obj.diffBudget;
  }

  return {
    problem,
    expectedBehavior,
    rootCauseHypotheses: hypotheses,
    blastRadius,
    diffBudget,
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────────

/**
 * Render the diagnosis protocol snippet for injection into a system prompt.
 *
 * Instructs the agent to emit DIAGNOSIS_COMPLETE followed by a fenced JSON
 * block with the Diagnosis fields, documented inline. Kept under 120 words.
 *
 * Returns a markdown-formatted instruction block ready for prompt injection.
 */
export function renderDiagnosisInstruction(): string {
  return `## Diagnosis Protocol

After gathering evidence (tests, traces, code reads), emit a structured diagnosis:

1. Output the line: \`DIAGNOSIS_COMPLETE\`
2. Immediately follow with a fenced JSON block:
\`\`\`json
{
  "problem": "one-paragraph restatement",
  "expectedBehavior": "what fixed means, testably",
  "rootCauseHypotheses": [
    { "id": "h1", "statement": "mechanism", "evidence": "why" },
    { "id": "h2", "statement": "alternative mechanism", "evidence": "" }
  ],
  "blastRadius": ["file1.ts", "module2"],
  "diffBudget": 120
}
\`\`\`

Fields: problem (string), expectedBehavior (string), rootCauseHypotheses (1–3 with id + statement), blastRadius (files), diffBudget (positive integer).`;
}

// ── Merge ──────────────────────────────────────────────────────────────────────

/**
 * Normalize a string for comparison: lowercase, collapse whitespace.
 */
function normalizeForComparison(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check if two hypothesis statements are the same mechanism.
 *
 * They are the same if their normalized forms are equal OR one contains the other.
 */
function sameHypothesisMechanism(a: string, b: string): boolean {
  const aNorm = normalizeForComparison(a);
  const bNorm = normalizeForComparison(b);
  return aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm);
}

/**
 * Merge two diagnoses into one.
 *
 * Rules:
 * - problem: keep a's unless empty, then b's.
 * - expectedBehavior: keep a's unless empty, then b's. If both non-empty and
 *   meaningfully different (case-insensitive, whitespace-collapsed inequality),
 *   keep a's and append " [DISAGREEMENT: <b's value>]".
 * - rootCauseHypotheses: union, deduped by mechanism (statement containment or
 *   equality, case-insensitive, whitespace-collapsed). Cap at 3, a's first.
 * - blastRadius: set-union preserving order (a first).
 * - diffBudget: max of the two.
 */
export function mergeDiagnoses(a: Diagnosis, b: Diagnosis): Diagnosis {
  // Merge problem.
  const problem = a.problem.trim() === "" ? b.problem : a.problem;

  // Merge expectedBehavior.
  let expectedBehavior = a.expectedBehavior;
  if (a.expectedBehavior.trim() === "") {
    expectedBehavior = b.expectedBehavior;
  } else if (b.expectedBehavior.trim() !== "") {
    const aNorm = normalizeForComparison(a.expectedBehavior);
    const bNorm = normalizeForComparison(b.expectedBehavior);
    if (aNorm !== bNorm) {
      expectedBehavior = `${a.expectedBehavior} [DISAGREEMENT: ${b.expectedBehavior}]`;
    }
  }

  // Merge rootCauseHypotheses: union, deduped by mechanism, capped at 3.
  const mergedHypotheses: Hypothesis[] = [];
  const seenMechanisms = new Set<string>();

  // Process a's hypotheses first.
  for (const hyp of a.rootCauseHypotheses) {
    const normMechanism = normalizeForComparison(hyp.statement);
    if (!seenMechanisms.has(normMechanism)) {
      seenMechanisms.add(normMechanism);
      mergedHypotheses.push(hyp);
    }
  }

  // Process b's hypotheses, deduping by mechanism.
  for (const hyp of b.rootCauseHypotheses) {
    if (mergedHypotheses.length >= 3) {
      break;
    }
    // Check if this mechanism is already present.
    let isDuplicate = false;
    for (const existing of mergedHypotheses) {
      if (sameHypothesisMechanism(existing.statement, hyp.statement)) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      mergedHypotheses.push(hyp);
    }
  }

  // Merge blastRadius: set-union preserving order (a first).
  const blastRadiusSet = new Set<string>(a.blastRadius);
  const mergedBlastRadius: string[] = [...a.blastRadius];
  for (const item of b.blastRadius) {
    if (!blastRadiusSet.has(item)) {
      mergedBlastRadius.push(item);
      blastRadiusSet.add(item);
    }
  }

  // Merge diffBudget: max of the two.
  const diffBudget = Math.max(a.diffBudget, b.diffBudget);

  return {
    problem,
    expectedBehavior,
    rootCauseHypotheses: mergedHypotheses,
    blastRadius: mergedBlastRadius,
    diffBudget,
  };
}
