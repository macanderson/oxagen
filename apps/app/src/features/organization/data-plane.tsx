// Organization › Data plane (pages/organization.md §Data plane, ADR-042):
// where the organization's tenant data lives. `get_data_plane {kind:
// "postgres"}` records the mode (shared or dedicated), its health, and for a
// dedicated plane the host, the database, the schema version and when the
// binding was last verified and rotated. The segmented control marks that mode
// current and previews the other two.
//
// No contract records the object store, the key-encryption key, the attester
// key, the gateway placement, a firewall bundle or the retention windows, so
// those rows say "not recorded". Request a change of plane and Rotate keys have
// no capability behind them yet and open dialogs that say what they would do
// (#3935). Tenant isolation
// states the platform's own guarantees, which hold for every organization on
// the shared plane: row-level security on every tenant table, the kernel as
// the only writer of a workspace id, and the startup guard in
// apps/app/instrumentation.ts that refuses a superuser or BYPASSRLS role.
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import type { DataPlane, WorkspaceList } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { DataPlaneModes, type PlaneMode } from "./data-plane-modes";
import { DateCell, NotRecorded, note } from "./parts";
import { StubDialog } from "./stub-dialog";

/** The fact labels the three modes draw, as the catalogue names them. */
type FactKey =
  | "binding"
  | "postgres"
  | "objectStorage"
  | "kek"
  | "attester"
  | "gateway"
  | "resolver"
  | "postgresHost"
  | "postgresDatabase"
  | "deployment"
  | "bundleVersion"
  | "bundleSignature"
  | "containers"
  | "airGapped"
  | "licence"
  | "nextBundle"
  | "outbound";

const term = "text-[12.5px] text-muted-foreground";
const value = "text-[13px] text-foreground";

