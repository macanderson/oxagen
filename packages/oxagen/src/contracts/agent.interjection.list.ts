// list_interjections: the workspace's questions an agent paused to ask a
// person, soonest expiry first, cursor-paged (#3839). An interjection is a run
// that stopped to ask. It is not a tool call waiting on approval, so it lives
// in its own table (`agent.interjections`) beside `agent.approval_requests`.
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28), so the contract declares `noBillingGate: true`, and `mutates:
// false` is what lets the app's `kernelRead` accept it (INV-03).
//
// Workspace-scoped: the shell sums it per workspace, as it sums
// `list_approvals`.
//
// A `repo_unknown` row (#3941) is raised by the host's `control.interject`
// frame, which the ingest copies onto the row verbatim as `body`. The Run
// page reads the question, the paths and the timeout from it, and the answer
// state from the rest of the row.
import {
  INTERJECTION_PATHS,
  INTERJECTION_RECEIPT_ID_PATTERN,
  interjectBodySchema,
} from "@oxagen/tacho";
import { z } from "zod";
import { registerCapability } from "../registry";

const instant = z.string().datetime({ offset: true });

/**
 * What raised the interjection. `question` is an agent asking in its own
 * words (#3839). `repo_unknown` is a host holding a session that started in
 * a repository the workspace has not bound (#3941).
 */
export const INTERJECTION_KINDS = ["question", "repo_unknown"] as const;

export const interjectionListItem = z
  .object({
    /** The interjection's public id (`inj_…`). */
    id: z.string().regex(/^inj_[0-9a-z]+$/),
    /** The public id of the run that asked (`arun_…` or `tse_…`). */
    runId: z.string().regex(/^(arun|tse)_[0-9a-z]+$/),
    /** `org_ns.ws_ns.slug` (ADR-024); null when the writer recorded none. */
    agentKey: z.string().nullable(),
    /** The question as the agent asked it. */
    question: z.string().min(1),
    raisedAt: instant,
    /** When the run stops waiting and carries on without an answer. */
    expiresAt: instant,
    /** Null while the question is open. */
    answeredAt: instant.nullable(),
    /** The answer a person gave; null while the question is open. */
    answer: z.string().nullable(),
    /** The public id (`usr_…`) of the person who answered; null while open. */
    answeredBy: z.string().nullable(),
    kind: z.enum(INTERJECTION_KINDS),
    /**
     * The `seq` of the `control.interject` frame that raised it, on the
     * run's own chain, as a decimal string. Null on a `question` row, which
     * no frame raised.
     */
    raisedSeq: z.string().regex(/^\d+$/).nullable(),
    /** The `control.interject` body as the host sealed it; null on a `question` row. */
    body: interjectBodySchema.nullable(),
    /**
     * The repository (`owner/name`) the control plane resolved from the
     * body's remote digest. Null until it is resolved, when no connected
     * repository matches, and on a `question` row.
     */
    repository: z.string().min(1).nullable(),
    /** How a `repo_unknown` row was settled; null while open and on a `question` row. */
    path: z.enum(INTERJECTION_PATHS).nullable(),
    /**
     * The receipt minted with the answer (`rcp_…`). Null while open, and on
     * a row answered before answers carried receipts.
     */
    receiptId: z.string().regex(INTERJECTION_RECEIPT_ID_PATTERN).nullable(),
  })
  .strict();

export const agentInterjectionList = registerCapability({
  name: "list_interjections",
  domain: "agent",
  description:
    "List the questions agents in this workspace paused to ask a person, soonest expiry first, cursor-paged, optionally narrowed to one run",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Only interjections raised in this run (a run public id). */
      runId: z.string().min(1).max(64).optional(),
      /**
       * True lists only the questions nobody has answered and that have not
       * expired. False lists every question, answered or not.
       */
      open: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(50),
      /** The `nextCursor` of the previous page. */
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(interjectionListItem).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type AgentInterjectionListInput = z.output<
  typeof agentInterjectionList.input
>;
export type AgentInterjectionListOutput = z.output<
  typeof agentInterjectionList.output
>;
export type InterjectionListItem = z.output<typeof interjectionListItem>;
