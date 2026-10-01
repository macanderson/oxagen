// markdown-import/split.ts: one model call splits a Markdown file into
// statements and classifies each (memory-collection spec, Bulk import:
// Classification; Enforcement grade).
//
// The prompt is the bulk memory importer's splitter
// (packages/agent/src/memory/import.ts), rewritten for the eight
// steering-record kinds and the force a record carries. The call runs on the
// balanced tier, on the organization's own key when it has one, and the
// Billing page counts it as in-app agent spend, as that importer's did.
//
// The model proposes. This module decides: a force the kind does not allow
// moves to the kind's default, words the file does not hold justify nothing,
// a constraint always leaves with an effect, and every other kind with none.
import { z } from "zod";
import { generateObjectFor, selectModelForOrg } from "@oxagen/ai";
import { CREDIT_REASONS } from "@oxagen/billing";
import type { CapabilityContext } from "@oxagen/oxagen";
import { MARKDOWN_IMPORT_STATEMENTS_MAX } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import {
  recordEffectSchema,
  type RecordEffect,
} from "@oxagen/oxagen/steering-repo/record-effect";
import {
  clampForce,
  forceAllowed,
  recordForceSchema,
  type RecordForce,
} from "@oxagen/oxagen/steering-repo/record-force";
import {
  recordKindSchema,
  type RecordKind,
} from "@oxagen/oxagen/steering-repo/record-kind";

/** The longest statement the model may return. A procedure's steps stay together. */
const STATEMENT_MAX = 4000;

/** What the model returns for one file. */
export const splitSchema = z.object({
  statements: z
    .array(
      z.object({
        statement: z.string().min(1).max(STATEMENT_MAX),
        label: z.string().min(1).max(80),
        line: z.number().int().min(1),
        kind: recordKindSchema,
        kindReason: z.string().max(300),
        force: recordForceSchema,
        forceWords: z.string().max(200),
        effect: recordEffectSchema.nullable(),
      }),
    )
    .max(MARKDOWN_IMPORT_STATEMENTS_MAX),
});
export type SplitOutput = z.output<typeof splitSchema>;

export const SPLIT_SYSTEM = [
  "You convert a Markdown document of engineering guidance (a CLAUDE.md, an AGENTS.md, a Cursor rule, a runbook, an ADR, or a style guide) into steering records: atomic, self-contained statements an agent can act on.",
  "",
  "Rules:",
  "- Extract each distinct rule, constraint, convention, gotcha, or durable fact as its own statement. Split compound guidance into separate statements.",
  "- Keep a numbered list of steps together as one procedure, with each step on its own line.",
  "- Each statement must stand alone without the document: one or two imperative, present-tense sentences an agent can act on. Never refer to 'this document', 'above', or 'the section'.",
  "- Skip narrative prose, headings, tables of contents, and examples that carry no durable rule. Merge near-duplicate statements.",
  `- Return at most ${MARKDOWN_IMPORT_STATEMENTS_MAX} statements.`,
  "",
  "For each statement give:",
  "- label: a name of at most 36 characters, in sentence case.",
  "- line: the number of the line the statement comes from, as the document below numbers its lines.",
  "- kind: one of the eight kinds below, and kindReason: one line on why it is that kind.",
  "- force: must, should, may, or info, and forceWords: the exact words from the document that justify it. 'must', 'never', 'always', and 'do not' point to must. 'should' and 'prefer to' point to should. 'consider' and 'can' point to may. When no words signal a force, leave forceWords empty and use the kind's default: should for business-rule, code-rule, constraint, procedure, and skill, may for a preference, and info for a fact or a memory.",
  "- effect: require or forbid for a constraint, and null for every other kind.",
  "",
  "Kinds:",
  "- business-rule: a rule of the business the agent must respect, such as pricing, approvals, or a commitment to a customer.",
  "- code-rule: a rule about how code is written, tested, or reviewed.",
  "- constraint: a gate the agent must not cross or must always meet. It has an effect: require or forbid.",
  "- procedure: steps to follow for a task.",
  "- skill: a packaged capability with instructions an agent loads when a task calls for it.",
  "- fact: something true about the work, which informs without directing. Its force is info.",
  "- preference: a style preference. Its force is may or info.",
  "- memory: something an agent learned in a run. Its force is info.",
  "",
  "Return the structured object only. If the document holds no durable guidance, return an empty list.",
].join("\n");

