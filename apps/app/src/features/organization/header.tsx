// The Organization page's header (mockup `pOrganization` `.phead`): the
// eyebrow "Organization", the organization's name as the h1, the one-line
// description, and the two header actions, Invite and the screen's one gold
// action, Create a workspace. Every Organization tab draws this same header,
// so the tabs beneath it read as one page. The frame reaches it only for an
// Owner or an Admin (`frame.tsx`), which is who both writes admit.
import { useTranslations } from "next-intl";
import type { OrgCtx } from "@/server/viewer";
import { type SafePath, routes } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";
import { InviteDialog } from "./invite-dialog";
import { CreateWorkspace } from "./workspace-actions";

export function OrganizationHeader({
  ctx,
  pendingIds,
  twoFactorRequired,
  enterable,
  after,
}: {
  ctx: OrgCtx;
  /** The pending invitations' ids, so Invite can tell a new one from a resend. */
  pendingIds: readonly string[];
  /** The organization's two-factor policy, which Invite states. */
  twoFactorRequired: boolean;
  /** The live workspaces the viewer may enter, whose repositories Create a workspace offers. */
  enterable: readonly string[];
  /** Where Invite reloads once an invitation was sent. */
  after?: SafePath;
}) {
  const t = useTranslations("organization.page");
  return (
    <PageHeader
      title={ctx.orgName}
      eyebrow={t("eyebrow")}
      description={t("description")}
      actions={
        <>
          <InviteDialog
            org={ctx.orgSlug}
            pendingIds={pendingIds}
            allowed
            twoFactorRequired={twoFactorRequired}
            after={after ?? routes.organization(ctx.orgSlug, "invitations")}
          />
          <CreateWorkspace org={ctx.orgSlug} enterable={enterable} primary />
        </>
      }
    />
  );
}
