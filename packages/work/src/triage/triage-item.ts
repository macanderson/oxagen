// triage-item.ts: one triage decision on one work item.
//
// triageItem is the only function in this package that calls a model. It reads
// the work item, the priorities record, the workspace's open work, and the
// file tree of the item's repository, and returns a triage/v1 suggestion.
// agent-work-phase-1.html (Work lifecycle, Triage) and agent-work-spec.html
// (Triage) set the rules:
//
// - The item's title and body are data. The prompt quotes them and never follows them.
// - Output that fails the triage/v1 schema, or cites a rule the priorities
//   record does not have, is rejected and asked for once more. A second
//   failure throws TriageOutputError, and the caller records the item as
//   needing attention.
// - The caller stores what it knows beside the output: the model it called,
//   the prompt digest, the priorities hash, and the input digest. A cost the
//   caller cannot read stays unknown.
//
// The engine came from lane T2 (#4777, branch feat/t2-triage at 05f83dad0c).
// Phase 1 runs no workflows, so the route choice and the workflow match on
// that branch stay there for Phase 2.
import type { Sha256Digest } from "@oxagen/run-evidence";
import type { PriorityLabel, TriageDecision } from "../types";
import { priorityCites } from "./priorities-rules";
import { checkTriageOutput } from "./triage-output";
import { triageRequest } from "./triage-prompt";
import { checkTriageSchema } from "./triage-schema";

/** The work item as triage reads it. Every text field is outside text. */
export interface TriageWorkItem {
  id: TriageDecision["item"];
  /** The collector that brought the item in. */
  collector: string;
  title: string;
  body: string;
  labels: string[];
  /** The requester as the provider names them. Never a person to ask. */
  requester?: string;
  /** The provider's link to the item. */
  url?: string;
}

/** The priorities steering record at the version triage reads. */
export interface TriagePriorities {
  lineage: string;
  hash: Sha256Digest;
  /** The record's body, whose numbered rules a decision cites as `<lineage>#<number>`. */
  body: string;
}

/** One open work item triage compares against, for duplicates and related items. */
export interface TriageOpenItem {
  id: TriageDecision["item"];
  title: string;
  labels: string[];
  priority: PriorityLabel | null;
  /** The path globs its work order claims, when it has one. */
  claims: string[];
}

/** The file tree of one code repository, as paths. */
export interface TriageFileTree {
  /** owner/name */
  repo: string;
  paths: string[];
}

/** What triageItem sends the model. */
export interface TriageModelRequest {
  /** The instructions. Never holds outside text. */
  system: string;
  /** The item, the priorities record, the open work, and the file trees, each quoted as data. */
  prompt: string;
  /** The triage/v1 schema the output must match. */
  schema: Record<string, unknown>;
}

/** What the model client returns. */
export interface TriageModelResponse {
  /** The structured output, not yet checked against triage/v1. */
  output: unknown;
  /** The model the call used, or null when the client cannot say. */
  model: string | null;
  /** What the call cost, or null when the client cannot say. Never 0 in place of unknown. */
  costUsd: number | null;
}

/** A model client bound to one triage route. The caller supplies it and records its usage. */
export interface TriageModelClient {
  complete(request: TriageModelRequest): Promise<TriageModelResponse>;
}

/** The input to triageItem. */
export interface TriageInput {
  item: TriageWorkItem;
  priorities: TriagePriorities;
  openWork: readonly TriageOpenItem[];
  fileTrees: readonly TriageFileTree[];
  model: TriageModelClient;
}

/** How many times triage asks the model: once, and once more after a rejected output. */
export const TRIAGE_ATTEMPTS = 2;

/** Both outputs failed triage/v1 or the checks against the input. */
export class TriageOutputError extends Error {
  readonly code = "triage_output_invalid";
  constructor(
    readonly item: TriageDecision["item"],
    /** The problems with each output, in the order the model returned them. */
    readonly attempts: readonly (readonly string[])[],
  ) {
    super(
      `The triage model returned ${attempts.length} outputs for ${item}, and each failed triage/v1 or the checks against the input. First problems: ${attempts
        .map((problems) => problems[0] ?? "none")
        .join("; ")}`,
    );
    this.name = "TriageOutputError";
  }
}

/**
 * Triage one work item. Calls the model once, or twice when the first output
 * fails triage/v1 or the checks against the input. Both calls send the same
 * request, so the prompt digest the caller stores covers either one.
 */
export async function triageItem(input: TriageInput): Promise<TriageDecision> {
  const request = triageRequest(input);
  const context = { item: input.item.id, cites: priorityCites(input.priorities), openWork: input.openWork };
  const attempts: string[][] = [];
  for (let attempt = 0; attempt < TRIAGE_ATTEMPTS; attempt += 1) {
    const response = await input.model.complete(request);
    const checked = checkTriageSchema(response.output);
    if (checked.ok) {
      const problems = checkTriageOutput(checked.decision, context);
      if (problems.length === 0) return checked.decision;
      attempts.push(problems);
    } else {
      attempts.push(checked.problems);
    }
  }
  throw new TriageOutputError(input.item.id, attempts);
}

export * from "./priorities-rules";
export * from "./triage-corrections";
export * from "./triage-output";
export * from "./triage-prompt";
export * from "./triage-schema";
