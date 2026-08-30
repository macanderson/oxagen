/**
 * Probe-based hypothesis falsification (F7).
 *
 * Parser and pairing module: extracts hypothesis verdicts from agent transcripts
 * (marker-based lines with verdict keywords), pairs them with probe commands,
 * and filters survivors.
 *
 * Pure TypeScript, zero I/O, zero external deps, no `any` (TS 6).
 */

import type { Hypothesis } from "../evaluate/diagnosis";

// ── Verdict line parsing ───────────────────────────────────────────────────────

/**
 * A parsed hypothesis verdict from a marker line.
 *
 * Fields:
 * - id: unique identifier (non-whitespace token after HYPOTHESIS:)
 * - statement: the hypothesis mechanism statement, filled from a preceding
 *   declaration line if one exists, else ""
 * - verdict: 'survived' or 'falsified'
 * - evidence: the text after the verdict keyword (rest of the line)
 */
export interface HypothesisVerdict {
  id: string;
  statement: string;
  verdict: "survived" | "falsified";
  evidence: string;
}

/**
 * Parse hypothesis verdict markers from a transcript.
 *
 * Scans for lines matching the pattern:
 *   HYPOTHESIS: <id> (SURVIVED|FALSIFIED) (—|-|:) <evidence>
 *
 * Verdict keyword comes first, then separator (em dash —, hyphen -, or colon :).
 * Verdict keyword is case-insensitive. <id> is a non-whitespace token; <evidence>
 * is the rest of the line and may be empty.
 *
 * Statement backfill: if a preceding line exists of the form
 *   HYPOTHESIS: <id>: <statement>
 * (with a colon after the id but no SURVIVED/FALSIFIED keyword), that
 * statement is used. Otherwise statement = "".
 *
 * Duplicate verdicts: if the same id appears in multiple verdict lines, the
 * LAST one wins.
 *
 * Malformed lines (no id, no verdict keyword) are skipped silently. Never throws.
 *
 * @param transcript - The agent transcript to parse
 * @returns Array of HypothesisVerdict, ordered by appearance (last-wins deduped)
 */
export function parseHypothesisMarkers(
  transcript: string,
): HypothesisVerdict[] {
  if (typeof transcript !== "string") {
    return [];
  }

  const lines = transcript.split("\n");

  // First pass: collect all declaration lines (HYPOTHESIS: <id>: <statement>)
  // to backfill statements into verdicts.
  const declarations = new Map<string, string>();
  for (const line of lines) {
    // Match: HYPOTHESIS: <id>: <statement>
    // (no SURVIVED/FALSIFIED keyword)
    const declMatch = line.match(/^HYPOTHESIS:\s+(\S+):\s+(.*)$/i);
    if (declMatch) {
      const id = declMatch[1]!;
      const statement = declMatch[2]!;
      declarations.set(id, statement);
    }
  }

  // Second pass: collect all verdict lines, keyed by id.
  // Last verdict for each id wins.
  const verdictMap = new Map<string, HypothesisVerdict>();

  for (const line of lines) {
    // Match: HYPOTHESIS: <id> (SURVIVED|FALSIFIED) (—|-|:) <evidence>
    // Verdict keyword comes first, then separator, then evidence.
    // Verdict is case-insensitive.
    const verdictMatch = line.match(
      /^HYPOTHESIS:\s+(\S+)\s+(survived|falsified)\s+(?:—|-|:)\s*(.*)$/i,
    );

    if (verdictMatch) {
      const id = verdictMatch[1]!;
      const verdict = verdictMatch[2]!.toLowerCase() as
        | "survived"
        | "falsified";
      const evidence = verdictMatch[3]!;

      // Backfill statement from declarations, else "".
      const statement = declarations.get(id) ?? "";

      verdictMap.set(id, {
        id,
        statement,
        verdict,
        evidence,
      });
    }
  }

  // Return verdicts in order of first appearance in the original lines.
  const result: HypothesisVerdict[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.match(/^HYPOTHESIS:\s+(\S+)\s+(survived|falsified)/i);
    if (match) {
      const id = match[1]!;
      if (seen.has(id)) continue;
      // Only claim the id once a PARSED verdict exists for it. This prefix
      // regex is looser than the verdict regex above (it does not require the
      // separator), so a malformed line like `HYPOTHESIS: h1 SURVIVED` with no
      // `—`/`-`/`:` matches here but produced no entry in `verdictMap`. Marking
      // it seen anyway would suppress a well-formed verdict for the same id
      // later in the transcript.
      const verdict = verdictMap.get(id);
      if (verdict) {
        seen.add(id);
        result.push(verdict);
      }
    }
  }

  return result;
}

