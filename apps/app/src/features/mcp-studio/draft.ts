// The Studio draft (#4678): the edits a person stages on one server before
// Review opens a steering PR. Nothing here writes a record. A staged edit is a
// proposal that lives in the browser tab until the steering PR carries it, so
// the Changes tab can show the tool surface diff and the files the PR would
// touch before anything leaves the page.
//
// A draft never holds a credential. An environment is named, a credential is
// a vault reference the record already holds, and a saved test keeps the
// request as built before the gateway adds the credential (spec, Try it and
// tests).
import { z } from "zod";
import {
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import { type StudioServerView, type StudioTool, sumTokens } from "./model";

/** tools.toml's limit on a description, in characters. */
export const DESCRIPTION_MAX = 1024;

const Tool = z.string().min(1).max(128);
/** An impact tag: snake_case, the registry's rule. */
const Impact = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

const DraftOpShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import"), tool: Tool }),
  z.object({ kind: z.literal("remove"), tool: Tool }),
  z.object({
    kind: z.literal("classify"),
    tool: Tool,
    risk: ToolRiskGrade,
    sideEffect: ToolSideEffect,
    egress: ToolEgress,
    impacts: z.array(Impact).max(32),
  }),
  z.object({
    kind: z.literal("describe"),
    tool: Tool,
    description: z.string().min(1).max(DESCRIPTION_MAX),
  }),
  z.object({
    kind: z.literal("test"),
    tool: Tool,
    environment: z.string().min(1).max(64),
    /** The arguments as the person typed them, JSON text. */
    args: z.string().max(65_536),
    /** The request as built before the credential is added. */
    request: z.string().max(65_536),
    raw: z.string().max(262_144),
    shaped: z.string().max(262_144),
  }),
]);

export type DraftOp = z.infer<typeof DraftOpShape>;
export type DraftOpKind = DraftOp["kind"];

const DraftShape = z.array(DraftOpShape).max(2_000);

/**
 * A stored draft, or an empty one when the text is absent, is not JSON, or
 * does not parse. A draft is a convenience, so a bad one is dropped rather
 * than shown half-read.
 */
