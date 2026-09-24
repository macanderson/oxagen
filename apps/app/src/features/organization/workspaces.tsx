// Organization › Workspaces (pages/organization.md): every workspace of the
// organization, the archived ones beside the live ones, with Open, Edit and
// Archive, and Create a workspace in the panel. The frame reads the list once
// (`list_workspaces {includeArchived:true}`).
//
// `list_workspaces` records a workspace's name, slug, namespace and archival.
// It records no main repository, production branch, linked repositories,
// agent count or owner, and the governance mode lives in
// `.oxagen/rules/governance.toml` on the main repository, which no contract
// reads back. Those cells say "not recorded", and the Governance chip says the
// mode is not recorded with the namespace beneath it (macanderson/oxagen, the
// Workspaces issue this lane filed).
//
// Open goes to the workspace's Fleet. A workspace the viewer holds no
// membership of cannot be opened (`requireViewer` answers not found), so its
// Open is left off rather than offered as a link that fails.
import { useTranslations } from "next-intl";
import type { Workspace, WorkspaceList } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { type ListRow, ListTable } from "./list-table";
import { NotRecorded, note } from "./parts";
import {
  ArchiveWorkspace,
  CreateWorkspace,
  EditWorkspace,
} from "./workspace-actions";

function WorkspaceCell({ workspace }: { workspace: Workspace }) {
  const t = useTranslations("organization.workspaces");
  return (
    <>
      <div className="font-semibold text-foreground">{workspace.name}</div>
      <div className={`${mono} text-[11px] text-dim`}>{workspace.slug}</div>
      {workspace.archivedAt === null ? null : (
        <Badge tone="quiet" data-status="archived">
          {t("archived")}
        </Badge>
      )}
    </>
  );
}

function GovernanceCell({ workspace }: { workspace: Workspace }) {
  const t = useTranslations("organization.workspaces");
  return (
    <>
      <Badge tone="quiet" dot={false} data-governance="not-recorded">
        {t("governanceNotRecorded")}
      </Badge>
      <div className={`${mono} text-[11px] text-dim`}>
        {t("retentionNotRecorded")} ·{" "}
        {t("namespace", { namespace: workspace.namespace })}
      </div>
    </>
  );
}

function Actions({ org, workspace }: { org: string; workspace: Workspace }) {
  const t = useTranslations("organization.workspaces");
  const live = workspace.archivedAt === null;
  return (
    <div className="flex flex-wrap gap-2">
      {live && workspace.role !== null ? (
        <SafeLink
          to={routes.fleet(org, workspace.slug)}
          className={buttonSecondary}
        >
          {t("open")}
        </SafeLink>
      ) : null}
      {/* An archived workspace is a record, not a thing to edit:
          `update_workspace_settings` refuses it (`workspace_archived`),
          because releasing its slug would break the redirect
          `archive_workspace` promises. So it is offered neither control. */}
      {live ? (
        <>
          <EditWorkspace org={org} workspace={workspace} />
          <ArchiveWorkspace org={org} workspace={workspace} />
        </>
      ) : null}
    </div>
  );
}

export function WorkspacesTab({
  org,
  workspaces,
}: {
  org: string;
  workspaces: WorkspaceList;
}) {
  const t = useTranslations("organization.workspaces");
  const columns = [
    { label: t("columns.workspace") },
    { label: t("columns.mainRepo") },
    { label: t("columns.productionBranch") },
    { label: t("columns.linkedRepos") },
    { label: t("columns.agents"), numeric: true },
    { label: t("columns.owner") },
    { label: t("columns.governance") },
    { label: t("columns.actions") },
  ];
  const rows: ListRow[] = workspaces.workspaces.map((workspace) => ({
    key: workspace.id,
    rowId: workspace.id,
    search: `${workspace.name} ${workspace.slug} ${workspace.namespace}`,
    cells: [
      <WorkspaceCell key="workspace" workspace={workspace} />,
      <NotRecorded key="main" />,
      <NotRecorded key="branch" />,
      <NotRecorded key="linked" />,
      <NotRecorded key="agents" />,
      <NotRecorded key="owner" />,
      <GovernanceCell key="governance" workspace={workspace} />,
      <Actions key="actions" org={org} workspace={workspace} />,
    ],
  }));
  return (
    <section aria-labelledby="org-workspaces" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-workspaces" className={panelTitle}>
          {t("title")}
        </h2>
        <CreateWorkspace org={org} />
      </div>
      <ListTable
        label={t("tableLabel")}
        columns={columns}
        rows={rows}
        empty={workspaces.workspaces.length === 0 ? t("empty") : t("noMatch")}
      />
      <div className={panelBody}>
        <p className={note}>{t("note")}</p>
      </div>
    </section>
  );
}
