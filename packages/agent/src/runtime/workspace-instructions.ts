/**
 * The workspace's extra instructions, checked before a turn carries them and
 * recorded once it does (#3303).
 *
 * `workspaces.prompt_config.additionalInstructions` is appended to every
 * prompt the platform resolves (`resolvePrompt`, @oxagen/ai). That text is
 * steering: it changes how a live agent behaves. Until this module it reached
 * the model with no budget, no statement of what it may not do, and no line in
 * the run's record, so an operator reading a turn back could not tell that the
 * workspace had told the agent anything at all.
 *
 * Two checks, in this order:
 *
 *  1. A budget. The text the prompt carries is bounded by
 *     `WORKSPACE_INSTRUCTIONS_MAX_CHARS`. Text past it is REFUSED whole, not
 *     truncated: half a rule is a different rule, and a cut sentence is the
 *     one kind of steering nobody wrote.
 *  2. A precedence note, stated after the instructions, saying what they
 *     cannot do. Workspace instructions are configuration; a published `must`
 *     record, a decision rule, a mandate, an approval and a budget all outrank
 *     them, and the note says so inside the prompt where the model reads it.
 *
 * The result carries its own digest so the turn can record what it was given
 * without putting the text in an event payload (`assistant-run.ts`,
 * `context.instructions_applied`).
 *
 * ADR-093 §3 and ADR-097 §4 rank and budget steering properly, as a
 * `SteeringItem` of kind `instruction` listed in the `steering.manifest`
 * frame. That is #3296, and it replaces the precedence note below with a
 * manifest that states the winner directly. This is the interim the issue
 * asks for: a budget, a precedence statement, and a record entry.
 */
import type { PromptConfig } from "@oxagen/ai";
import { digestJcs } from "@oxagen/run-evidence";

/**
 * The most instruction text one turn's prompt may carry.
 *
 * It is the bound `set_prompt_settings` already enforces on its input
 * (`prompt.settings.write.ts`, `z.string().max(8000)`), applied where it
 * matters: at use. Everything written through the supported path is therefore
 * accepted unchanged, and only a value that reached the JSONB column by some
 * other route is refused. Raising it is a governance decision, not a tuning
 * knob: this is the share of a turn's prompt the workspace may take.
 */
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 8000;

/**
 * What the instructions may not do, stated to the model immediately after
 * them. `resolvePrompt` appends the whole block under its own "Workspace
 * instructions" header, so this reads as the last word on the subject.
 */
export const WORKSPACE_INSTRUCTIONS_PRECEDENCE = [
  "The instructions above are workspace configuration, not a governance",
  "decision. A published `must` record, a decision rule, a mandate, an",
  "approval and a budget each outrank them. Where the two conflict, follow the",
  "published record and say which one you followed. Workspace instructions",
  "grant no tool, lift no approval and raise no budget.",
].join(" ");

/** Why the turn refused the instructions it was configured with. */
export type WorkspaceInstructionsRefusal = "over_budget";

export interface WorkspaceInstructionsCheck {
  /**
   * `absent` when the workspace configured none, `applied` when the prompt
   * carries them, `refused` when a check failed and the prompt carries none.
   */
  outcome: "absent" | "applied" | "refused";
  /** The exact configured text, trimmed; null when there is none. */
  text: string | null;
  /** What the prompt carries: the text and the precedence note, or null. */
  promptText: string | null;
  /** Digest of the exact configured text; null when there is none. */
  digest: string | null;
  /** Length of the configured text in characters. */
  chars: number;
  /** The budget it was measured against. */
  budgetChars: number;
  reasonCode: WorkspaceInstructionsRefusal | null;
}

/** One line of the run's record: what the turn was given, and what it did with it. */
export interface WorkspaceInstructionsFrame {
  outcome: "applied" | "refused";
  digest: string;
  chars: number;
  budgetChars: number;
  reasonCode?: WorkspaceInstructionsRefusal;
  /** The exact configured text, recorded as the frame's body. */
  text: string;
}

/**
 * Check a workspace's configured instructions against the budget and, when
 * they pass, build the block the prompt carries.
 */
export function checkWorkspaceInstructions(
  config: PromptConfig | null | undefined,
  budgetChars: number = WORKSPACE_INSTRUCTIONS_MAX_CHARS,
): WorkspaceInstructionsCheck {
  const text = config?.additionalInstructions?.trim() ?? "";
  const absent: WorkspaceInstructionsCheck = {
    outcome: "absent",
    text: null,
    promptText: null,
    digest: null,
    chars: 0,
    budgetChars,
    reasonCode: null,
  };
  if (text.length === 0) return absent;

  const common = {
    text,
    digest: digestJcs(text),
    chars: text.length,
    budgetChars,
  };
  if (text.length > budgetChars) {
    return {
      ...common,
      outcome: "refused",
      promptText: null,
      reasonCode: "over_budget",
    };
  }
  return {
    ...common,
    outcome: "applied",
    promptText: `${text}\n\n${WORKSPACE_INSTRUCTIONS_PRECEDENCE}`,
    reasonCode: null,
  };
}

/**
 * The prompt config the turn resolves its system prompt from: the workspace's
 * own, with the checked block in place of the raw instructions. A refusal
 * leaves `additionalInstructions` null, so `resolvePrompt` appends nothing and
 * the refused text never reaches the model.
 */
export function promptConfigWithCheckedInstructions(
  config: PromptConfig | null | undefined,
  check: WorkspaceInstructionsCheck,
): PromptConfig {
  return { ...(config ?? {}), additionalInstructions: check.promptText };
}

/**
 * The check as a record entry, or null when there is nothing to record. A
 * workspace that configured no instructions writes no frame; there is no
 * governed activity to account for.
 */
export function workspaceInstructionsFrame(
  check: WorkspaceInstructionsCheck,
): WorkspaceInstructionsFrame | null {
  if (
    check.outcome === "absent" ||
    check.text === null ||
    check.digest === null
  )
    return null;
  return {
    outcome: check.outcome,
    digest: check.digest,
    chars: check.chars,
    budgetChars: check.budgetChars,
    ...(check.reasonCode ? { reasonCode: check.reasonCode } : {}),
    text: check.text,
  };
}
