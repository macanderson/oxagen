/**
 * The in-app assistant's steering, assembled by the one assembler and
 * recorded on the turn's run (ADR-093 §7 as amended on 2026-09-25, #4158).
 *
 * Two sources are candidates:
 *
 *  - the workspace's published context records, read by the same function
 *    that builds a wrapped agent's policy bundle
 *    (`readPublishedSteeringCandidates`, `published-steering.ts`), so a record
 *    reads the same in both places;
 *  - the workspace's instructions (`prompt_config.additionalInstructions`),
 *    as one item of kind `instruction` (ADR-093 §3).
 *
 * `@oxagen/steering-assembler` ranks them by tier and then by recency, fits
 * them to `ASSISTANT_STEERING_BUDGET_TOKENS`, and returns the text and a
 * manifest naming every candidate as included or cut, with the reason. The
 * text goes into the system prompt after the governance baseline. The
 * manifest goes onto the run as a `steering.manifest` frame before the engine
 * is asked anything (`AssistantRunRecorder.steeringManifest`).
 *
 * This replaces the interim check for #3303, which refused instructions past
 * 8,000 characters whole and stated their precedence in a note. The budget
 * now covers records and instructions together, a cut is named in the
 * manifest instead of a refusal, and the ranking states the precedence: a
 * published MUST record ranks above the instructions, which carry SHOULD.
 *
 * Recalled memory still reaches the turn apart from this, as a context
 * message capped by `RECALL_LIMIT` (`assistant-recall.ts`). Moving it into
 * the assembler is the memory adapter #3296 describes.
 */
import type { PromptConfig } from "@oxagen/ai";
import { withTenantDb } from "@oxagen/database";
import { digestJcs } from "@oxagen/run-evidence";
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
  PREFIX_FORCES,
  type SteeringCandidate,
  type SteeringItemKind,
  type SteeringManifest,
} from "@oxagen/steering-assembler";
import pino from "pino";
import {
  readPublishedSteeringCandidates,
  type SteeringTx,
} from "./published-steering";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.assistant-steering" },
});

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
 * Read the workspace's published records and assemble the turn's steering.
 * Must run inside the turn's tenant scope.
 *
 * A failed read does not refuse the turn. Steering is advice the model
 * reads. The gates that refuse an action run in the kernel whatever the
 * prompt says (ADR-097 §2). So the turn runs on the instructions alone, and
 * the manifest frame names `record` as unavailable. The record then never
 * reads "the workspace published nothing" when the registry did not answer
 * (ADR-051).
 */
export async function loadAssistantSteering(input: {
  orgId: string;
  workspaceId: string;
  promptConfig: PromptConfig | null | undefined;
  requestId?: string | null;
}): Promise<AssistantSteering> {
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId };
  const unavailableKinds: SteeringItemKind[] = [];
  let records: SteeringCandidate[] = [];
  try {
    records = await withTenantDb((tx) =>
      readPublishedSteeringCandidates(
        tx as unknown as SteeringTx,
        input.orgId,
        input.workspaceId,
      ),
    );
  } catch (err) {
    unavailableKinds.push("record");
    logger.warn(
      { err, ...scope, requestId: input.requestId },
      "published steering could not be read, so this turn carries none",
    );
  }
  const steering = assembleAssistantSteering({
    ...scope,
    records,
    promptConfig: input.promptConfig,
    unavailableKinds,
  });
  const overBudget = steering.manifest.items
    .filter((item) => item.reason === "budget")
    .map((item) => item.id);
  if (overBudget.length > 0) {
    logger.warn(
      {
        ...scope,
        requestId: input.requestId,
        budgetTokens: steering.manifest.budget_tokens,
        cut: overBudget,
      },
      "steering past the turn's budget was cut, and the run's manifest names each item",
    );
  }
  return steering;
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
  return steering.text === null
    ? baseline
    : `${baseline}${STEERING_SECTION}${steering.text}`;
}
