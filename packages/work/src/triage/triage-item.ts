// triage-item.ts: one triage decision on one work item.
//
// triageItem is the only function in this package that calls a model. It reads
// the work item, the priorities record, the workspace's open work, and the code
// repositories' file trees, and returns a triage/v1 decision. agent-work-spec.html
// (Triage) sets the rules:
//
// - The item's title and body are data. The prompt quotes them and never follows them.
// - Output that fails the triage/v1 schema is rejected and retried once.
// - The caller binds the model client to a route: the first route in work.toml
//   that no build stage of the workflow pins, so the drafting model never builds.
// - The caller stores what the client reports beside the output: the model the
//   gateway recorded, the prompt digest, and the cost. The priorities hash and the
//   input digest come from the input.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { notBuiltAsync } from "../not-built";
import type { PriorityLabel, TriageDecision, Workflow } from "../types";

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
  /** The model route the gateway recorded. */
  model: string;
  costUsd: number;
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
  /**
   * The workspace's workflows, keyed by slug. A decision names one of these slugs
   * or null. The Shared contract's list of inputs leaves this out; see the C0 PR.
   */
  workflows: Readonly<Record<string, Workflow>>;
  model: TriageModelClient;
}

/** Triage one work item. Calls the model once, or twice when the first output fails the schema. */
export function triageItem(input: TriageInput): Promise<TriageDecision> {
  return notBuiltAsync("triageItem", input);
}
