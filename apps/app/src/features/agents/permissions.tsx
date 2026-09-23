// Permissions (spec pages/agent.md, Permissions): roles, ceilings and
// mandates, which are all limits on the principal. It never lists tools: a
// belt decides what the model is shown, and this tab decides whether a call
// survives.
//
// Roles are `get_agent`'s assignments, with the permission ids each carries
// from the organization's role catalogue when the viewer may read it. Assign
// and Revoke are drawn only for an organization Owner or Admin on a live
// identity, the set `assign_agent_role` and `revoke_agent_role` accept
// (INV-29). The ceilings are the definition file's per-run and per-day
// budgets, read from the committed file, and the organization and workspace
// ceilings above them. The mandates are `list_mandates` narrowed to the agent.
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
import {
  type Money as MoneyValue,
  ratioOfMicros,
} from "@/data/contracts/money";
import type { RoleCatalog } from "@/data/contracts/org";
import type { RunRow } from "@/data/contracts/runs";
import type { SpendBudgets } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { parseTomlSubset, tomlGet } from "@/shared/toml-subset";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
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

/** A micros budget the definition file names under `[budget]` or `budget = {…}`, in USD. */
export function definitionBudget(
  detail: AgentDetail,
  key: "per_run_micros" | "per_day_micros",
): MoneyValue | null {
  const source = detail.definition?.source;
  if (source === undefined) return null;
  const parsed = parseTomlSubset(source);
  if (!parsed.ok) return null;
  const budget = tomlGet(parsed.doc, "budget");
  if (typeof budget !== "object" || Array.isArray(budget)) return null;
  const value = tomlGet(budget, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return null;
  return { micros: String(value), currency: "USD" };
}

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
  const perRun = definitionBudget(detail, "per_run_micros");
  const perDay = definitionBudget(detail, "per_day_micros");
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
                {perRun === null ? (
                  <NotRecordedValue />
                ) : (
                  <span>
                    <Money value={perRun} />{" "}
                    <span className="text-xs text-dim">USD</span>
                  </span>
                )}
                <Sub>{t("perRunSub")}</Sub>
                {perDay === null ? null : (
                  <>
                    <span>
                      <Money value={perDay} />{" "}
                      <span className="text-xs text-dim">USD</span>
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
  detail,
  runs,
  toolbelt,
  budgets,
  place,
}: {
  detail: AgentDetail;
  runs: readonly RunRow[];
  toolbelt: Read<Toolbelt>;
  budgets: Read<SpendBudgets> | null;
  place: Place;
}) {
  const t = useTranslations("agents.detail.permissions.budgets");
  const perRun = definitionBudget(detail, "per_run_micros");
  const perDay = definitionBudget(detail, "per_day_micros");
  const priced = runs.filter(
    (run): run is RunRow & { cost: NonNullable<RunRow["cost"]> } =>
      run.cost !== null,
  );
  const highest = priced.reduce<(typeof priced)[number] | null>(
    (top, run) =>
      top === null || BigInt(run.cost.micros) > BigInt(top.cost.micros)
        ? run
        : top,
    null,
  );
  return (
    <Panel
      id="agent-budgets"
      title={t("title")}
      lead={t("lead")}
      aside={
        <SafeLink
          to={routes.agent(place.org, place.ws, place.agent, {
            tab: "definition",
          })}
          className={buttonSecondary}
        >
          {t("set")}
        </SafeLink>
      }
    >
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
          detail={detail}
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
