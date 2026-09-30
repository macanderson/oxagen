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
import { type StudioSourceType, type StudioTool, sumTokens } from "./model";

/** The part of a server view the draft reads: its tools, as the table lists them. */
type DraftView = {
  tools: readonly Pick<StudioTool, "name" | "imported" | "tokens">[];
};

/** tools.toml's limit on a description, in characters. */
export const DESCRIPTION_MAX = 1024;

const Tool = z.string().min(1).max(128);
/** An impact tag: snake_case, the registry's rule. */
const Impact = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

// Strict, like save_studio_draft's studioDraftOpSchema: a field this page
// does not know makes the edit unreadable rather than being dropped, so a
// stored edit a newer page wrote is never saved back without it.
const DraftOpShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import"), tool: Tool }).strict(),
  z.object({ kind: z.literal("remove"), tool: Tool }).strict(),
  z
    .object({
      kind: z.literal("classify"),
      tool: Tool,
      risk: ToolRiskGrade,
      sideEffect: ToolSideEffect,
      egress: ToolEgress,
      impacts: z.array(Impact).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("describe"),
      tool: Tool,
      description: z.string().min(1).max(DESCRIPTION_MAX),
    })
    .strict(),
  z
    .object({
      kind: z.literal("test"),
      tool: Tool,
      environment: z.string().min(1).max(64),
      /** The arguments as the person typed them, JSON text. */
      args: z.string().max(65_536),
      /** The request as built before the credential is added. */
      request: z.string().max(65_536),
      raw: z.string().max(262_144),
      shaped: z.string().max(262_144),
    })
    .strict(),
]);

export type DraftOp = z.infer<typeof DraftOpShape>;

/**
 * The most a draft's edits may weigh, as UTF-8 JSON: save_studio_draft's
 * STUDIO_DRAFT_OPS_BYTES_MAX (packages/oxagen/src/contracts/
 * tool.studio.draft.save.ts), copied so the browser bundle does not carry
 * the contract. draft.test.ts holds the two together.
 */
const OPS_BYTES_MAX = 8 * 1024 * 1024;

const UTF8 = new TextEncoder();

/** The contract counts `JSON.stringify(ops)` in UTF-8 bytes, so this does too. */
function opsBytes(ops: readonly unknown[]): number {
  return UTF8.encode(JSON.stringify(ops)).length;
}

const DraftShape = z
  .array(DraftOpShape)
  .max(2_000)
  .refine((ops) => opsBytes(ops) <= OPS_BYTES_MAX, {
    message: "The edits pass the size a draft holds.",
  });

/**
 * Stored edits the tab can stage on top of, or null when they break the
 * draft's shape: an edit kind or field this page does not know, or more
 * edits, or more bytes, than a draft holds. A draft another page saved is
 * checked here before anything joins it, so a stored draft this page cannot
 * read never takes the place of the person's own edits.
 */
export function readDraftOps(ops: readonly unknown[]): readonly DraftOp[] | null {
  const parsed = DraftShape.safeParse(ops);
  return parsed.success ? parsed.data : null;
}

/**
 * A draft as the tab stores it: its edits, and the stored revision they were
 * last saved over. Revision 0 is a draft never saved, which is also what a
 * save sends to refuse overwriting a draft someone else stored.
 */
export type StoredDraft = { revision: number; ops: readonly DraftOp[] };

const StoredDraftShape = z.object({
  revision: z.number().int().min(0),
  ops: DraftShape,
});

const EMPTY_DRAFT: StoredDraft = { revision: 0, ops: [] };

/**
 * A stored draft, or an empty one when the text is absent, is not JSON, or
 * does not parse. A draft is a convenience, so a bad one is dropped rather
 * than shown half-read.
 */
