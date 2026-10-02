/**
 * The in-app assistant's steering, as the one assembler states it and the
 * turn's run records it (ADR-093 §7).
 *
 * A Stella turn carries no workspace steering (ADR-235, which amends ADR-093
 * §7 and reverses the #4158 path that fed the workspace's published records
 * and instructions into the prompt). `noWorkspaceSteering` is what the turn
 * uses: the assembler with no candidate, so the prompt is Oxagen's baseline
 * alone and the run's `steering.manifest` frame names no item. That frame is
 * the record's statement that nothing from the workspace steered the turn.
 *
 * `assembleAssistantSteering` still takes published records and the
 * workspace's instructions, and ranks a published MUST record above the
 * instructions (#3303). The run recorder's tests build manifests with it. No
 * production path hands it a workspace item.
 */
import type { PromptConfig } from "@oxagen/ai";
import { digestJcs } from "@oxagen/run-evidence";
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
  PREFIX_FORCES,
  type SteeringCandidate,
  type SteeringItemKind,
  type SteeringManifest,
} from "@oxagen/steering-assembler";
/**
 * The most instruction text `update_prompt_settings` accepts
 * (`prompt.settings.write.ts`, `z.string().max(8000)`). A value past it can
 * only have reached the column by another route.
 */
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 8000;

/**
 * The share of the assistant's system prompt that steering may take, in
 * budget tokens (`ceil(utf8_bytes / 4)`): 4,096, about 16,000 bytes.
 *
 * It holds everything a wrapped agent's prefix can hold
 * (`PREFIX_BUDGET_TOKENS`, 2,000) beside the longest instructions the
 * supported write path accepts (8,000 characters, 2,000 budget tokens when
 * each character is one byte), with 96 left for the header and the tier
 * headings. Text in a script that takes more bytes per character costs more,
 * and whatever does not fit is cut and named in the manifest. The system
 * prompt goes to the model directly, not through a hook, so no harness limit
 * applies here.
 */
export const ASSISTANT_STEERING_BUDGET_TOKENS =
  PREFIX_BUDGET_TOKENS + WORKSPACE_INSTRUCTIONS_MAX_CHARS / 4 + 96;

/** The manifest id of the workspace's instructions. */
export const WORKSPACE_INSTRUCTIONS_ID = "workspace-instructions";

/**
 * The line the assistant's steering opens with. The bundle's header names
 * published records only; this text can also carry the workspace's
 * instructions, so it names both sources and states the precedence the
 * ranking encodes.
 */
export const ASSISTANT_STEERING_HEADER = [
  "This workspace's steering, assembled by Oxagen from the records its",
  "reviewers published and any instructions its administrators set.",
  "Follow every MUST item. Follow every SHOULD item unless the task gives you",
  "a stated reason not to. Where two items conflict, follow the one listed",
  "first. No item grants a tool, lifts an approval, or raises a budget.",
].join(" ");

/** The heading the steering text sits under in the system prompt. */
const STEERING_SECTION = "\n\n---\n\n## Workspace steering\n\n";

/** What one turn was steered with, and the account of it for the run. */
export interface AssistantSteering {
  /** The text the system prompt carries, or null when nothing was included. */
  text: string | null;
  manifest: SteeringManifest;
  /** Digest of the configured instructions, trimmed; null when there are none. */
  instructionsDigest: string | null;
  /** Source families whose read failed, so the turn ran without their items. */
  unavailableKinds: SteeringItemKind[];
}

/** What the run records: the manifest and what the payload says beside it. */
export type AssistantSteeringFrame = Pick<
  AssistantSteering,
  "manifest" | "instructionsDigest" | "unavailableKinds"
>;

/**
 * The workspace's instructions as a candidate, or null when it configured
 * none.
 *
 * The force is `should`. The instructions are configuration, not a decision
 * reviewers merged, so a published MUST record ranks above them. Workspace
 * configuration records no instant, so an empty `recordedAt` ranks the
 * instructions as the oldest SHOULD item: under budget pressure they are the
 * first SHOULD item cut, and a published SHOULD record is listed before them.
 */
export function instructionCandidate(
  config: PromptConfig | null | undefined,
): SteeringCandidate | null {
  const text = config?.additionalInstructions?.trim() ?? "";
  if (text === "") return null;
  return {
    id: WORKSPACE_INSTRUCTIONS_ID,
    kind: "instruction",
    force: "should",
    body: `Workspace instructions: ${text}`,
    recordedAt: "",
  };
}

/**
 * Assemble one turn's steering from the records read and the workspace's
 * configuration. Pure: the same inputs give the same text and manifest in
 * any record order.
 *
 * The assistant delivers what a wrapped agent's session prefix delivers,
 * `must` and `should`. A `may` or `info` record waits for a channel that
 * ranks against the prompt (ADR-093 §4), and the manifest cuts it for its
 * tier.
 */
export function assembleAssistantSteering(input: {
  orgId: string;
  workspaceId: string;
  records: readonly SteeringCandidate[];
  promptConfig: PromptConfig | null | undefined;
  unavailableKinds?: readonly SteeringItemKind[];
  budgetTokens?: number;
}): AssistantSteering {
  const configured = input.promptConfig?.additionalInstructions?.trim() ?? "";
  const instructions = instructionCandidate(input.promptConfig);
  const { text, manifest } = assembleSteering(
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      delivers: PREFIX_FORCES,
      header: ASSISTANT_STEERING_HEADER,
      candidates: instructions
        ? [...input.records, instructions]
        : input.records,
    },
    input.budgetTokens ?? ASSISTANT_STEERING_BUDGET_TOKENS,
  );
  return {
    text,
    manifest,
    instructionsDigest: configured === "" ? null : digestJcs(configured),
    unavailableKinds: [...(input.unavailableKinds ?? [])],
  };
}

/**
 * The steering of a Stella turn: none (ADR-235). The workspace's published
 * records and its instructions steer the workspace's own agents, and the
 * workspace does not govern Oxagen's. The assembler still runs, with no
 * candidate, so the run records a manifest that names no item and the prompt
 * is the baseline alone, byte for byte.
 */
export function noWorkspaceSteering(scope: {
  orgId: string;
  workspaceId: string;
}): AssistantSteering {
  return assembleAssistantSteering({
    ...scope,
    records: [],
    promptConfig: null,
  });
}

/**
 * The system prompt the engine receives: the governance baseline, then the
 * assembled steering under its own heading. With nothing included, the
 * baseline alone, byte for byte.
 *
 * `resolvePrompt` (@oxagen/ai) is not in this path. `chat.system` is
 * append-only, and the only thing `resolvePrompt` appends to it is the raw
 * instructions, which reach the prompt through the assembler instead.
 */
export function assistantSystemPrompt(
  baseline: string,
  steering: Pick<AssistantSteering, "text">,
): string {
  const section = steeringSection(steering);
  return section === null ? baseline : `${baseline}${section}`;
}

/**
 * The text `assistantSystemPrompt` appends for the steering, its heading
 * included, or null when there is none. The run's window counts exactly
 * these characters as steering and the rest of the system prompt as system
 * (ADR-200).
 */
export function steeringSection(
  steering: Pick<AssistantSteering, "text">,
): string | null {
  return steering.text === null ? null : `${STEERING_SECTION}${steering.text}`;
}
