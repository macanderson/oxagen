import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";

export const connectionPreviewHandler: CapabilityHandler<typeof connectionPreview> = async (
  _input,
  _ctx,
) => {
  // TODO(ingestion): implement preview by loading connector + auth credentials,
  // calling connector.previewRecordTypes(auth, config), and returning the sample data.
  // Tracked in Linear.
  throw new Error("connection.preview: not yet implemented");
};
