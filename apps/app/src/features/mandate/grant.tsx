// The Grant panel (the design's `pMandate`, right column): the agent, who
// granted the mandate and under which role, the second approver, the
// consequence it answers for, the counterparties and tools it reaches, when a
// person has to answer, and how long it runs.
//
// It is the accountability record, so every field is what was recorded and
// nothing is inferred:
//
//   - A person is named by their name, resolved server-side from the org's
//     members (`list_members`); a reader whose roles cannot read the member
//     list sees the principal id instead, in mono, which is still the fact.
//   - `roleAtGrant` is the role the granter held at the moment of the grant,
//     labelled "at grant" so nobody reads it as current.
//   - A mandate stores no second approver, so that row says so (`NotBacked`)
//     rather than naming a person the record does not hold.
//   - An empty counterparty allow list permits every target the deny list does
//     not name (`targetAllowed`), and an empty approvers list leaves the answer
//     to the roles accountable for the consequence. Both are spelled out,
//     because printing them as empty would say the opposite of what they mean.
//   - The window is half-open, `[validFrom, validTo)`, as enforcement's is. It
//     is printed as days, the design's `2026-09-01 → 2026-12-31`, when each end
//     sits on a day boundary in the viewer's zone, and with its time when it
//     does not, so a mandate ending at 14:00 is never shown as giving the rest
//     of that day (`validDays`).
//   - The agent card's line names the harness from `get_agent`. That read
//     answers no 30-day runs or spend for one agent, so the card says so rather
//     than print the list page's figures for a different read (#3926).
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type { MandateRow } from "@/data/contracts/mandates";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { MandateScope } from "@/ui/mandate-scope";
import { useMeasureText } from "@/ui/measure";
import { SafeLink } from "@/ui/navigation";
import { NotBacked } from "./state";
import { ValidWindow } from "./valid-window";
import type { MandateAt } from "./view";

/** The agent as the agent read resolved it, or null when that read did not answer. */
export type GrantAgent = {
  agentKey: string | null;
  name: string;
  harness: AgentDetail["identity"]["harness"];
} | null;

/** A principal id → the person's name, for the ids this page prints. */
export type PeopleNames = Readonly<Record<string, string>>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-dim">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** A person by name, or their principal id in mono when no name was read. */
function Person({ id, people }: { id: string; people: PeopleNames }) {
  const name = people[id];
  return name === undefined ? (
    <span className={mono} data-person={id}>
      {id}
    </span>
  ) : (
    <span data-person={id}>{name}</span>
  );
}

/**
 * The approval rule as one line, the design's form: "above $100.00, always
 * for moves_funds, approvers role:Billing". Each clause is left out when the
 * rule does not set it, except the approvers: they mean something only once
 * something can park a call, and then an empty list is the consequence roles.
 */
