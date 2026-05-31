import { randomUUID } from "crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentsGenerate } from "@oxagen/oxagen/contracts/documents.generate";

export const documentsGenerateHandler: CapabilityHandler<typeof documentsGenerate> = async (
  input,
  _ctx,
) => {
  const fileId = `stub_${randomUUID()}`;
  const url = `https://stub.invalid/${fileId}`;

  console.log(
    `[stub] documents.generate ${input.provider}/${input.kind} — would generate "${input.title}" (fileId=${fileId})${input.instructions ? ` with instructions: "${input.instructions}"` : ""}`,
  );

  if (input.brandKitId !== undefined) {
    console.log(`[stub] brandkit.apply ${input.brandKitId} -> ${fileId}`);
  }

  return {
    stub: true,
    provider: input.provider,
    kind: input.kind,
    fileId,
    url,
  };
};
