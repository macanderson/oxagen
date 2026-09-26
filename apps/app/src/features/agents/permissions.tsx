// Permissions (spec pages/agent.md, Permissions): roles, ceilings and
// mandates, which are all limits on the principal. It never lists tools: a
// belt decides what the model is shown, and this tab decides whether a call
// survives.
//
// Roles are `get_agent`'s assignments, with the permission ids each carries
// from the organization's role catalogue when the viewer may read it. Assign
// and Revoke are drawn only for an organization Owner or Admin on a live
// identity, the set `assign_agent_role` and `revoke_agent_role` accept
// (INV-29). The agent's own per-run and per-day budgets are `get_agent`'s
// `limits`, read from its active version's config the way the host bundle
// reads them (ADR-192), and the organization and workspace ceilings above
// them are read too. No control sets the agent's own budgets here: that waits
// on #4372. The mandates are `list_mandates` narrowed to the agent.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  AgentDetail,
  AgentStatus,
  Toolbelt,
} from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import type { MandateList } from "@/data/contracts/mandates";
import { isEffective } from "@/data/contracts/mandates";
import { compareMicros, ratioOfMicros } from "@/data/contracts/money";
import type { RoleCatalog } from "@/data/contracts/org";
import type { RunRow } from "@/data/contracts/runs";
import type { SpendBudgets } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, ratioWidth } from "@/ui/money-format";
import { BudgetSection } from "./budget-panel";
import { MandatesSection } from "./mandates";
import {
  Facts,
  Instant,
  NotBacked,
  NotRecordedValue,
  Note,
  Panel,
  Sub,
} from "./parts";
import { AssignRole, type RoleTarget, RevokeRole } from "./role-controls";

type Place = { org: string; ws: string; agent: string };

function WireNode({ label, sub }: { label: string; sub?: string }) {
  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-border bg-hl px-3 py-2 text-[13px]">
      <span className={mono}>{label}</span>
      {sub === undefined ? null : (
        <span className="text-xs text-dim">{sub}</span>
      )}
    </li>
  );
}

function Roles({
  detail,
  catalog,
  toolbelt,
  operatorName,
  effectiveMandates,
  manage,
}: {
  detail: AgentDetail;
  catalog: Read<RoleCatalog> | null;
  toolbelt: Read<Toolbelt>;
  operatorName: string | null;
  effectiveMandates: number | null;
  manage: RoleTarget | null;
}) {
  const t = useTranslations("agents.detail.permissions.roles");
  const locale = useLocale();
  const permissionsOf = (id: string, name: string) => {
    if (catalog === null || !catalog.ok) return null;
    return (
      catalog.value.roles.find((role) => role.id === id || role.name === name)
        ?.permissions ?? null
    );
  };
  return (
    <Panel
      id="agent-roles"
      title={t("title")}
      lead={t("lead")}
      aside={manage === null ? undefined : <AssignRole {...manage} />}
    >
      <ol aria-label={t("wire")} className="flex flex-wrap items-center gap-2">
        {detail.roles.map((role) => (
          <WireNode key={role.id} label={role.name} />
        ))}
        <WireNode
          label={operatorName ?? detail.identity.operatorId ?? t("operator")}
          sub={t("operator")}
        />
        <li className="flex min-w-0 flex-col rounded-lg border border-gold/50 bg-gold/10 px-3 py-2 text-[13px]">
          <span>
            {toolbelt.ok
              ? t("belt", {
                  count: formatCount(toolbelt.value.tools.length, locale),
                })
              : t("beltUnread")}
          </span>
          <span className="text-xs text-dim">{t("beltSub")}</span>
        </li>
      </ol>
      <Facts
        rows={[
          ...(detail.roles.length === 0
            ? [{ term: t("none"), value: t("noneValue") }]
            : detail.roles.map((role) => {
                const permissions = permissionsOf(role.id, role.name);
                return {
                  term: role.name,
                  value: (
                    <span className="flex flex-col" data-testid="agent-role">
                      {permissions === null ? (
                        <NotRecordedValue />
                      ) : (
                        <span className={`${mono} text-[11.5px]`}>
                          {permissions.join(" · ")}
                        </span>
                      )}
                      <Sub>
                        {t("scope", { scope: role.scopeKind })}{" "}
                        <Instant at={role.assignedAt} />
                        {role.expiresAt === null ? null : (
                          <>
                            {" · "}
                            {t("expires")} <Instant at={role.expiresAt} />
                          </>
                        )}
                      </Sub>
                      {manage === null ? null : (
                        <span className="mt-1">
                          <RevokeRole {...manage} roleName={role.name} />
                        </span>
                      )}
                    </span>
                  ),
                };
              })),
          { term: t("resourceScope"), value: <NotRecordedValue /> },
          {
            term: t("spendCeiling"),
            value: (
              <span className="flex flex-col">
                {detail.limits.perRun === null ? (
                  <NotRecordedValue />
                ) : (
                  <span>
                    <Money value={detail.limits.perRun} />{" "}
                    <span className="text-xs text-dim">
                      {detail.limits.perRun.currency}
                    </span>
                  </span>
                )}
                <Sub>{t("perRunSub")}</Sub>
                {detail.limits.perDay === null ? null : (
                  <>
                    <span>
                      <Money value={detail.limits.perDay} />{" "}
                      <span className="text-xs text-dim">
                        {detail.limits.perDay.currency}
                      </span>
                    </span>
                    <Sub>{t("perDaySub")}</Sub>
                  </>
                )}
              </span>
            ),
          },
          {
            term: t("moveMoney"),
            value:
              effectiveMandates === null ? (
                <NotRecordedValue />
              ) : effectiveMandates === 0 ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="allowed">{t("no")}</Badge>
                  {t("noValue")}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="approval">
                    {t("mandates", { count: effectiveMandates })}
                  </Badge>
                  {t("mandatesValue")}
                </span>
              ),
          },
        ]}
      />
      <Note>{t("note")}</Note>
    </Panel>
  );
}

