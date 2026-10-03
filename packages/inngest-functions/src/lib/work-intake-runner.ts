// work-intake-runner.ts: the seam between the durable work intake jobs
// (functions/work.intake.ts) and the code that reads providers and writes the
// work records (lane P1-03, #5103).
//
// The intake code lives in `@oxagen/handlers` (lib/work-intake), which depends
// on this package, so this package cannot import it. The handlers' register
// module installs the runner when the API process boots, before the Inngest
// route can invoke a function. Every value that crosses the seam is plain
// JSON, so a durable step can return it.

/** The org and workspace a job acts in. */
export interface WorkIntakeScope {
  orgId: string;
  workspaceId: string;
}

/** One provider item a stored delivery names. */
export interface WorkIntakeRef {
  providerId: string;
  kind?: string;
}

/** A work item that is new, or whose subject, description, or labels changed. */
export interface WorkIntakeChange {
  /** The `wi_` public id. */
  publicId: string;
  change: "new" | "updated";
  /** A short digest of what changed, so a repeat sends the same event id. */
  digest: string;
  /** The item revision the change left the item on. Absent when the store did not say. */
  revision?: number;
}

/** What the event of a failed triage run said about the item. */
export interface WorkTriageFailedRun {
  /** The item revision the event was about. Absent on an event sent before events carried it. */
  revision?: number;
  /** True when a person asked for the run (retry_work_triage). */
  retry: boolean;
}

/** What opening a stored delivery found. */
export type WorkDeliveryOpened =
  | { kind: "ready"; collectorId: string; refs: WorkIntakeRef[] }
  /** Nothing to fetch: the event is gone, done, paused, or closed with a reason. */
  | { kind: "skipped"; reason: string };

/** One page of a reconcile. */
export type WorkReconcilePage =
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string }
  | { kind: "page"; handled: number; missed: number; changes: WorkIntakeChange[]; hasMore: boolean };

/** A whole reconcile, as the result row records it. */
export interface WorkReconcileSummary {
  ok: boolean;
  pages: number;
  handled: number;
  missed: number;
  error?: string;
}

/** One collector a sweep checks. */
export interface WorkCollectorTarget extends WorkIntakeScope {
  collectorId: string;
}

/** What one triage run did. */
export type WorkTriageOutcome =
  | { kind: "recorded"; decision: string; outcome: string }
  /**
   * `retryable` when the cause is Oxagen's and passes on its own, such as the
   * platform's provider balance running out (#5408). The job runs triage again.
   */
  | { kind: "failed"; reason: string; retryable?: true }
  | { kind: "skipped"; reason: string };

export interface WorkIntakeRunner {
  /** Read a stored delivery and the item refs its doorbell names. */
  openDelivery(scope: WorkIntakeScope, inboundEventId: string): Promise<WorkDeliveryOpened>;
  /** Fetch one item and store it. Null when nothing changed. A fetch error throws, so the step retries. */
  collectRef(scope: WorkIntakeScope, collectorId: string, ref: WorkIntakeRef): Promise<WorkIntakeChange | null>;
  /** Mark a ready delivery collected. */
  closeDelivery(scope: WorkIntakeScope, inboundEventId: string): Promise<void>;
  /** Every collector that is not paused, in every workspace. */
  collectorTargets(): Promise<WorkCollectorTarget[]>;
  /** Read one page of changes since the cursor. The cursor moves only after the page is stored. */
  reconcilePage(scope: WorkIntakeScope, collectorId: string, force: boolean): Promise<WorkReconcilePage>;
  /** Store the reconcile's result row and set the collector's health. */
  finishReconcile(scope: WorkIntakeScope, collectorId: string, summary: WorkReconcileSummary): Promise<{ health: string } | null>;
  /** Compare the provider's open items with Oxagen's, and set the health. */
  count(scope: WorkIntakeScope, collectorId: string): Promise<{ outcome: string } | null>;
  /** Draft one triage suggestion for a work item. A model or store error throws, so the step retries. */
  triage(scope: WorkIntakeScope, itemPublicId: string, retry: boolean): Promise<WorkTriageOutcome>;
  /**
   * Record that triage could not run at all, after its retries ran out. It
   * records nothing when the item moved past the run's revision, or when
   * triage already recorded a result on the current revision and the run was
   * not a person's retry.
   */
  recordTriageFailure(scope: WorkIntakeScope, itemPublicId: string, reason: string, run: WorkTriageFailedRun): Promise<void>;
  /** Delete stored deliveries and result rows past the retention window. Returns how many. */
  prune(now: Date): Promise<number>;
}

let runner: WorkIntakeRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setWorkIntakeRunner(next: WorkIntakeRunner | null): void {
  runner = next;
}

/** The installed runner. It throws in a process that booted without handlers. */
export function workIntakeRunner(): WorkIntakeRunner {
  if (!runner)
    throw new Error(
      "[work.intake] no intake runner is installed. Import @oxagen/handlers/register before serving Inngest functions.",
    );
  return runner;
}
