/**
 * send_work_order: a person sends a work item's approved brief to one agent
 * they operate. Oxagen reads the agent's runtime, its enrolled host, its
 * mandate, and the runtime's tier on the server, opens one work order, and
 * queues it to the host as a `work_order` command. The host keeps it until it
 * claims the order, and only then does a run start. The key names the brief
 * revision and the send, so a retry with the same key returns the same work
 * order and the same command, and starts no second run. The database holds one
 * open send per item and one unreleased send per agent. In a regulated
 * workspace the person who approved the brief cannot send it. A person decides
 * it, signed in to Oxagen: an API key or an agent run is refused, so an agent
 * cannot decide its own work. The action names the item version the person
 * read, and the store refuses it when the item changed since (ADR-244,
 * ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workAgentIdSchema, workDigestSchema, workItemIdSchema, workItemVersionSchema, workOrderAfterSchema, workRevisionSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderSend = registerCapability({
  name: "send_work_order",
  domain: "work",
  description:
    "Send a work item's approved brief to an agent you operate. The agent's runtime claims the work order before any run starts.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  audit: { targetKind: "work_item", targetIdField: "item_id" },
  input: z
    .object({
      item_id: workItemIdSchema,
      /** The item version the person read. */
      version: workItemVersionSchema,
      item_revision: workRevisionSchema,
      brief_revision: workRevisionSchema,
      brief_digest: workDigestSchema,
      agent_id: workAgentIdSchema,
      /** `<item>:r<brief revision>:s<send>`, fixed before the first try. A retry sends the same key. */
      key: z.string().regex(/^wi_[0-9a-z]+:r[1-9][0-9]*:s[1-9][0-9]*$/),
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
      /** The `work_order` command queued to the host (`tcm_…`). */
      command_id: z.string(),
      target: z
        .object({
          agent_id: workAgentIdSchema,
          runtime_id: z.string(),
          host_id: z.string(),
          runtime_tier: z.enum(["contained", "gateway", "harness", "observe"]),
          /** The agent's mandate at send, or null when it has none. The work item adds no authority. */
          mandate_id: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
});

export type WorkOrderSendInput = z.input<typeof workOrderSend.input>;
export type WorkOrderSendOutput = z.output<typeof workOrderSend.output>;
