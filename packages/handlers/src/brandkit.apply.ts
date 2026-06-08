import type { CapabilityHandler } from "@oxagen/oxagen";
import { brandkitApply } from "@oxagen/oxagen/contracts/brandkit.apply";
import { logger } from "./logger";

// TRACKED STUB (no-throw): applying a brand kit to a target file requires a
// brand-kit subsystem that does not exist yet — there is no `brandkits` table,
// no brand-kit asset storage, and no document-mutation engine to apply
// colors/fonts/logos. The contract output declares `applied: false` for this
// reason. This stays a stub until that backing is built; the handler is wired,
// typed, instrumented, and never throws so callers degrade gracefully.
export const brandkitApplyHandler: CapabilityHandler<typeof brandkitApply> = async (
  input,
  _ctx,
) => {
  logger.info(
    {
      brandKitId: input.brandKitId,
      targetFileId: input.targetFileId,
      workspaceId: input.workspaceId,
      stub: true,
    },
    "brandkit.apply: stub invoked (no backing subsystem yet — returning applied:false)",
  );

  return {
    stub: true,
    applied: false,
    brandKitId: input.brandKitId,
    targetFileId: input.targetFileId,
  };
};
