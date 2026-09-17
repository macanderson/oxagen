import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...auditEventsExport.input.shape,
  format: auditEventsExport.input.shape.format.describe(
    "csv (RFC 4180) or ndjson, one object per line",
  ),
  from: auditEventsExport.input.shape.from.describe(
    "Inclusive ISO-8601 lower bound on occurredAt",
  ),
  to: auditEventsExport.input.shape.to.describe(
    "Exclusive ISO-8601 upper bound on occurredAt",
  ),
};

export const metadata: ToolMetadata = {
  name: auditEventsExport.name,
  description: auditEventsExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function auditEventsExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(auditEventsExport.name, args, ctx, {
    surface: "mcp",
  });
  return auditEventsExport.output.parse(output);
}