// ── Pairing with probes ────────────────────────────────────────────────────────

/**
 * Pair verdicts with probe commands to produce Hypothesis objects.
 *
 * For each verdict:
 * - Creates a Hypothesis with id, statement, evidence, and probeResult
 * - If evidence is empty, backtracks through commands to find one whose
 *   command string mentions the hypothesis id (case-insensitive substring match).
 *   If found, backfills evidence with that command string.
 *
 * @param verdicts - Array of HypothesisVerdict from parseHypothesisMarkers
 * @param commands - Array of observed commands with exit codes
 * @returns Array of Hypothesis with probeResult field set
 */
export function pairWithProbes(
  verdicts: HypothesisVerdict[],
  commands: Array<{ command: string; exitCode: number }>,
): Hypothesis[] {
  return verdicts.map((verdict) => {
    let evidence = verdict.evidence;

    // If evidence is empty, backfill from the last command mentioning the id.
    if (evidence === "" && commands.length > 0) {
      // Search backwards for a command mentioning the hypothesis id.
      for (let i = commands.length - 1; i >= 0; i--) {
        const cmd = commands[i];
        if (
          cmd &&
          cmd.command.toLowerCase().includes(verdict.id.toLowerCase())
        ) {
          evidence = cmd.command;
          break;
        }
      }
    }

    return {
      id: verdict.id,
      statement: verdict.statement,
      evidence,
      probeResult: verdict.verdict,
    };
  });
}

// ── Filtering survivors ────────────────────────────────────────────────────────

/**
 * Filter hypotheses to survivors only (probeResult === 'survived'), capped at 3.
 *
 * Returns the first 3 survivors in order, preserving order from the input.
 *
 * @param hypotheses - Array of Hypothesis objects
 * @returns Array of surviving hypotheses, capped at 3
 */
export function survivors(hypotheses: Hypothesis[]): Hypothesis[] {
  return hypotheses.filter((h) => h.probeResult === "survived").slice(0, 3);
}

// ── Rendering probe instruction ────────────────────────────────────────────────

/**
 * Render the probe protocol instruction for injection into a system prompt.
 *
 * Returns a concise snippet (under 120 words) instructing the agent to:
 * 1. Enumerate 2–3 distinct root-cause hypotheses (different mechanisms)
 * 2. Design the cheapest executable probe that could falsify each
 * 3. Run the probes
 * 4. Report results on individual lines in HYPOTHESIS: <id> SURVIVED|FALSIFIED — <evidence> format
 *
 * @returns Markdown-formatted instruction block
 */
export function renderProbeInstruction(): string {
  return `## Probe Protocol

Enumerate 2–3 distinct root-cause hypotheses (different mechanisms, not phrasings). For each:

1. Design the cheapest executable probe (assertion, print, or script) that could falsify it.
2. Run the probe.
3. Report the result on its own line:
   \`HYPOTHESIS: <id> SURVIVED|FALSIFIED — <evidence>\`

Example:
\`\`\`
HYPOTHESIS: h1 FALSIFIED — assertion failed: expected X but got Y
HYPOTHESIS: h2 SURVIVED — probe did not trigger the condition
\`\`\`

Use the exact format above. Separate verdict from evidence with — (em dash), hyphen, or colon.`;
}
