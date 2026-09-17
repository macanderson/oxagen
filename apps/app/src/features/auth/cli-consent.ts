// The CLI consent picker's reads (ARCHITECTURE.md §1.2, §3.3): the
// organizations the signed-in person belongs to, each with the workspaces of it
// the person is a member of, through the pretenant port. An organization with
// no such workspace is left out, because the code is bound to a workspace; a
// refused or failed read is the page's answer.
import "server-only";
import type { OrgChoice, WorkspaceChoice } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import type { PretenantCtx } from "@/server/viewer";

export type ConsentOrg = OrgChoice & { workspaces: WorkspaceChoice[] };

export async function loadConsentChoices(
  ctx: PretenantCtx,
  source: DataSource,
): Promise<Read<ConsentOrg[]>> {
  const orgs = await source.pretenant.orgs(ctx);
  if (!orgs.ok) return orgs;
  const reads = await Promise.all(
    orgs.value.map(async (org) => ({
      org,
      workspaces: await source.pretenant.workspaces(ctx, org.slug),
    })),
  );
  const choices: ConsentOrg[] = [];
  for (const { org, workspaces } of reads) {
    if (!workspaces.ok) return workspaces;
    if (workspaces.value.length > 0)
      choices.push({ ...org, workspaces: workspaces.value });
  }
  return readOk(choices);
}
