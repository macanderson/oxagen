// The denied state for a workspace the viewer cannot see (mockup
// `deniedState("this workspace", "workspace.read on core-platform")`,
// audit-prompt check 22). The workspace layout renders it in place of the
// page when resolveWorkspaceViewer answers `refused`, so the shell stays
// around it: the sidebar, the breadcrumbs and the search are still there.
//
// An unknown slug and a workspace the member does not belong to read the same
// here, as they do in the tenancy lookups, so the page confirms nothing about
// a workspace the viewer cannot see. The refusal records no policy id, so
// "Decided by" says so (#3846). "Back to Fleet" goes to the first workspace
// the viewer does belong to, or to the organization when there is none.
import "server-only";
import { getTranslations } from "next-intl/server";
import type { DataSource } from "@/data/ports";
import { getAuthUser } from "@/features/auth";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { PageDenied } from "@/ui/page-states";

export async function WorkspaceDenied({
  ctx,
  ws,
  source,
}: {
  ctx: OrgCtx;
  /** The workspace slug the URL asked for, echoed as the permission's scope. */
  ws: string;
  source: Pick<DataSource, "shell">;
}) {
  const [t, user, context] = await Promise.all([
    getTranslations("shell.denied"),
    getAuthUser(),
    source.shell.context(ctx),
  ]);
  const first = context.ok ? context.value.workspaces[0] : undefined;
  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col">
      <PageDenied
        title={t("workspace")}
        orgName={ctx.orgName}
        permission={t("permission", { ws })}
        signedIn={{
          name: user?.name || user?.email || t("unnamed"),
          role: `org.${ctx.orgRole}`,
          scope: ctx.orgSlug,
        }}
        decidedBy={null}
        back={
          first === undefined
            ? routes.people(ctx.orgSlug)
            : routes.fleet(ctx.orgSlug, first.slug)
        }
      />
    </main>
  );
}