/** The document as the prompt shows it: the file name, then each line with its number. */
export function splitPrompt(filename: string, content: string): string {
  const numbered = content
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
  return `Filename: ${filename}\n\n${numbered}`;
}

/** The model call, as a seam the tests replace. */
export type SplitModel = (args: {
  filename: string;
  content: string;
  ctx: CapabilityContext;
}) => Promise<SplitOutput>;

/** The production model call: the balanced tier, metered and billed through @oxagen/ai. */
export const splitWithModel: SplitModel = async ({ filename, content, ctx }) => {
  const { object } = await generateObjectFor({
    // Model and funding resolved together (ADR-053 §3, ADR-131), so the key
    // the call is built on and the party billed for it are one answer.
    ...(await selectModelForOrg(ctx.orgId, { tier: "balanced" })),
    chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
    schema: splitSchema,
    system: SPLIT_SYSTEM,
    prompt: splitPrompt(filename, content),
    // 50 statements of a few sentences each, with their fields, fit well
    // inside this. Without a bound the gateway reserves credit against the
    // model's whole output ceiling (see connection.mappings.suggest.ts).
    maxOutputTokens: 16_384,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // A UUID or null: it lands in token_usage's UUID column.
      messageId: ctx.messageId ?? ctx.requestId ?? null,
    },
  });
  return object;
};

/** One statement after the rules are applied. */
export interface SplitStatement {
  statement: string;
  label: string;
  line: number;
  kind: RecordKind;
  kindReason: string;
  force: RecordForce;
  forceWords: string;
  effect: RecordEffect | null;
}

const FORBID_WORDS =
  /\b(never|do not|don't|must not|mustn't|cannot|can't|no longer|forbid|forbidden|avoid|prohibit|prohibited)\b/i;

/** The effect a constraint takes when the model gave none: forbid for a prohibition, else require. */
export function effectOf(statement: string): RecordEffect {
  return FORBID_WORDS.test(statement) ? "forbid" : "require";
}

/** True when `words` appear in the statement or in the file, ignoring case and spacing. */
function quoted(words: string, statement: string, content: string): boolean {
  const needle = words.trim().replace(/\s+/g, " ").toLowerCase();
  if (needle === "") return false;
  const hay = (text: string) => text.replace(/\s+/g, " ").toLowerCase();
  return hay(statement).includes(needle) || hay(content).includes(needle);
}

/**
 * Apply the import's rules to what the model proposed. A blank statement is
 * dropped. A statement whose force its kind forbids takes the kind's default,
 * and so does one whose justifying words the file does not hold. Lines
 * outside the file move to its first or last line.
 */
export function settleStatements(
  output: SplitOutput,
  content: string,
): SplitStatement[] {
  const lineCount = content.split("\n").length;
  const kept = output.statements
    .filter((s) => s.statement.trim() !== "")
    .slice(0, MARKDOWN_IMPORT_STATEMENTS_MAX);
  return kept.map((s) => {
    const statement = s.statement.trim();
    const kind = s.kind;
    const words = s.forceWords.trim();
    const signalled = words !== "" && quoted(words, statement, content);
    const allowed = signalled && forceAllowed(kind, s.force);
    return {
      statement,
      label: s.label.trim(),
      line: Math.min(Math.max(1, s.line), lineCount),
      kind,
      kindReason: s.kindReason.trim().slice(0, 300),
      force: allowed ? s.force : clampForce(kind, null),
      forceWords: allowed ? words : "",
      effect: kind === "constraint" ? (s.effect ?? effectOf(statement)) : null,
    };
  });
}

/** Split one file into settled statements with one model call. */
export async function splitDocument(args: {
  filename: string;
  content: string;
  ctx: CapabilityContext;
  model?: SplitModel;
}): Promise<SplitStatement[]> {
  const model = args.model ?? splitWithModel;
  const output = await model({
    filename: args.filename,
    content: args.content,
    ctx: args.ctx,
  });
  return settleStatements(output, args.content);
}
