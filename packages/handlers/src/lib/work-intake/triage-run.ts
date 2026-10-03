// triage-run.ts: one triage run on one work item (P1-03, #5103;
// agent-work-phase-1.html, Work lifecycle).
//
// 1. Read the item, its state, and the workspace's priorities record and open
//    work in one tenant transaction. Triage runs only while the item is new,
//    held, triaged, needs_info, or changed, while its source is not closed,
//    and once per item revision unless a person asks for a retry.
// 2. With no single priorities record, record a triage_failed fact that says
//    what to fix, and stop.
// 3. Outside the transaction, read the file tree of the item's repository and
//    ask the model. triageItem quotes every outside string as data and asks
//    once more after an invalid answer. A second invalid answer is recorded as
//    triage_failed, so the item stays visible as needing attention.
// 4. In a second transaction, store the decision and append a triage_recorded
//    fact on the revision triage read. When the item moved to a newer
//    revision meanwhile, nothing is stored: the change that moved it sends
//    work/item.received again, and that run triages the newer text.
//
// A model or store error throws, so the durable step retries. When its retries
// run out, the job's on-failure companion calls recordTriageFailure with the
// revision the event was about. A failure that lands late records nothing.
//
// One model error does not throw: Oxagen's own provider account running out
// of balance (#5408). The run records it once, in words that say whose
// balance it is, and answers `retryable`, so the job waits and runs triage
// again. That failure does not count as triage having run on the revision.
import {
  CREDIT_REASONS,
  PLATFORM_PROVIDER_BALANCE_CODE,
  generateObjectFor,
  isPlatformProviderBalanceError,
  isSpendRefusal,
  modelIdOf,
  selectModelForOrg,
} from "@oxagen/ai";
import { assertUnderWorkspaceLaneBudget } from "@oxagen/billing";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  type TriageDecision,
  type TriageFileTree,
  type TriageModelClient,
  type TriageOpenItem,
  type TriageWorkItem,
  TriageOutputError,
  triageInputDigest,
  triageItem,
  triagePromptDigest,
  triageRequest,
} from "@oxagen/work";
import { type WorkFact, type WorkItemState, reduceWorkItem } from "@oxagen/work/records";
import { and, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { isOutputParseError } from "../model-output-errors";
import { appendFacts, readWorkItem, type WorkScope } from "../work-records/store";
import { type PrioritiesRecord, prioritiesProblem, readPriorities } from "./priorities";
import { screenValue } from "./screen";
import { insertDecision } from "./triage-store";

const items = schema.workItems;
const collectors = schema.workCollectors;

/** The states in which triage may update its suggestion (agent-work-phase-1.html, Work lifecycle). */
export const TRIAGE_STATES_OPEN: readonly WorkItemState[] = ["new", "held", "triaged", "needs_info", "changed"];

/** The most open items triage compares an item against. */
export const TRIAGE_OPEN_WORK_LIMIT = 100;

/** The longest failure reason a fact stores. */
const MAX_REASON = 1900;

/**
 * What a work item says while Oxagen's own provider balance is out (#5408).
 * The item's job runs triage again on its own, so the person need do nothing.
 */
export const PROVIDER_BALANCE_REASON =
  "Triage could not run: Oxagen's account with its model provider is out of balance. This is Oxagen's to fix, and your organization's credits are not affected. Triage runs again on its own every hour for a day, or you can set the priority yourself.";

/**
 * The provider's words when the organization's own key has no balance left.
 * The key is the organization's, so the text names it and keeps what the
 * provider said, which tells the person where to add credit.
 */
export function orgKeyBalanceMessage(providerText: string): string {
  const said = providerText.trim().slice(0, 300).replace(/[\s.]+$/, "");
  return `The model provider refused your organization's own model key for lack of balance. Add credit to the provider account behind that key. The provider said: ${said || "nothing"}`;
}

/** The provider's spend refusal on an error, or on the last attempt the AI SDK wrapped. */
function spendRefusalOf(error: unknown) {
  if (isSpendRefusal(error)) return error;
  if (typeof error === "object" && error !== null && "lastError" in error && isSpendRefusal(error.lastError)) {
    return error.lastError;
  }
  return null;
}

/** The structured output the model is asked for. Loose on purpose: checkTriageSchema names each real problem. */
export const triageOutputSchema = z.object({
  schema: z.string(),
  item: z.string(),
  state: z.string(),
  priority: z.object({ label: z.string(), reason: z.string(), cites: z.array(z.string()) }),
  labels: z.array(z.string()),
  estimate_minutes: z.number(),
  claims: z.array(z.string()),
  duplicates: z.array(z.string()),
  related: z.array(z.string()),
  workflow: z.string().nullable(),
  done_record: z.object({ criteria: z.array(z.string()) }).nullable(),
  questions: z.array(z.string()),
  conflicts: z.array(z.string()),
});

/** The model client triage runs with: the workspace's fast model through @oxagen/ai, charged as in-app assistant spend. */
export function aiTriageModelClient(scope: WorkScope): TriageModelClient {
  return {
    async complete(request) {
      // The workspace's own daily budget for work orders (#5426). A refusal
      // throws, so the durable step records it on the item with the reason
      // the person can read.
      await assertUnderWorkspaceLaneBudget({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        lane: "work",
      });
      const selection = await selectModelForOrg(scope.orgId, { tier: "fast" });
      const model = modelIdOf(selection.model);
      try {
        const { object } = await generateObjectFor({
          ...selection,
          chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
          schema: triageOutputSchema,
          system: request.system,
          prompt: request.prompt,
          temperature: 0,
          maxOutputTokens: 4096,
          // The durable step owns retries, and triageItem owns the one retry
          // after an invalid answer.
          maxRetries: 0,
          telemetry: {
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            surface: "runner",
            messageId: null,
            // Names the lane on the usage row (#5426).
            capabilityName: "work_triage",
          },
        });
        // @oxagen/ai records the cost on the usage row. It does not return it,
        // so the decision's cost stays unknown rather than 0.
        return { output: object, model, costUsd: null };
      } catch (error) {
        if (isOutputParseError(error)) return { output: null, model, costUsd: null };
        // A 402 on the organization's own key is the organization's account
        // (#5408). Oxagen's shared key reaches here already named, as
        // PlatformProviderBalanceError (@oxagen/ai).
        const refusal = selection.fundedBy === "org" ? spendRefusalOf(error) : null;
        if (refusal !== null) throw new Error(orgKeyBalanceMessage(refusal.message), { cause: error });
        throw error;
      }
    },
  };
}

/** What a triage run needs besides the database. Tests pass fakes. */
export interface TriageRunDeps {
  model(scope: WorkScope): TriageModelClient;
  /** The file trees of the item's repository. Empty when there is none or it cannot be read. */
  fileTrees(scope: WorkScope, item: { repository: string | null; collectorId: string | null }): Promise<TriageFileTree[]>;
  now(): Date;
}

export type TriageRunResult =
  | { kind: "recorded"; decision: string; outcome: string }
  /** `retryable` when the cause is Oxagen's and passes on its own, so the job runs triage again later. */
  | { kind: "failed"; reason: string; retryable?: true }
  | { kind: "skipped"; reason: string };

interface TriageRead {
  itemId: string;
  revision: number;
  workItem: TriageWorkItem;
  repository: string | null;
  collectorId: string | null;
  priorities: PrioritiesRecord | null;
  problem: string | null;
  openWork: TriageOpenItem[];
  /** True when the revision's latest triage fact already says Oxagen's provider balance is out. */
  waitingOnBalance: boolean;
}

async function readItemRow(tx: Tx, scope: WorkScope, publicId: string) {
  const [row] = await tx
    .select({
      id: items.id,
      publicId: items.publicId,
      subject: items.subject,
      description: items.description,
      labels: items.labels,
      requester: items.requester,
      sourceUrl: items.sourceUrl,
      sourceRepository: items.sourceRepository,
      collectorId: items.collectorId,
      origin: items.origin,
      statusCategory: items.statusCategory,
      deletedAt: items.deletedAt,
    })
    .from(items)
    .where(and(eq(items.publicId, publicId), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ?? null;
}

async function collectorName(tx: Tx, scope: WorkScope, collectorId: string | null, origin: string): Promise<string> {
  if (collectorId === null) return origin === "manual" ? "manual entry" : origin;
  const [row] = await tx
    .select({ name: collectors.name })
    .from(collectors)
    .where(and(eq(collectors.id, collectorId), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
    .limit(1);
  return row?.name ?? "collector";
}

async function openWork(tx: Tx, scope: WorkScope, itemId: string): Promise<TriageOpenItem[]> {
  const rows = await tx
    .select({
      publicId: items.publicId,
      subject: items.subject,
      labels: items.labels,
      priority: items.priority,
      planning: items.planningPriority,
    })
    .from(items)
    .where(
      and(
        eq(items.orgId, scope.orgId),
        eq(items.workspaceId, scope.workspaceId),
        ne(items.id, itemId),
        isNull(items.deletedAt),
        notInArray(items.state, ["done", "closed"]),
        // An item its provider closed is not open work to compare against.
        ne(items.statusCategory, "closed"),
      ),
    )
    .orderBy(desc(items.updatedAt))
    .limit(TRIAGE_OPEN_WORK_LIMIT);
  return rows.map((row) => ({
    id: row.publicId as TriageOpenItem["id"],
    title: row.subject,
    labels: [...row.labels],
    priority: (row.planning?.label ?? row.priority ?? null) as TriageOpenItem["priority"],
    claims: [],
  }));
}

/** The latest triage result or failure on this revision. */
function latestTriage(facts: readonly WorkFact[], revision: number): WorkFact | undefined {
  return facts.filter((fact) => (fact.kind === "triage_recorded" || fact.kind === "triage_failed") && fact.itemRevision === revision).at(-1);
}

/** True for a failure that says Oxagen's own provider balance was out (#5408). */
function isBalanceFailure(fact: WorkFact | undefined): boolean {
  return fact?.kind === "triage_failed" && fact.data.code === PLATFORM_PROVIDER_BALANCE_CODE;
}

/**
 * True when triage already ran on this revision: its latest triage fact is a
 * result or a failure. A failure because Oxagen's provider balance was out
 * does not count, so the run that waits for the balance triages the item.
 */
function triagedAt(facts: readonly WorkFact[], revision: number): boolean {
  const latest = latestTriage(facts, revision);
  return latest !== undefined && !isBalanceFailure(latest);
}

/** Append a triage_failed fact on the item's current revision. */
async function appendFailure(
  tx: Tx,
  scope: WorkScope,
  itemId: string,
  revision: number,
  reason: string,
  at: string,
  code?: string,
): Promise<void> {
  await appendFacts(tx, scope, {
    itemId,
    facts: [
      {
        kind: "triage_failed",
        source: "oxagen",
        itemRevision: revision,
        actor: "triage",
        occurredAt: at,
        dedupeKey: `triage_failed:${at}`,
        data: { reason: reason.slice(0, MAX_REASON), ...(code === undefined ? {} : { code }) },
      },
    ],
  });
}

/** Run triage once on one item. */
export async function runTriage(deps: TriageRunDeps, scope: WorkScope, itemPublicId: string, retry: boolean): Promise<TriageRunResult> {
  const read = await withTenantDb(async (tx): Promise<TriageRead | TriageRunResult> => {
    const row = await readItemRow(tx, scope, itemPublicId);
    if (row === null) return { kind: "skipped", reason: "This workspace has no such work item." };
    if (row.deletedAt !== null) return { kind: "skipped", reason: "The work item is deleted." };
    // A closed source issue does not establish work, and triaging it would
    // spend a model call on history (agent-work-phase-1.html, Work lifecycle).
    if (row.statusCategory === "closed") return { kind: "skipped", reason: "The source item is closed, so triage leaves it alone." };
    const record = await readWorkItem(tx, scope, row.id);
    const { state, revision } = record.projection;
    if (!TRIAGE_STATES_OPEN.includes(state)) return { kind: "skipped", reason: `The work item is ${state}, so triage leaves it alone.` };
    if (!retry && triagedAt(record.facts, revision)) {
      return { kind: "skipped", reason: `Triage already ran on revision ${revision}.` };
    }
    const priorities = await readPriorities(tx, scope);
    const screened = screenValue({
      title: row.subject,
      body: row.description ?? "",
      labels: [...row.labels],
      requester: row.requester,
    }).value;
    const workItem: TriageWorkItem = {
      id: row.publicId as TriageWorkItem["id"],
      collector: await collectorName(tx, scope, row.collectorId, row.origin),
      title: screened.title,
      body: screened.body,
      labels: screened.labels,
      ...(screened.requester ? { requester: screened.requester } : {}),
      ...(row.sourceUrl ? { url: row.sourceUrl } : {}),
    };
    return {
      itemId: row.id,
      revision,
      workItem,
      repository: row.sourceRepository,
      collectorId: row.collectorId,
      priorities: priorities.kind === "found" ? priorities.record : null,
      problem: priorities.kind === "found" ? null : prioritiesProblem(priorities),
      openWork: await openWork(tx, scope, row.id),
      waitingOnBalance: isBalanceFailure(latestTriage(record.facts, revision)),
    };
  });
  if ("kind" in read) return read;

  if (read.priorities === null) {
    const reason = read.problem as string;
    await withTenantDb((tx) => appendFailure(tx, scope, read.itemId, read.revision, reason, deps.now().toISOString()));
    return { kind: "failed", reason };
  }

  const fileTrees = await deps.fileTrees(scope, { repository: read.repository, collectorId: read.collectorId });
  const priorities = { lineage: read.priorities.lineage, hash: read.priorities.hash, body: read.priorities.body };
  const input = { item: read.workItem, priorities, openWork: read.openWork, fileTrees };
  const client = deps.model(scope);
  let calledModel: string | null = null;
  const recordingClient: TriageModelClient = {
    async complete(request) {
      const response = await client.complete(request);
      calledModel = response.model;
      return response;
    },
  };

  let decision: TriageDecision;
  try {
    decision = await triageItem({ ...input, model: recordingClient });
  } catch (error) {
    if (isPlatformProviderBalanceError(error)) {
      // Oxagen's provider account is out (#5408). Say so once per revision,
      // and let the job run triage again: a retry inside the durable step
      // would fail the same way, and a terminal failure would leave the item
      // waiting on a person for something Oxagen fixes.
      if (!read.waitingOnBalance) {
        await withTenantDb((tx) =>
          appendFailure(tx, scope, read.itemId, read.revision, PROVIDER_BALANCE_REASON, deps.now().toISOString(), PLATFORM_PROVIDER_BALANCE_CODE),
        );
      }
      return { kind: "failed", reason: PROVIDER_BALANCE_REASON, retryable: true };
    }
    if (!(error instanceof TriageOutputError)) throw error;
    const reason = `Triage returned no valid suggestion after ${error.attempts.length} tries. ${error.attempts
      .map((problems, index) => `Try ${index + 1}: ${problems.slice(0, 3).join("; ") || "no detail"}.`)
      .join(" ")} Retry triage, or set the priority yourself.`;
    await withTenantDb((tx) => appendFailure(tx, scope, read.itemId, read.revision, reason, deps.now().toISOString()));
    return { kind: "failed", reason: reason.slice(0, MAX_REASON) };
  }

  const request = triageRequest(input);
  return withTenantDb(async (tx): Promise<TriageRunResult> => {
    // Hold the item's row, so no source change can commit between the
    // revision check and the decision this run stores against it.
    await tx.select({ id: items.id }).from(items).where(eq(items.id, read.itemId)).for("update");
    const record = await readWorkItem(tx, scope, read.itemId);
    const current = reduceWorkItem(record.facts);
    if (current.revision !== read.revision) {
      return { kind: "skipped", reason: `The work item moved to revision ${current.revision} while triage read revision ${read.revision}.` };
    }
    const stored = await insertDecision(tx, scope, {
      itemId: read.itemId,
      output: decision,
      model: calledModel,
      promptDigest: triagePromptDigest(request),
      prioritiesHash: read.priorities!.hash,
      inputDigest: triageInputDigest(input),
      costUsd: null,
      itemRevision: read.revision,
    });
    await appendFacts(tx, scope, {
      itemId: read.itemId,
      facts: [
        {
          kind: "triage_recorded",
          source: "oxagen",
          itemRevision: read.revision,
          actor: "triage",
          occurredAt: deps.now().toISOString(),
          dedupeKey: `triage_recorded:${stored.publicId}`,
          data: {
            decision: stored.publicId,
            outcome: decision.state,
            duplicate_of: decision.state === "duplicate" ? (decision.duplicates[0] ?? null) : null,
          },
        },
      ],
    });
    return { kind: "recorded", decision: stored.publicId, outcome: decision.state };
  });
}

/** What the event of a failed triage run said about the item. */
export interface TriageFailedRun {
  /** The item revision the event was about. Absent on an event sent before events carried it. */
  revision?: number;
  /** True when a person asked for the run. */
  retry?: boolean;
}

/**
 * Record that triage could not run, after the durable retries ran out, on the
 * item's current revision. It records nothing for an unknown or deleted item,
 * or one past triage. It also records nothing for a failure that lands late:
 *
 * - The event was about a revision the item has moved past. A source change
 *   that moved it sent its own work/item.received, and that run triages the
 *   newer text. A failure recorded there would make that run skip.
 * - Triage already recorded a result or a failure on the current revision,
 *   such as a person's retry that finished first. A person's own retry is the
 *   exception: it ran past the earlier result on purpose, and its failure
 *   moves the item's version, so the next retry is not dropped as a repeat.
 */
export async function recordTriageFailure(
  scope: WorkScope,
  itemPublicId: string,
  reason: string,
  now: Date,
  run: TriageFailedRun = {},
): Promise<void> {
  await withTenantDb(async (tx) => {
    const row = await readItemRow(tx, scope, itemPublicId);
    if (row === null || row.deletedAt !== null) return;
    // Hold the item's row, so no triage run or source change commits between
    // the checks below and the failure this records.
    await tx.select({ id: items.id }).from(items).where(eq(items.id, row.id)).for("update");
    const record = await readWorkItem(tx, scope, row.id);
    const { state, revision } = record.projection;
    if (!TRIAGE_STATES_OPEN.includes(state)) return;
    if (run.revision !== undefined && run.revision !== revision) return;
    if (run.retry !== true && triagedAt(record.facts, revision)) return;
    await appendFailure(tx, scope, row.id, revision, reason, now.toISOString());
  });
}
