/**
 * `oxagen run context <run-id>`: the CLI parity surface for `get_run_context`
 * (ADR-193). One row per model request the run recorded a window for, with
 * the prompt tokens the vendor reported and each block's share of them, then
 * the model calls recorded with no window and the steering assembler's
 * budget.
 *
 * A block's tokens are its byte share of the vendor's total, so a row's
 * blocks add up to its prompt tokens. A block the recorder could not tell
 * apart prints as a dash, and a figure the record does not carry prints as
 * not recorded, never as a zero.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; failures are uniform stderr error lines.
 */
import { apiPostOrThrow } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

const BLOCKS = [
  "system",
  "steering",
  "tools",
  "context",
  "conversation",
] as const;
type BlockKind = (typeof BLOCKS)[number];

/** Mirrors the `get_run_context` contract output. */
interface RunContextResult {
  runId: string;
  source: "wrapped" | "ledger";
  windows: {
    seq: string;
    responseSeq: string | null;
    modelCallId: string | null;
    provider: string | null;
    model: string | null;
    promptTokens: number | null;
    bytes: number;
    blocks: {
      kind: BlockKind;
      bytes: number;
      items: number;
      tokens: number | null;
    }[];
  }[];
  unmeasured: number;
  assemblies: {
    seq: string;
    budgetTokens: number;
    spentTokens: number;
    included: number;
    cut: number;
    textDigest: string | null;
  }[];
  complete: boolean;
}

const NOT_RECORDED = "not recorded";
const count = (n: number) => n.toLocaleString("en-US");

export async function runContext(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RunContextResult;
  try {
    result = await apiPostOrThrow<RunContextResult>("runs/context", { runId });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `${result.runId}: ${result.windows.length} window(s) recorded, ${result.unmeasured} model call(s) without one`,
  );
  const assembly = result.assemblies[0];
  if (assembly !== undefined)
    writer.write(
      `Steering: ${count(assembly.spentTokens)} of ${count(assembly.budgetTokens)} tokens spent, ${assembly.included} included, ${assembly.cut} cut (frame ${assembly.seq})`,
    );
  if (result.windows.length === 0) {
    writer.write(
      "The run recorded no window. A window is recorded when the model call passes through the Oxagen gateway.",
    );
    return;
  }
  const rows = [
    ["Frame", "Model", "Prompt tokens", ...BLOCKS.map(titleOf)],
    ...result.windows.map((w) => [
      w.seq,
      w.model ?? NOT_RECORDED,
      w.promptTokens === null ? NOT_RECORDED : count(w.promptTokens),
      ...BLOCKS.map((kind) => {
        const block = w.blocks.find((b) => b.kind === kind);
        if (block === undefined) return "-";
        return block.tokens === null ? NOT_RECORDED : count(block.tokens);
      }),
    ]),
  ];
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length)),
  );
  writer.write("");
  for (const r of rows)
    writer.write(
      r
        .map((cell, col) =>
          col < 2
            ? cell.padEnd(widths[col] ?? 0)
            : cell.padStart(widths[col] ?? 0),
        )
        .join("  "),
    );
  if (!result.complete) {
    writer.write("");
    writer.write(
      `The run is longer than one read carries. These are its first ${result.windows.length} windows.`,
    );
  }
}

function titleOf(kind: BlockKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
