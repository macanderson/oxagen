// The `/` landing (ARCHITECTURE.md §1.2, §3.3): a signed-in person opens the
// first workspace of the first organization they joined; a person with no
// organization creates one, and an organization with no workspace of theirs
// opens its People page. No organization context exists yet, so it reads
// through the pretenant port. A refused or failed read is the error page.
import "server-only";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { type PretenantCtx, requireUser } from "@/server/viewer";
import { redirectTo } from "@/shared/navigation";
import { routes, type SafePath } from "@/shared/safe-path";

/** Renders nothing: every outcome is a redirect, or a thrown read failure. */
export async function Landing({
  source,
}: {
  source: DataSource;
}): Promise<never> {
  const ctx = await requireUser();
  redirectTo(await landingPath(ctx, source));
}

async function landingPath(
  ctx: PretenantCtx,
  source: DataSource,
): Promise<SafePath> {
  const orgs = await source.pretenant.orgs(ctx);
  if (!orgs.ok) throw unroutable(orgs);
  const [org] = orgs.value;
  if (org === undefined) return routes.newOrganization();
  const workspaces = await source.pretenant.workspaces(ctx, org.slug);
  if (!workspaces.ok) throw unroutable(workspaces);
  const [ws] = workspaces.value;
  return ws === undefined
    ? routes.people(org.slug)
    : routes.fleet(org.slug, ws.slug);
}

/** A read the landing cannot route from, thrown so Next renders the error page. */
function unroutable(read: Exclude<Read<unknown>, { ok: true }>): Error {
  return new Error(`landing_${read.reason}`);
}
