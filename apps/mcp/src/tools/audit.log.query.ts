import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...auditLogQuery.input.shape,
  source: auditLogQuery.input.shape.source.describe(
    "Which audit spine(s) to query: 'all', 'security' (auth/IAM/capability), or 'playbook' (automation)",
  ),
  eventType: auditLogQuery.input.shape.eventType.describe(
    "Exact event-type match, e.g. 'billing.plan_changed' or 'run_completed'",
  ),
  outcome: auditLogQuery.input.shape.outcome.describe(
    "Filter security events by authz outcome: allow | deny | error | success",
  ),
};

export const metadata: ToolMetadata = {
  name: auditLogQuery.name,
  description: auditLogQuery.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function auditLogQueryTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(auditLogQuery.name, args, ctx, {
    surface: "mcp",
  });
  return auditLogQuery.output.parse(output);
}
