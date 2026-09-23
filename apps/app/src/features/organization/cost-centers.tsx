// Organization › Cost centers (ADR-142): the labels spend is charged back to,
// each with how many agents and workspaces name it, and the label each live
// workspace is charged to. An agent's label wins over its workspace's; an
// agent is charged on its own page (features/agents/cost-center-controls.tsx)
// or through set_cost_center on the API or MCP.
import { useTranslations } from "next-intl";
import type { CostCenterList, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import {
  AddCostCenter,
  ChargeWorkspace,
  DeleteCostCenter,
} from "./cost-center-controls";

export async function CostCenters({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const [centers, workspaces] = await Promise.all([
    source.org.costCenters(ctx),
    source.org.workspaces(ctx),
  ]);
  return (
    <CostCentersView
      org={ctx.orgSlug}
      canEdit={
        ctx.orgRole === "owner" ||
        ctx.orgRole === "admin" ||
        ctx.orgRole === "billing"
      }
      centers={centers}
      workspaces={workspaces}
    />
  );
}

const lead = `${panelBody} text-sm text-muted-foreground`;

/** @internal Exported for its component test; the page renders `CostCenters`. */
export function CostCentersView({
  org,
  canEdit,
  centers,
  workspaces,
}: {
  org: string;
  /** Owners, admins and billing members write; each handler checks the role again. */
  canEdit: boolean;
  centers: Read<CostCenterList>;
  workspaces: Read<WorkspaceList>;
}) {
  const t = useTranslations("organization.costCenters");
  const tActions = useTranslations("organization.actions");
  const labelColumns = [
    { label: t("columns.label") },
    { label: t("columns.description") },
    { label: t("columns.agents") },
    { label: t("columns.workspaces") },
    ...(canEdit ? [{ label: t("columns.actions") }] : []),
  ];
  const workspaceColumns = [
    { label: t("columns.workspace") },
    { label: t("columns.costCenter") },
    ...(canEdit ? [{ label: t("columns.actions") }] : []),
  ];
  const live = workspaces.ok
    ? workspaces.value.workspaces.filter((w) => w.archivedAt === null)
    : [];
  return (
    <section aria-labelledby="org-cost-centers" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-cost-centers" className={panelTitle}>
          {t("title")}
        </h2>
        {canEdit ? <AddCostCenter org={org} /> : null}
      </div>
      <p className={lead}>{t("lead")}</p>
      {canEdit ? null : <p className={lead}>{tActions("readOnly")}</p>}
      {!centers.ok ? (
        <ReadFailure read={centers} section={t("title")} />
      ) : centers.value.costCenters.length === 0 ? (
        <p className={lead}>{t("empty")}</p>
      ) : (
        <Table label={t("labelsTable")} columns={labelColumns}>
          {centers.value.costCenters.map((center) => (
            <tr key={center.id} data-cost-center={center.label}>
              <td className={`${cell} ${mono}`}>{center.label}</td>
              <td className={cell}>
                {center.description ?? (
                  <span className="text-muted-foreground">
                    {t("noDescription")}
                  </span>
                )}
              </td>
              <td className={`${cell} tabular-nums`}>{center.agents}</td>
              <td className={`${cell} tabular-nums`}>{center.workspaces}</td>
              {canEdit ? (
                <td className={cell}>
                  <DeleteCostCenter org={org} costCenter={center} />
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
      {!workspaces.ok ? (
        <ReadFailure read={workspaces} section={t("workspacesTable")} />
      ) : live.length === 0 ? null : (
        <Table label={t("workspacesTable")} columns={workspaceColumns}>
          {live.map((workspace) => (
            <tr key={workspace.id} data-workspace={workspace.id}>
              <td className={cell}>
                <div className="font-medium text-foreground">
                  {workspace.name}
                </div>
                <div className={`${mono} text-muted-foreground`}>
                  {workspace.slug}
                </div>
              </td>
              <td className={cell}>
                {workspace.costCenter === null ? (
                  <span className="text-muted-foreground">{t("none")}</span>
                ) : (
                  <span className={mono}>{workspace.costCenter}</span>
                )}
              </td>
              {canEdit ? (
                <td className={cell}>
                  <ChargeWorkspace
                    org={org}
                    workspace={workspace}
                    costCenters={centers.ok ? centers.value.costCenters : []}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
