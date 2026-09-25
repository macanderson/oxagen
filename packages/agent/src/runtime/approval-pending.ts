/**
 * The error a governed write throws when it parks for a person's approval.
 *
 * It lives in its own module, with no imports, because two layers read it:
 * `materializeTools` throws it out of a tool's `execute`, and the engine port
 * (`engine/tools.ts`) recognises it so the turn's ledger records the call as
 * `parked` rather than `denied`. The engine port must not import the
 * materializer, which pulls in the database, the kernel, and every plugin.
 */

/**
 * A governed write the turn opened that is waiting on a person. Thrown out of
 * a tool's `execute` under `approvalMode: "park"`. The engine reads it as a
 * refusal by policy, its closed error vocabulary has no word for a wait, and
 * the surface reads the fields as the parked card.
 *
 * The message is the tool result the model reads. It names the approval by
 * its public id, the id the person sees on Fleet and on the reply's card, so
 * the model and the person name the same approval. It names the row uuid
 * only when the writer returned no public id.
 */
export class ApprovalPendingError extends Error {
  override readonly name = "ApprovalPendingError";
  readonly code = "pending_approval" as const;
  constructor(
    readonly capability: string,
    /** The approval row's id (`approval_requests.id`), which waiters key on. */
    readonly approvalId: string,
    readonly expiresAt: string,
    /**
     * The approval's public id (`apr_…`), the form Fleet and the Run page show
     * and the run's ledger records. Absent when the writer did not return one.
     */
    readonly approvalPublicId?: string,
  ) {
    super(
      `refused: ${capability} is waiting for approval ${approvalPublicId ?? approvalId} until ${expiresAt}`,
    );
  }
}
