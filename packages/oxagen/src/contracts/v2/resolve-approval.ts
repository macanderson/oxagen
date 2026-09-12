import { z } from "zod";
import { defineTool } from "./_define";
import { agentApprovalResolve } from "../agent.approval.resolve";
import { agentMcpConsentResolve } from "../agent.mcp_consent.resolve";

/**
 * Appendix E: `resolve_approval` — "approve or deny, mints the token". Absorbs
 * `resolve_approval` and `resolve_mcp_consent`.
 *
 * **One vocabulary.** The two sources resolve with different words —
 * `approved | denied` and `granted | denied`. §7.5 knows one kind of decision:
 * a resolution mints an approval token or it does not. First-use consent for an
 * external MCP tool is an approval like any other, so `granted` is `approved`
 * and `resolve_mcp_consent`'s enum drops. Appendix A.6's
 * `control.approvals.decision` column stores exactly `approved | denied |
 * expired`, which is the carried set.
 *
 * **`grantAllTools` does not carry, and that is the interesting decision.** It
 * let one consent pre-grant every tool on a server (`tool_name = '*'`). §7.5 is
 * unambiguous about what a resolution produces: "a single-use approval token
 * bound to the agent, run, exact action, expiry, and the approval event." A
 * decision that authorizes calls nobody has seen yet is not an approval — it is
 * standing authority, and §6.9 has a name and a tool for that (a mandate,
 * granted through `grant_mandate`, bounded by a consequence tag and an amount,
 * with an entry in the mandates ledger). Folding it back in here would let a
 * one-click consent dialog mint unbounded authority with no ledger row.
 *
 * **The token is named, not handed over.** §7.5 sends the token to the adapter
 * and the gateway, which verify it offline and inline. The approver needs to
 * know a token exists, what it is bound to, and when it dies — not to hold its
 * bytes. Appendix A.6 stores `token_id`, `token_bound_digest` and
 * `token_expires_at` separately from any material for the same reason. This
 * follows `get_data_plane`'s rule in Appendix E: the binding is returned, the
 * secret never is.
 */
export const resolveApproval = defineTool({
  name: "resolve_approval",
  domain: "control",
  description:
    "Approve or deny a parked action — a tool-call approval or a first-use consent for an external tool server. Approval mints a single-use token bound to the agent, run, action and expiry; the decision resumes the paused run.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  // A parked call is a run already waiting on a human. Making the resolution
  // wait on a credit balance would strand it. Neither source gated it either.
  noBillingGate: true,

  absorbs: ["resolve_approval", "resolve_mcp_consent"],
  drops: [
    {
      field: "decision",
      from: "resolve_mcp_consent",
      why: "the value set, not the field: `granted | denied` collapses into §7.5's one resolution vocabulary, which Appendix A.6 stores as `approved | denied | expired`",
    },
    {
      field: "grantAllTools",
      from: "resolve_mcp_consent",
      why: "§7.5 mints a single-use token bound to the *exact* action. Pre-granting every tool on a server is standing authority, which §6.9 grants as a mandate through `grant_mandate` — bounded, ledgered, and revocable — not as a checkbox on a consent dialog.",
    },
    {
      field: "resolution (output)",
      from: "resolve_mcp_consent",
      why: "follows its `decision` — the carried output enum is `resolve_approval`'s `approved | denied | expired`",
    },
  ],

  // The two sources agree exactly: medium, deny, low risk, no approval (a
  // resolution that itself needed approving could not terminate), and the same
  // role grants. Nothing to reconcile.
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Writes control.approvals (decision, reason, resolved_by, token fields) and
  // resumes the parked call.
  mutates: true,

  input: z.object({
    /**
     * The parked request. Carried from `resolve_approval`; `resolve_mcp_consent`
     * used the same key for the same row, which is why the two fold at all.
     */
    approvalId: agentApprovalResolve.input.shape.approvalId,
    decision: agentApprovalResolve.input.shape.decision,
    /**
     * §7.5: "The approver's reason reaches the model as the permission decision
     * reason." Optional as in v1 — a denial that cannot be issued without prose
     * is a denial that gets delayed, and §14's chain-of-links requirement is
     * met by the approval row and its frames whether or not words were typed.
     */
    note: agentApprovalResolve.input.shape.note,
  }),

  output: z.object({
    approvalId: agentApprovalResolve.output.shape.approvalId,
    /**
     * `expired` is a real answer, not an error: §7.5 parks a call with a
     * timeout, and an operator who resolves a request the clock already
     * resolved needs to be told which of the two landed.
     */
    resolution: agentApprovalResolve.output.shape.resolution,

    /**
     * Present only on `approved`. New in v2 — neither source surfaced the token
     * at all, and §7.5 makes it the substance of the decision. The bytes are
     * deliberately absent: see the note above.
     */
    approvalToken: z
      .object({
        /** Appendix A.6 `control.approvals.token_id`. */
        tokenId: z.string().min(1),
        /** What the token is bound to — the canonical action's input digest. */
        boundDigest: z.string().min(1),
        expiresAt: z.string(),
        /** Single-use by §7.5; stated so a reader never assumes otherwise. */
        singleUse: z.literal(true),
      })
      .nullable(),
  }),
});

export type ResolveApprovalInput = z.output<typeof resolveApproval.input>;
export type ResolveApprovalOutput = z.output<typeof resolveApproval.output>;