function Facts({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2">
      {rows.map(([label, content]) => (
        <div key={label} className="contents">
          <dt className={term}>{label}</dt>
          <dd className={value}>{content}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBadge({ plane }: { plane: DataPlane }) {
  const t = useTranslations("organization.dataPlane");
  return (
    <Badge
      tone={
        plane.status === "active"
          ? "allowed"
          : plane.status === "degraded"
            ? "denied"
            : "failed"
      }
      data-plane-status={plane.status}
    >
      {t(`status.${plane.status}`)}
    </Badge>
  );
}

/** Each mode's about line and facts; the recorded plane fills the current one. */
function useDetails(plane: DataPlane): Record<PlaneMode, ReactNode> {
  const t = useTranslations("organization.dataPlane");
  const f = (key: FactKey) => t(`facts.${key}`);
  const nr = <NotRecorded />;
  const binding = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge plane={plane} />
      <span className={mono}>{t(`modes.${plane.mode}`)}</span>
      <span className="text-[12px] text-dim">
        {plane.lastVerifiedAt === null ? (
          t("neverVerified")
        ) : (
          <>
            {t("verified")} <DateCell iso={plane.lastVerifiedAt} />
          </>
        )}
        {plane.rotatedAt === null ? null : (
          <>
            {" · "}
            {t("rotated")} <DateCell iso={plane.rotatedAt} />
          </>
        )}
      </span>
    </span>
  );
  const about = (mode: PlaneMode) => (
    <p className="mb-3 text-[12.5px] text-muted-foreground">
      {t(`about.${mode}`)}
    </p>
  );
  const onShared = plane.mode === "shared";
  return {
    shared: (
      <>
        {about("shared")}
        <Facts
          rows={[
            [f("binding"), onShared ? binding : nr],
            [f("postgres"), onShared ? t("sharedPostgres") : nr],
            [f("objectStorage"), nr],
            [f("kek"), nr],
            [f("attester"), nr],
            [f("gateway"), nr],
          ]}
        />
      </>
    ),
    dedicated: (
      <>
        {about("dedicated")}
        <Facts
          rows={[
            [f("binding"), onShared ? nr : binding],
            [
              f("postgresHost"),
              plane.host === null ? (
                nr
              ) : (
                <span key="postgresHost" className={mono}>
                  {plane.host}
                </span>
              ),
            ],
            [
              f("postgresDatabase"),
              plane.database === null ? (
                nr
              ) : (
                <span key="postgresDatabase" className={mono}>
                  {plane.database}
                  {plane.schemaVersion === null
                    ? null
                    : ` · ${t("schema", { version: plane.schemaVersion })}`}
                </span>
              ),
            ],
            [f("objectStorage"), nr],
            [f("kek"), nr],
            [f("gateway"), nr],
            [f("resolver"), nr],
          ]}
        />
      </>
    ),
    firewall: (
      <>
        {about("firewall")}
        <Facts
          rows={[
            [f("deployment"), nr],
            [f("bundleVersion"), nr],
            [f("bundleSignature"), nr],
            [f("containers"), nr],
            [f("airGapped"), nr],
            [f("licence"), nr],
            [f("nextBundle"), nr],
            [f("outbound"), nr],
          ]}
        />
      </>
    ),
  };
}

function Binding({ org, plane }: { org: string; plane: DataPlane }) {
  const t = useTranslations("organization.dataPlane");
  const details = useDetails(plane);
  return (
    <section aria-labelledby="org-data-plane" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-data-plane" className={panelTitle}>
          {t("title")}
        </h2>
        <Badge tone="allowed" data-plane-mode={plane.mode}>
          {t("on", { org, mode: t(`modes.${plane.mode}`) })}
        </Badge>
      </div>
      <div className={`${panelBody} flex flex-col gap-3.5`}>
        <DataPlaneModes current={plane.mode} details={details} />
        <div className="flex flex-wrap gap-2">
          <StubDialog
            open={t("requestChange")}
            title={t("stub.plane.title")}
            body={t("stub.plane.body")}
            testId="data-plane-request"
          />
          <StubDialog
            open={t("rotateKeys")}
            title={t("stub.rotate.title")}
            body={t("stub.rotate.body")}
            testId="data-plane-rotate"
          />
        </div>
      </div>
    </section>
  );
}

function Retention() {
  const t = useTranslations("organization.dataPlane.retention");
  const nr = <NotRecorded />;
  return (
    <section aria-labelledby="org-retention" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-retention" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <Facts
          rows={[
            [t("frameBodies"), nr],
            [t("runLedger"), nr],
            [t("frameRows"), nr],
            [t("controlPlaneAudit"), nr],
            [t("digestOnly"), nr],
          ]}
        />
        <p className={note}>{t("note")}</p>
      </div>
    </section>
  );
}

function Isolation({
  org,
  workspaces,
}: {
  org: string;
  workspaces: WorkspaceList;
}) {
  const t = useTranslations("organization.dataPlane.isolation");
  const slugs = workspaces.workspaces.map((ws) => ws.slug).join(", ");
  return (
    <section aria-labelledby="org-isolation" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-isolation" className={panelTitle}>
          {t("title")}
        </h2>
        <Badge tone="quiet" dot={false}>
          {t("badge", { org })}
        </Badge>
      </div>
      <div className={panelBody}>
        <Facts
          rows={[
            [t("rows"), t("rowsValue")],
            [
              t("workspaceScoping"),
              <Fragment key="workspaceScoping">
                {t("workspaceScopingValue")}{" "}
                <span className={`${mono} text-dim`}>({slugs})</span>
              </Fragment>,
            ],
            [t("crossTenant"), t("crossTenantValue")],
            [t("platformCatalogs"), t("platformCatalogsValue")],
            [t("startupGuard"), t("startupGuardValue")],
          ]}
        />
      </div>
    </section>
  );
}

export function DataPlaneTab({
  org,
  orgName,
  read,
  workspaces,
}: {
  org: string;
  orgName: string;
  read: Read<DataPlane>;
  workspaces: WorkspaceList;
}) {
  const t = useTranslations("organization.dataPlane");
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid gap-3.5 lg:grid-cols-[3fr_2fr]">
        {read.ok ? (
          <Binding org={orgName} plane={read.value} />
        ) : (
          <section className={panel}>
            <div className={panelBody}>
              <ReadFailure read={read} section={t("title")} />
            </div>
          </section>
        )}
        <Retention />
      </div>
      <Isolation org={org} workspaces={workspaces} />
    </div>
  );
}
