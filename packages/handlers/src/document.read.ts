import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentRead } from "@oxagen/oxagen/contracts/document.read";

export const documentReadHandler: CapabilityHandler<typeof documentRead> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] document.read document_id=${input.document_id}`);
  return {
    title: "Stub Document",
    content: "Document content not yet implemented.",
    metadata: {},
    created_at: new Date().toISOString(),
  };
};
