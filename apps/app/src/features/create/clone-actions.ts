"use server";
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

// The draft shape is the `get_clone_draft` output, which is
// `configurationCloneDraftSchema` itself. Naming it off the contract keeps the
// feature on the `@oxagen/oxagen/contracts/*` row it already imports from,
// rather than reaching into the platform package for the same type.
export type ConfigurationCloneDraft = ContractOutput<
  typeof configurationCloneGet
>;
export async function readCloneDraft(
  org: string,
  ws: string,
  kind: ConfigurationCloneDraft["kind"],
  sourceRef: string,
): Promise<ActionResult<ConfigurationCloneDraft>> {
  const ctx = await requireViewer(org, ws);
  return readToActionResult(
    await kernelRead(ctx, {
      contract: configurationCloneGet,
      input: { kind, sourceId: sourceRef },
      page: "steering",
    }),
  );
}
export async function proposeClone(
  org: string,
  ws: string,
  input: ConfigurationCloneDraft,
): Promise<ActionResult<ContractOutput<typeof configurationClonePropose>>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, configurationClonePropose, input);
}
