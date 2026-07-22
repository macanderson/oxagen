import { gatewayModels, vendorLabels, type Vendor } from "@oxagen/ai/catalog";
import { allPostures, posturesFor, postureForModel } from "@oxagen/ai/posture";
import type { VendorPosture } from "@oxagen/ai/posture";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type {
  ModelCapabilityListInput,
  ModelCapabilityListOutput,
} from "@oxagen/oxagen/contracts/model.capability.list";

// Projects the compile-time provider posture registry (@oxagen/ai/posture) onto
// the capability's output shape. The registry itself is static and complete by
// construction — a vendor missing a row is a TypeScript error, not a runtime
// one — so this handler does no I/O: it filters, joins each vendor to the
// catalog models that ship under it, and returns.

/** Gateway model ids the catalog ships for a vendor, in catalog order. */
function modelsForVendor(vendor: Vendor): string[] {
  return gatewayModels.filter((m) => m.vendor === vendor).map((m) => m.id);
}

function toOutputRow(
  posture: VendorPosture,
): ModelCapabilityListOutput["vendors"][number] {
  return {
    vendor: posture.vendor,
    label: vendorLabels[posture.vendor],
    models: modelsForVendor(posture.vendor),
    cache: posture.cache,
    reasoning: posture.reasoning,
    structuredOutput: posture.structuredOutput,
    // The registry holds `kinds` readonly (it is a frozen matrix); the contract
    // schema infers a mutable array, so copy rather than widen the registry.
    attachments:
      posture.attachments.kind === "supported"
        ? { ...posture.attachments, kinds: [...posture.attachments.kinds] }
        : posture.attachments,
  };
}

export const modelCapabilityListHandler: CapabilityHandlerFn = async (
  input,
) => {
  const { vendor, model } = input as ModelCapabilityListInput;

  // `model` wins over `vendor` (the contract says so): a caller holding a
  // concrete gateway id wants the row that governs THAT call.
  if (model) {
    const posture = postureForModel(model);
    // An unknown provider must read as unknown, never as an empty-but-fine
    // matrix — echo the filter back so the caller can tell the two apart.
    return {
      vendors: posture ? [toOutputRow(posture)] : [],
      unknownFilter: posture ? null : model,
    } satisfies ModelCapabilityListOutput;
  }

  if (vendor) {
    const posture = posturesFor(vendor);
    return {
      vendors: posture ? [toOutputRow(posture)] : [],
      unknownFilter: posture ? null : vendor,
    } satisfies ModelCapabilityListOutput;
  }

  return {
    vendors: allPostures().map(toOutputRow),
    unknownFilter: null,
  } satisfies ModelCapabilityListOutput;
};