export function parseStoredDraft(raw: string | null): StoredDraft {
  if (raw === null) return EMPTY_DRAFT;
  try {
    const parsed = StoredDraftShape.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
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
function stage(
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

/**
 * The draft with one more edit, or null when the result breaks the draft's
 * shape: a test whose result is too long, an impact tag the registry
 * refuses, or more edits than a draft holds. A stored draft that does not
 * parse is dropped whole (parseStoredDraft), so an edit that would spoil it is
 * refused here instead.
 */
export function stageChecked(
  ops: readonly DraftOp[],
  op: DraftOp,
): readonly DraftOp[] | null {
  const next = stage(ops, op);
  return DraftShape.safeParse(next).success ? next : null;
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
  view: DraftView,
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
function draftTests(
  ops: readonly DraftOp[],
): readonly Extract<DraftOp, { kind: "test" }>[] {
  return ops.filter(
    (o): o is Extract<DraftOp, { kind: "test" }> => o.kind === "test",
  );
}

/** The files in the server's folder the steering PR would change. */
type DraftFile = "tools.toml" | "tools.lock.json" | "tests/calls.jsonl";

export function draftFiles(
  view: DraftView,
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
  view: DraftView,
  ops: readonly DraftOp[],
): number {
  return draftLines(view, ops).length + draftTests(ops).length;
}

/**
 * The definition tokens before and after the draft: each a sum of measured
 * tokens, or null when any imported tool has no measurement.
 */
export function draftTokens(
  view: DraftView,
  ops: readonly DraftOp[],
): { before: number | null; after: number | null } {
  return {
    before: sumTokens(view.tools.filter((tool) => tool.imported)),
    after: sumTokens(view.tools.filter((tool) => importedAfter(tool, ops))),
  };
}

/** A saved test's JSON fields, as the Test tab recorded them. */
type TestRecord = Pick<
  Extract<DraftOp, { kind: "test" }>,
  "request" | "raw" | "shaped"
>;

/**
 * Headers that carry a credential. A saved test holding one is refused at
 * save (M5's CREDENTIAL_REQUEST_HEADERS and CREDENTIAL_RESPONSE_HEADERS),
 * so the page strips all four from both sides before it stages the test.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * One recorded request or response without its credential headers: the text
 * as it came when there were none, or null when it is not a JSON object.
 * Only an HTTP exchange has a top-level `headers` record, and one is never
 * added to a shape that has none.
 */
function withoutCredentials(text: string, removed: Set<string>): string | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const { headers } = parsed.value;
  if (!isRecord(headers)) return text;
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      removed.add(name.toLowerCase());
    } else {
      kept[name] = value;
    }
  }
  if (Object.keys(kept).length === Object.keys(headers).length) return text;
  return JSON.stringify({ ...parsed.value, headers: kept });
}

/**
 * A Test tab result made fit to save as a test. The request and the raw
 * result must each be one recorded exchange, a JSON object, and the shaped
 * result must be JSON. Any credential header is removed and named in
 * `removed`, lowercased, so the page can say what it dropped.
 */
export function scrubTest(
  record: TestRecord,
):
  | ({ ok: true; removed: readonly string[] } & TestRecord)
  | { ok: false } {
  const removed = new Set<string>();
  const request = withoutCredentials(record.request, removed);
  const raw = withoutCredentials(record.raw, removed);
  if (request === null || raw === null || !parseJson(record.shaped).ok) {
    return { ok: false };
  }
  return {
    ok: true,
    request,
    raw,
    shaped: record.shaped,
    removed: [...removed].sort(),
  };
}

/**
 * Whether Review needs the server's definition with the draft: whenever the
 * draft imports a tool, and always for a gRPC server, because the lock does
 * not carry the gRPC descriptor set (lane M11's rule for Review).
 */
export function sourceRequired(
  ops: readonly DraftOp[],
  sourceType: StudioSourceType | null,
): boolean {
  return sourceType === "grpc" || ops.some((op) => op.kind === "import");
}

function sameTest(
  a: Extract<DraftOp, { kind: "test" }>,
  b: DraftOp,
): boolean {
  return (
    b.kind === "test" &&
    a.tool === b.tool &&
    a.environment === b.environment &&
    a.args === b.args &&
    a.request === b.request &&
    a.raw === b.raw &&
    a.shaped === b.shaped
  );
}

/**
 * The stored draft with this tab's edits staged on top, for a save refused
 * because someone saved the draft since this tab last did. Each local edit
 * is staged as if made again, so an edit to the same tool replaces the stored
 * one and a test already stored is not added twice. `dropped` counts the
 * edits that would have broken the draft's shape and were left out.
 */
export function mergeDrafts(
  stored: readonly DraftOp[],
  local: readonly DraftOp[],
): { ops: readonly DraftOp[]; dropped: number } {
  let ops = stored;
  let dropped = 0;
  for (const op of local) {
    if (op.kind === "test" && ops.some((o) => sameTest(op, o))) continue;
    const next = stageChecked(ops, op);
    if (next === null) dropped += 1;
    else ops = next;
  }
  return { ops, dropped };
}
