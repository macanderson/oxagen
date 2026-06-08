import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentCreate } from "@oxagen/oxagen/contracts/document.create";

export const documentCreateHandler: CapabilityHandler<typeof documentCreate> = async (
  input,
  ctx,
) => {
  console.log(`[stub] document.create title="${input.title}" workspace=${ctx.workspaceId}`);
  return {
    document_id: `doc_stub_${Date.now()}`,
    title: input.title,
    created_at: new Date().toISOString(),
    workspace_id: ctx.workspaceId ?? "unknown",
  };
};
