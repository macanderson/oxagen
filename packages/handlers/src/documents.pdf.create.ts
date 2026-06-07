// documents.pdf.create.ts — foundation-milestone stub.
// PDF generation is a console-logging stub for now (policy §stub); returns
// a mock asset response without uploading to storage or throwing errors.

import { randomUUID } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/documents.pdf.create";
import { logger } from "./logger";

export const documentsPdfCreateHandler: CapabilityHandler<typeof documentsPdfCreate> = async (
  input,
  ctx,
) => {
  const { title } = input;
  const mimeType = "application/pdf";
  const publicId = `gen_${randomUUID().slice(0, 8)}`;
  const mockSizeBytes = 8192;

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      title,
      stub: true,
    },
    "documents.pdf.create: stub (foundation milestone)",
  );

  return {
    assetId: randomUUID(),
    publicId,
    kind: "pdf",
    mimeType,
    sizeBytes: mockSizeBytes,
    url: `/stub/gen_${publicId}`,
    serveUrl: `/api/v1/assets/${publicId}`,
    render: {
      componentId: "file-attachment",
      props: {
        url: `/api/v1/assets/${publicId}`,
        name: `${title}.pdf`,
        kind: "pdf",
        mimeType,
        sizeBytes: mockSizeBytes,
      },
    },
  };
};
