import { getTranslations } from "next-intl/server";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";
import { InviteDialog } from "./invite-dialog";
import { CreateWorkspace } from "./workspace-actions";

export async function OrganizationHeader({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const t = await getTranslations("organization.header");
  const allowed = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  const members = allowed ? await source.org.members(ctx) : null;
  return (
    <PageHeader
      title={ctx.orgName}
      eyebrow={t("eyebrow")}
      description={t("description")}
      actions={
        allowed ? (
          <>
            {members?.ok ? (
              <InviteDialog
                org={ctx.orgSlug}
                pendingIds={members.value.invitations.map((i) => i.id)}
                allowed
                after={routes.organization(ctx.orgSlug, "invitations")}
              />
            ) : null}
            <CreateWorkspace org={ctx.orgSlug} primary />
          </>
        ) : null
      }
    />
  );
}
