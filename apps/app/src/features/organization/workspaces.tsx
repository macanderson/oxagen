// Organization › Workspaces (ARCHITECTURE.md §1.2, #2964): the organization's
// workspaces, the archived ones beside the live ones, with the create, rename
// and archive writes. This section closes rev1's one real hole: before it, an
// organization that wanted a second workspace made it through the API, MCP or
// CLI, and `create_org` made the first one.
import { useTranslations } from "next-intl";
import type { Workspace, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { mono } from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import {
  ArchiveWorkspace,
  CreateWorkspace,
  EditWorkspace,
} from "./workspace-actions";

export async function Workspaces({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.org.workspaces(ctx);
  return (
    <WorkspacesView
      org={ctx.orgSlug}
      canEdit={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      read={read}
    />
  );
}

const sectionTitle = "text-base font-semibold text-foreground";
const lead = "text-sm text-muted-foreground";

/** The workspace's state as a dot and a word, so it survives greyscale. */
function Status({ workspace }: { workspace: Workspace }) {
  const t = useTranslations("organization.workspaces.status");
  const archived = workspace.archivedAt !== null;
  return (
    <span
      data-status={archived ? "archived" : "live"}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${archived ? "bg-muted-foreground" : "bg-success"}`}
      />
      {archived ? t("archived") : t("live")}
    </span>
  );
}

function WorkspacesView({
  org,
  canEdit,
  read,
}: {
  org: string;
  /** Owners and admins write; each handler checks the role again. */
  canEdit: boolean;
  read: Read<WorkspaceList>;
}) {
  const t = useTranslations("organization.workspaces");
  const tActions = useTranslations("organization.actions");
  const columns = [
    { label: t("columns.workspace") },
    { label: t("columns.role") },
    { label: t("columns.status") },
    ...(canEdit ? [{ label: t("columns.actions") }] : []),
  ];
  return (
    <section aria-labelledby="org-workspaces" className="flex flex-col gap-3">
      <h2 id="org-workspaces" className={sectionTitle}>
        {t("title")}
      </h2>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <CreateWorkspace org={org} />
        </div>
      ) : (
        <p className={lead}>{tActions("readOnly")}</p>
      )}
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : read.value.workspaces.length === 0 ? (
        <p className={lead}>{t("empty")}</p>
      ) : (
        <Table label={t("tableLabel")} columns={columns}>
          {read.value.workspaces.map((workspace) => (
            <tr key={workspace.id} data-workspace={workspace.id}>
              <td className={cell}>
                <div className="font-medium text-foreground">
                  {workspace.name}
                </div>
                <div className={`${mono} text-muted-foreground`}>
                  {workspace.slug}
                </div>
              </td>
              <td className={cell}>{workspace.role ?? t("noRole")}</td>
              <td className={cell}>
                <Status workspace={workspace} />
              </td>
              {canEdit ? (
                <td className={cell}>
                  {/* An archived workspace is a record, not a thing to
                      edit: `update_workspace_settings` refuses it
                      (`workspace_archived`), because releasing its slug would
                      break the redirect `archive_workspace` promises. So it
                      is offered neither control. */}
                  <div className="flex flex-wrap gap-2">
                    {workspace.archivedAt === null ? (
                      <>
                        <EditWorkspace org={org} workspace={workspace} />
                        <ArchiveWorkspace org={org} workspace={workspace} />
                      </>
                    ) : null}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
