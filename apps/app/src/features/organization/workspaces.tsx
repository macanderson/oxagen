// Organization › Workspaces (pages/organization.md): every workspace of the
// organization, the archived ones beside the live ones, with Open, Edit and
// Archive, and Create a workspace in the panel. The frame reads the list once
// (`list_workspaces {includeArchived:true}`).
//
// `list_workspaces` records a workspace's name, slug, namespace and archival.
// Main repo, Production branch and Linked repos come from `list_repositories`
// and Agents from `list_agents`, read inside each live workspace the viewer may
// enter (the `org.workspaceFacts` port). Those facts are recorded for every
// workspace, but a workspace-scoped read needs a membership: a workspace the
// viewer is not a member of says "not readable without membership", and an
// archived one, which is not read, says "not read while archived". Neither
// says "not recorded", because the record holds them. Nothing records a
// workspace's owner, and the governance mode lives in
// `.oxagen/rules/governance.toml` on the main repository, which no contract
// reads back: the Owner cell says "not recorded", and the Governance chip says
// the mode is not recorded with the namespace beneath it (#3933 for the owner,
// #3907 for the governance mode).
//
// Open goes to the workspace's Fleet. A workspace the viewer holds no
// membership of cannot be opened (`requireViewer` answers not found), so its
// Open is left off rather than offered as a link that fails.
import { useTranslations } from "next-intl";
import type {
  Workspace,
  WorkspaceFacts,
  WorkspaceList,
} from "@/data/contracts/org";
import type { Read } from "@/data/read";
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

/** What the tab learned inside a workspace, by slug; absent for one it did not read. */
export type FactsBySlug = ReadonlyMap<string, Read<WorkspaceFacts>>;

/** A row's value for the Production branch filter; none when the branch is not known. */
function branchValue(branch: string | undefined): Record<string, string> {
  return branch === undefined ? {} : { branch };
}

/**
 * Why a workspace's facts were not read: the viewer holds no membership of it,
 * it is archived, or its read never arrived. The facts are recorded either
 * way, so the cell names the reason rather than saying "not recorded".
 */
type Withheld = {
  reason: "membership" | "archived" | "unread";
  label: string;
};

/** The cells a workspace's facts fill: main repo, production branch, linked repos, agents. */
function factCells(
  facts: Read<WorkspaceFacts> | Withheld,
  unread: string,
  none: string,
) {
  if (!("ok" in facts)) {
    const withheld = (key: string) => (
      <span
        key={key}
        data-facts-withheld={facts.reason}
        className="text-[11.5px] text-dim"
      >
        {facts.label}
      </span>
    );
    return {
      cells: [
        withheld("main"),
        withheld("branch"),
        withheld("linked"),
        withheld("agents"),
      ],
      branch: undefined,
    };
  }
  if (!facts.ok) {
    const { reason } = facts;
    const failed = (key: string) => (
      <span
        key={key}
        data-facts-unread={reason}
        className="text-[11.5px] text-dim"
      >
        {unread}
      </span>
    );
    return {
      cells: [
        failed("main"),
        failed("branch"),
        failed("linked"),
        failed("agents"),
      ],
      branch: undefined,
    };
  }
  const main = facts.value.repositories.find((repo) => repo.role === "main");
  const linked = facts.value.repositories.filter(
    (repo) => repo.role === "linked",
  );
  return {
    cells: [
      main === undefined ? (
        <span key="main" className="text-[11.5px] text-dim">
          {none}
        </span>
      ) : (
        <span key="main" className={`${mono} text-[11.5px]`}>
          {main.fullName}
        </span>
      ),
      main === undefined ? (
        <span key="branch" className="text-[11.5px] text-dim">
          {none}
        </span>
      ) : (
        <span key="branch" className={`${mono} text-[11.5px]`}>
          {main.defaultRef}
        </span>
      ),
      linked.length === 0 ? (
        <span key="linked" className="text-[11.5px] text-dim">
          {none}
        </span>
      ) : (
        <span key="linked" className={`${mono} text-[11.5px]`}>
          {linked.map((repo) => repo.fullName).join(", ")}
        </span>
      ),
      <span key="agents" className="tabular-nums">
        {facts.value.agents}
      </span>,
    ],
    branch: main?.defaultRef,
  };
}

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
      <Badge
        tone="quiet"
        dot={false}
        data-governance="not-recorded"
        data-issue="3907"
      >
        {t("governanceNotRecorded")}
      </Badge>
      <div className="text-[11px] text-dim" data-issue="3933">
        {t("retentionNotRecorded")}
      </div>
      <div className={`${mono} text-[11px] text-dim`}>
        {t("namespace", { namespace: workspace.namespace })}
      </div>
    </>
  );
}

function Actions({
  org,
  workspace,
  facts,
}: {
  org: string;
  workspace: Workspace;
  facts: Read<WorkspaceFacts> | undefined;
}) {
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
          <EditWorkspace
            org={org}
            workspace={workspace}
            facts={facts?.ok === true ? facts.value : null}
          />
          <ArchiveWorkspace
            org={org}
            workspace={workspace}
            facts={facts?.ok === true ? facts.value : null}
          />
        </>
      ) : null}
    </div>
  );
}

export function WorkspacesTab({
  org,
  workspaces,
  facts = new Map(),
  enterable = [],
}: {
  org: string;
  workspaces: WorkspaceList;
  /** What was read inside each workspace the viewer may enter. */
  facts?: FactsBySlug;
  /** The live workspaces the viewer may enter, for Create a workspace. */
  enterable?: readonly string[];
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
    { label: t("columns.actions"), hidden: true },
  ];
  const withheldFor = (workspace: Workspace): Withheld => {
    if (workspace.archivedAt !== null) {
      return { reason: "archived", label: t("factsArchived") };
    }
    if (workspace.role === null) {
      return { reason: "membership", label: t("factsNoMembership") };
    }
    // A live workspace the viewer belongs to whose read never arrived.
    return { reason: "unread", label: t("factsUnread") };
  };
  const branches = new Set<string>();
  const rows: ListRow[] = workspaces.workspaces.map((workspace) => {
    const read =
      workspace.archivedAt === null ? facts.get(workspace.slug) : undefined;
    const known = factCells(
      read ?? withheldFor(workspace),
      t("factsUnread"),
      t("noLinked"),
    );
    if (known.branch !== undefined) branches.add(known.branch);
    return {
      key: workspace.id,
      rowId: workspace.id,
      values: branchValue(known.branch),
      cells: [
        <WorkspaceCell key="workspace" workspace={workspace} />,
        ...known.cells,
        <NotRecorded key="owner" />,
        <GovernanceCell key="governance" workspace={workspace} />,
        <Actions key="actions" org={org} workspace={workspace} facts={read} />,
      ],
    };
  });
  return (
    <section aria-labelledby="org-workspaces" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-workspaces" className={panelTitle}>
          {t("title")}
        </h2>
        <CreateWorkspace org={org} enterable={enterable} />
      </div>
      <ListTable
        label={t("tableLabel")}
        columns={columns}
        rows={rows}
        filters={[
          {
            key: "branch",
            label: t("filters.branch"),
            options: [...branches]
              .sort()
              .map((branch) => ({ value: branch, label: branch })),
          },
        ]}
        empty={workspaces.workspaces.length === 0 ? t("empty") : t("noMatch")}
      />
      <div className={panelBody}>
        <p className={note}>{t("note")}</p>
      </div>
    </section>
  );
}