export function parseDraft(raw: string | null): readonly DraftOp[] {
  if (raw === null) return [];
  try {
    const parsed = DraftShape.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const OPPOSITE: Readonly<Record<"import" | "remove", "import" | "remove">> = {
  import: "remove",
  remove: "import",
};

/**
 * Add one edit to the draft.
 *
 * - An import and a remove of one tool cancel each other. Cancelling an
 *   import also drops the tool's other staged edits, which only an imported
 *   tool can carry.
 * - A second classification or description of one tool replaces the first.
 * - Each saved test is its own edit.
 */
export function stage(
  ops: readonly DraftOp[],
  op: DraftOp,
): readonly DraftOp[] {
  if (op.kind === "import" || op.kind === "remove") {
    const opposite = OPPOSITE[op.kind];
    if (ops.some((o) => o.kind === opposite && o.tool === op.tool)) {
      return op.kind === "remove"
        ? ops.filter((o) => o.tool !== op.tool)
        : ops.filter((o) => !(o.kind === "remove" && o.tool === op.tool));
    }
    if (ops.some((o) => o.kind === op.kind && o.tool === op.tool)) return ops;
    return [...ops, op];
  }
  if (op.kind === "test") return [...ops, op];
  const at = ops.findIndex((o) => o.kind === op.kind && o.tool === op.tool);
  if (at === -1) return [...ops, op];
  return ops.map((o, index) => (index === at ? op : o));
}

/** The draft without the edit at `index`. */
export function unstage(
  ops: readonly DraftOp[],
  index: number,
): readonly DraftOp[] {
  return ops.filter((_, i) => i !== index);
}

/** Whether a tool is imported once the draft applies. */
export function importedAfter(
  tool: Pick<StudioTool, "name" | "imported">,
  ops: readonly DraftOp[],
): boolean {
  if (ops.some((o) => o.kind === "import" && o.tool === tool.name)) return true;
  if (ops.some((o) => o.kind === "remove" && o.tool === tool.name)) {
    return false;
  }
  return tool.imported;
}

/** The staged classification of a tool, if the draft holds one. */
export function stagedClassification(
  tool: string,
  ops: readonly DraftOp[],
): Extract<DraftOp, { kind: "classify" }> | undefined {
  return ops.find(
    (o): o is Extract<DraftOp, { kind: "classify" }> =>
      o.kind === "classify" && o.tool === tool,
  );
}

/** The staged description of a tool, if the draft holds one. */
export function stagedDescription(
  tool: string,
  ops: readonly DraftOp[],
): string | undefined {
  const op = ops.find(
    (o): o is Extract<DraftOp, { kind: "describe" }> =>
      o.kind === "describe" && o.tool === tool,
  );
  return op?.description;
}

/** One line of the draft's tool surface diff (the contract's `change` words). */
export type DraftLine =
  | { change: "added"; tool: string; tokens: number | null }
  | { change: "removed"; tool: string; tokens: number | null }
  | {
      change: "changed";
      tool: string;
      fields: readonly ("classification" | "description")[];
    };

/** The draft's tool surface diff, in tool order. */
export function draftLines(
  view: Pick<StudioServerView, "tools">,
  ops: readonly DraftOp[],
): readonly DraftLine[] {
  const lines: DraftLine[] = [];
  for (const tool of view.tools) {
    const after = importedAfter(tool, ops);
    if (after && !tool.imported) {
      lines.push({ change: "added", tool: tool.name, tokens: tool.tokens });
      continue;
    }
    if (!after && tool.imported) {
      lines.push({ change: "removed", tool: tool.name, tokens: tool.tokens });
      continue;
    }
    if (!after) continue;
    const fields: ("classification" | "description")[] = [];
    if (stagedClassification(tool.name, ops) !== undefined) {
      fields.push("classification");
    }
    if (stagedDescription(tool.name, ops) !== undefined) {
      fields.push("description");
    }
    if (fields.length > 0) {
      lines.push({ change: "changed", tool: tool.name, fields });
    }
  }
  return lines;
}

/** The saved tests the draft adds. */
export function draftTests(
  ops: readonly DraftOp[],
): readonly Extract<DraftOp, { kind: "test" }>[] {
  return ops.filter(
    (o): o is Extract<DraftOp, { kind: "test" }> => o.kind === "test",
  );
}

/** The files in the server's folder the steering PR would change. */
export type DraftFile = "tools.toml" | "tools.lock.json" | "tests/calls.jsonl";

export function draftFiles(
  view: Pick<StudioServerView, "tools">,
  ops: readonly DraftOp[],
): readonly DraftFile[] {
  const lines = draftLines(view, ops);
  const files: DraftFile[] = [];
  if (lines.length > 0) files.push("tools.toml");
  if (lines.some((line) => line.change !== "changed")) {
    files.push("tools.lock.json");
  }
  if (draftTests(ops).length > 0) files.push("tests/calls.jsonl");
  return files;
}

/** How many edits the Changes tab counts: the diff's lines and the saved tests. */
export function draftCount(
  view: Pick<StudioServerView, "tools">,
  ops: readonly DraftOp[],
): number {
  return draftLines(view, ops).length + draftTests(ops).length;
}

/**
 * The definition tokens before and after the draft: each a sum of measured
 * tokens, or null when any imported tool has no measurement.
 */
export function draftTokens(
  view: Pick<StudioServerView, "tools">,
  ops: readonly DraftOp[],
): { before: number | null; after: number | null } {
  return {
    before: sumTokens(view.tools.filter((tool) => tool.imported)),
    after: sumTokens(view.tools.filter((tool) => importedAfter(tool, ops))),
  };
}
