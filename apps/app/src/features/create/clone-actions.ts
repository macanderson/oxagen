"use server";
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import type { ConfigurationCloneDraft } from "@oxagen/oxagen/configuration-clone";
import {
  kernelRead,
  kernelWrite,
  readToActionResult,
  type ActionResult,
  type ContractOutput,
} from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
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
