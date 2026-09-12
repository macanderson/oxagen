import { z } from "zod";
import { defineTool } from "./_define";
import { privacyDataErase } from "../privacy.data.erase";

/**
 * Appendix E: `erase_data` — "crypto-shred". Absorbs `erase_data`.
 *
 * A clean 1:1 carry of the fields, with the Does column pinning down the
 * mechanism the v1 contract left open. §13.5: bodies attributable to a natural
 * person are encrypted under a per-subject data key, and erasure destroys that
 * key, writes a tombstone frame carrying the digests that remain, and leaves
 * the hash chain intact and verifiable. The content becomes unrecoverable; the
 * ledger does not develop a hole.
 *
 * That is why `method` is in the output as a literal rather than left implicit.
 * §13.4 puts every body in a write-once bucket with an object lock running in
 * compliance mode, which no one — "not even an admin" — can lift early. A
 * handler that tried to satisfy this contract by deleting rows would fail
 * against the lock, and a contract that does not say which mechanism it means
 * invites exactly that attempt.
 *
 * Unlike `export_data`, the `user` scope carries. §13.5 is a subject-level
 * mechanism — the per-subject key is the unit of erasure — and Appendix E's
 * "crypto-shred" names it. The org scope stays for offboarding.
 */

export const eraseData = defineTool({
  name: "erase_data",
  domain: "audit",
  description:
    "Erase personal or organizational data by crypto-shredding: destroy the per-subject data key so the bodies can never be read again, revoke sessions immediately, and write a tombstone frame carrying the digests that remain, leaving the hash chain intact and verifiable (§13.5). Requires explicit confirmation. Blocked by any legal hold covering the scope.",
  // Carried: sessions are revoked in the request, the hard-delete is scheduled.
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["erase_data"],
  // Clean 1:1 carry — every field of the absorbed contract is carried.
  drops: [],

  /**
   * Carried unchanged, and nothing here should be softened. `sensitivity:
   * "destructive"` and `requiresApproval: true` are the strongest values the
   * classification has, which is right for the one operation in the system that
   * is designed to be irreversible: §13.5's whole point is that the content is
   * unrecoverable afterwards.
   */
  agent: { requiresApproval: true, riskLevel: "high", category: "privacy" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    /**
     * Carried: Owner only, deliberately not Admin — org-scope erasure is too
     * destructive for a delegated role. User-scope erasure of one's own account
     * is reachable by any authenticated user through the same contract, which
     * is why the org map is not the whole access story.
     */
    org: { Owner: "allow" },
    workspace: {},
  },
  // Destroys a key, revokes every active session, and writes the erasure
  // request and the tombstone. The v1 handler does the first two in one
  // transaction, then emits the webhook event.
  mutates: true,

  input: z
    .object({
      // Carried: "user" = the caller's own account and data; "org" = full
      // organization offboarding (Owner only).
      scope: privacyDataErase.input.shape.scope,
      // Carried optional — it is meaningless for the user scope — with the
      // conditional rule promoted from a doc comment to the refine below.
      orgId: privacyDataErase.input.shape.orgId,
      /**
       * Carried: must be literally `true`. The gate is in the schema rather
       * than in the handler so that every surface enforces it identically, and
       * so an agent cannot reach an irreversible operation by omitting a field.
       */
      confirm: privacyDataErase.input.shape.confirm,
    })
    /**
     * v1 documented "required when scope = 'org'" and enforced it in the
     * handler. For an irreversible operation the check belongs in the contract:
     * an org erasure that does not name the org is the request you least want
     * resolved from ambient context.
     */
    .refine((v) => v.scope !== "org" || v.orgId != null, {
      message: "orgId is required for scope 'org'",
      path: ["orgId"],
    }),

  output: z.object({
    // Carried: the request handle, its state, and when the hard-delete runs.
    requestId: privacyDataErase.output.shape.requestId,
    /**
     * Carried as a literal. A legal hold covering the scope does not produce a
     * different status here — §13.4 says holds "block erasure", so the call is
     * refused rather than returning a queued request that will never run.
     */
    status: privacyDataErase.output.shape.status,
    effectiveAt: privacyDataErase.output.shape.effectiveAt,

    /**
     * §13.5, new. Stated in the contract because the mechanism is the
     * guarantee: key destruction, not row deletion. §13.4's object lock runs in
     * compliance mode and cannot be lifted early even by an admin, so deletion
     * was never an available implementation — saying so here keeps a future
     * handler from discovering it the hard way.
     */
    method: z.literal("crypto_shred"),
  }),
});

export type EraseDataInput = z.output<typeof eraseData.input>;
export type EraseDataOutput = z.output<typeof eraseData.output>;