function Meter({
  label,
  value,
  ratio,
  note,
}: {
  label: string;
  value: ReactNode;
  ratio: number | null;
  note: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-baseline justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <b>{value}</b>
      </p>
      <span
        aria-hidden="true"
        className="block h-1.5 overflow-hidden rounded-full bg-hl"
      >
        {ratio === null ? null : (
          <span
            className={`block h-full rounded-full ${ratio > 0.8 ? "bg-critical" : "bg-success"}`}
            style={{ width: ratioWidth(ratio) }}
          />
        )}
      </span>
      <p className="text-xs text-dim">{note}</p>
    </div>
  );
}

function Budgets({
  limits,
  runs,
  toolbelt,
  budgets,
  place,
}: {
  limits: AgentDetail["limits"];
  runs: readonly RunRow[];
  toolbelt: Read<Toolbelt>;
  budgets: Read<SpendBudgets> | null;
  place: Place;
}) {
  const t = useTranslations("agents.detail.permissions.budgets");
  const { perRun, perDay } = limits;
  const priced = runs.filter(
    (run): run is RunRow & { cost: NonNullable<RunRow["cost"]> } =>
      run.cost !== null,
  );
  const highest = priced.reduce<(typeof priced)[number] | null>(
    (top, run) =>
      top === null || compareMicros(run.cost, top.cost) > 0 ? run : top,
    null,
  );
  return (
    <Panel id="agent-budgets" title={t("title")} lead={t("lead")}>
      {limits.invalid ? (
        <p role="alert" className="text-[13px] text-foreground">
          {t("invalid")}
        </p>
      ) : null}
      <Meter
        label={t("perRun")}
        value={
          perRun === null ? <NotRecordedValue /> : <Money value={perRun} />
        }
        ratio={
          perRun === null || highest === null
            ? null
            : ratioOfMicros(highest.cost, perRun)
        }
        note={
          highest === null ? (
            t("perRunNone")
          ) : (
            <>
              {t("highest")} <Money value={highest.cost} />
              {" · "}
              {t("basis")}{" "}
              <span className={mono}>
                {highest.cost.basis ?? t("basisNone")}
              </span>
            </>
          )
        }
      />
      {perDay === null ? (
        <NotBacked gap="agent_daily_budget">{t("perDayNone")}</NotBacked>
      ) : (
        <Meter
          label={t("perDay")}
          value={<Money value={perDay} />}
          ratio={null}
          note={t("perDayNote")}
        />
      )}
      <Facts
        rows={[
          { term: t("mode"), value: t("modeValue") },
          { term: t("breach"), value: t("breachValue") },
          {
            term: t("ceiling"),
            value: toolbelt.ok ? (
              t(`ceilingValue.${toolbelt.value.computation.humanCeiling}`)
            ) : (
              <NotRecordedValue />
            ),
          },
        ]}
      />
      {budgets === null ? null : (
        <BudgetSection
          read={budgets}
          spend={routes.spend(place.org, place.ws, { tab: "budgets" })}
        />
      )}
    </Panel>
  );
}

export function PermissionsSection({
  detail,
  toolbelt,
  mandates,
  roles,
  budgets,
  runs,
  operatorName,
  orgRole,
  place,
}: {
  detail: AgentDetail;
  toolbelt: Read<Toolbelt>;
  mandates: Read<MandateList>;
  roles: Read<RoleCatalog> | null;
  budgets: Read<SpendBudgets> | null;
  /** This agent's runs on the newest page of runs read. */
  runs: readonly RunRow[];
  operatorName: string | null;
  orgRole: OrgRole;
  place: Place;
}) {
  const { identity } = detail;
  const status: AgentStatus = identity.status;
  // assign_agent_role and revoke_agent_role are org Owner or Admin writes
  // (INV-29, checked in their handlers), and a retired principal holds no
  // authority to change, so the controls are offered to nobody else.
  const manage: RoleTarget | null =
    (orgRole === "owner" || orgRole === "admin") && status !== "retired"
      ? {
          org: place.org,
          ws: place.ws,
          agentId: identity.id,
          agentSlug: identity.slug,
        }
      : null;
  const effective = mandates.ok
    ? mandates.value.mandates.filter((m) =>
        isEffective(m, new Date(mandates.value.asOf)),
      ).length
    : null;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-permissions-tab">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Roles
          detail={detail}
          catalog={roles}
          toolbelt={toolbelt}
          operatorName={operatorName}
          effectiveMandates={effective}
          manage={manage}
        />
        <Budgets
          limits={detail.limits}
          runs={runs}
          toolbelt={toolbelt}
          budgets={budgets}
          place={place}
        />
      </div>
      <MandatesSection
        read={mandates}
        orgRole={orgRole}
        agentStatus={status}
        org={place.org}
        ws={place.ws}
        agentId={identity.id}
        agentSlug={identity.slug}
        agentKey={identity.agentKey}
      />
    </div>
  );
}
