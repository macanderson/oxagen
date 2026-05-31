import { randomUUID } from "crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/documents.pdf.create";

export const documentsPdfCreateHandler: CapabilityHandler<typeof documentsPdfCreate> = async (
  input,
  _ctx,
) => {
  const fileId = `stub_${randomUUID()}`;
  const url = `https://stub.invalid/${fileId}`;

  const source = input.sourceFileId
    ? `sourceFileId=${input.sourceFileId}`
    : input.sourceHtml
      ? `sourceHtml=<${input.sourceHtml.length} chars>`
      : "no source";

  console.log(
    `[stub] documents.pdf.create — would render PDF "${input.title}" (${source}) -> fileId=${fileId}`,
  );

  if (input.brandKitId !== undefined) {
    console.log(`[stub] brandkit.apply ${input.brandKitId} -> ${fileId}`);
  }

  return {
    stub: true,
    fileId,
    url,
  };
};
