/**
 * list_work_items: the workspace's work items, as the Work page's four tabs
 * show them (P1-05, #5163; agent-work-phase-1.html, Screens: Work).
 *
 * Each row is reduced from the item's facts (ADR-244) on the server: its
 * state, the word the page shows beside its dot, what it waits for, its
 * latest send with the required checks on the pull request's head, and what
 * its runs cost with the share of cost Oxagen knows. "No answer" reads the
 * send's `work_order` command and the host's last poll (ADR-251). A read
 * never calls GitHub: the checks are what Oxagen last recorded.
 *
 * The answer holds the newest `limit` items by their last change, and
 * `truncated` says when there were more. A work item grants no authority, so
 * reading one needs the workspace's read roles and nothing about the item.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemRowSchema, workViewerSchema } from "./work.read.shared";

/** The most items one read answers. */
export const WORK_ITEMS_LIST_MAX = 500;

export const workItemsList = registerCapability({
  name: "list_work_items",
  domain: "work",
  description:
    "List the workspace's work items with each one's state, what it waits for, its latest send and required checks, and what its runs cost.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(WORK_ITEMS_LIST_MAX).default(WORK_ITEMS_LIST_MAX),
    })
    .strict(),
  output: z
    .object({
      items: z.array(workItemRowSchema),
      /** More items exist than `limit` returned. */
      truncated: z.boolean(),
      viewer: workViewerSchema,
    })
    .strict(),
});

export type WorkItemsListInput = z.input<typeof workItemsList.input>;
export type WorkItemsListOutput = z.output<typeof workItemsList.output>;