function Approval({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.grant");
  const measureText = useMeasureText();
  const { approval } = mandate;
  const named = approval.humanAbove.length > 1;
  const clauses: ReactNode[] = approval.humanAbove.map((threshold) => {
    // A threshold in a form the mandate's limits establish is printed in that
    // form; one whose form nothing records is printed as the digits the record
    // holds, beside its measure. Neither is guessed into money.
    const value =
      threshold.value === null
        ? threshold.recorded
        : measureText(threshold.value);
    return (
      <span key={`above-${threshold.measure}`} data-approval="above">
        {named || threshold.value === null
          ? t("approvalAboveMeasure", { value, measure: threshold.measure })
          : t("approvalAbove", { value })}
      </span>
    );
  });
  if (approval.alwaysHumanFor.length > 0)
    clauses.push(
      <span key="always" data-approval="always">
        {t("approvalAlways")}{" "}
        <span className={mono}>{approval.alwaysHumanFor.join(", ")}</span>
      </span>,
    );
  if (clauses.length === 0)
    return <span data-approval="none">{t("approvalNone")}</span>;
  clauses.push(
    <span key="approvers" data-approval="approvers">
      {approval.approvers.length === 0 ? (
        t("approvalConsequenceRoles")
      ) : (
        <>
          {t("approvalApprovers")}{" "}
          <span className={mono}>{approval.approvers.join(", ")}</span>
        </>
      )}
    </span>,
  );
  return (
    <span>
      {clauses.map((clause, index) => [index === 0 ? null : ", ", clause])}
    </span>
  );
}

function Counterparties({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.grant");
  if (mandate.targets.length === 0)
    return <span className="text-muted-foreground">{t("anyTarget")}</span>;
  const named = mandate.targets.length > 1;
  return (
    <span className="flex flex-col gap-1">
      {mandate.targets.map((rule) => (
        <span key={rule.measure} data-target={rule.measure}>
          {named ? (
            <span className="block text-xs text-muted-foreground">
              {rule.measure}
            </span>
          ) : null}
          {t("allow")}{" "}
          <span className={mono}>
            {/* An empty allow list permits every target the deny list does
                not name (`targetAllowed`), so it is never printed as none. */}
            {rule.allow.length > 0
              ? rule.allow.join(", ")
              : rule.deny.length === 0
                ? t("allowAnyTarget")
                : t("anyNotDenied")}
          </span>
          <br />
          {t("deny")}{" "}
          <span className={mono}>
            {rule.deny.length === 0 ? t("noPattern") : rule.deny.join(", ")}
          </span>
        </span>
      ))}
    </span>
  );
}

export function MandateGrant({
  mandate,
  agent,
  people,
  at,
}: {
  mandate: MandateRow;
  agent: GrantAgent;
  people: PeopleNames;
  at: MandateAt;
}) {
  const t = useTranslations("mandate.grant");
  const harness = useTranslations("agents.harness");
  return (
    <section
      aria-labelledby="mandate-grant"
      data-testid="mandate-grant"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="mandate-grant" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={panelBody}>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-[12.5px]">
          <Row label={t("agent")}>
            <SafeLink
              to={routes.agent(at.org, at.ws, mandate.agentSlug, {
                tab: "mandates",
              })}
              className="inline-flex max-w-full rounded-lg border border-border px-2.5 py-1.5 hover:bg-hl"
            >
              <AgentCard
                agentKey={agent?.agentKey ?? mandate.agentSlug}
                notRecorded={t("agentNotRecorded")}
                sub={
                  agent === null ? (
                    mandate.agentSlug
                  ) : (
                    <>
                      {harness(agent.harness)}
                      {" · "}
                      <NotBacked gap="agent-activity">
                        {t("agentActivityNotBacked")}
                      </NotBacked>
                    </>
                  )
                }
              />
            </SafeLink>
          </Row>
          <Row label={t("grantedBy")}>
            {mandate.grantedBy === null ? (
              <span className="text-muted-foreground">
                {t("notGranted")}
                {mandate.requestedBy === null ? null : (
                  <>
                    {", "}
                    {t("requestedBy")}{" "}
                    <Person id={mandate.requestedBy} people={people} />
                  </>
                )}
              </span>
            ) : (
              <span data-testid="granted-by">
                <Person id={mandate.grantedBy} people={people} />
                {mandate.roleAtGrant === null ? null : (
                  <>
                    {" · "}
                    <span className={mono}>{mandate.roleAtGrant}</span>{" "}
                    {t("atGrant")}
                  </>
                )}
              </span>
            )}
          </Row>
          <Row label={t("secondApprover")}>
            <NotBacked gap="G1">{t("secondApproverNotBacked")}</NotBacked>
          </Row>
          <Row label={t("effect")}>
            <span className={mono}>{mandate.consequenceTags.join(", ")}</span>
          </Row>
          <Row label={t("counterparties")}>
            <Counterparties mandate={mandate} />
          </Row>
          <Row label={t("tools")}>
            <MandateScope tools={mandate.tools} inline />
          </Row>
          <Row label={t("approval")}>
            <Approval mandate={mandate} />
          </Row>
          <Row label={t("valid")}>
            <ValidWindow
              validFrom={mandate.validFrom}
              validTo={mandate.validTo}
            />
          </Row>
        </dl>
      </div>
    </section>
  );
}
