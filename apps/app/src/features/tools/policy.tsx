// Policy (mockup `tools.md`, Policy tab): what decides a tool call before it
// leaves. The design's policy versions (G2) have no store: nothing holds a
// version, its rules or its tests, so the panel keeps its heading, the store
// name and Draft a version, and says the versions are not recorded (#3920).
// Where a version lives, the conditions a rule may test and the sequence rule
// describe that store as it is specified, and say so in one line.
//
// Two decision records do exist, and they sit here beside the versions they
// are decided with. The auto-approval rules (ADR-070) let a call the policy
// sent to a person skip them; a receipt cites one as `policy:<id>`. The
// mandates ledger is the financial authority the gate draws on. Both were tabs
// of their own before the tabs became path segments, and their old links land
// here. Create rule is this tab's one gold action.
import { useTranslations } from "next-intl";
import type { ApprovalRuleSet } from "@/data/contracts/tools";
import type { MandateList } from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { AutoApprovals } from "./auto-approvals";
import { type LedgerGrant, MandatesLedger } from "./mandates-ledger";
import { NotBacked } from "./not-backed";
import { StubAction, StubField } from "./stub-action";
import type { ToolsAt } from "./view";

const CONDITIONS = [
  "toolVersion",
  "risk",
  "sideEffect",
  "egress",
  "financialClass",
  "amountByPath",
  "counterparty",
  "repository",
  "pathPrefix",
  "recipientDomain",
  "taint",
  "timeWindow",
  "rate",
  "sequence",
  "operatorRole",
  "enforcementTier",
  "budgetPosition",
  "mandatePosition",
] as const;

const WHERE = [
  "store",
  "regulated",
  "compiledFrom",
  "readBy",
  "writes",
] as const;

function PolicyVersions({ canDraft }: { canDraft: boolean }) {
  const t = useTranslations("tools.policy");
  return (
    <section aria-labelledby="tools-policy-versions" className={panel}>
      <div className={panelHeader}>
        <h2 id="tools-policy-versions" className={panelTitle}>
          {t("versions.title")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`${mono} rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground`}
          >
            tools.policy_versions
          </span>
          {canDraft ? (
            <StubAction
              label={t("versions.draft.open")}
              title={t("versions.draft.title")}
              gap="policy"
              note={t("versions.draft.note")}
              confirm={t("versions.draft.confirm")}
              wide
              testId="tools-policy-draft"
            >
              <StubField
                id="policy-based-on"
                label={t("versions.draft.basedOn")}
              />
              <StubField
                id="policy-what"
                label={t("versions.draft.whatChanged")}
              />
            </StubAction>
          ) : null}
        </div>
      </div>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <NotBacked gap="policy" testId="tools-policy-versions-not-backed">
          {t("versions.notBacked")}
        </NotBacked>
        <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
          {t("versions.note")}
        </p>
      </div>
    </section>
  );
}

function WhereAVersionLives() {
  const t = useTranslations("tools.policy.where");
  return (
    <section aria-labelledby="tools-policy-where" className={panel}>
      <div className={panelHeader}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="tools-policy-where" className={panelTitle}>
            {t("title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("caption")}</p>
        </div>
      </div>
      <dl
        className={`${panelBody} grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]`}
      >
        {WHERE.map((key) => (
          <div key={key} data-fact={key} className="contents">
            <dt className="text-muted-foreground">{t(`terms.${key}`)}</dt>
            <dd className="text-foreground">
              {t.rich(`values.${key}`, {
                code: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Conditions() {
  const t = useTranslations("tools.policy.conditions");
  return (
    <section
      aria-labelledby="tools-policy-conditions"
      className="flex flex-col gap-2"
    >
      <h2
        id="tools-policy-conditions"
        className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {t("title")}
      </h2>
      <ul className="flex flex-wrap gap-1.5">
        {CONDITIONS.map((key) => (
          <li
            key={key}
            className="rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
          >
            {t(`items.${key}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SequenceRule() {
  const t = useTranslations("tools.policy.sequence");
  return (
    <section
      aria-labelledby="tools-policy-sequence"
      className="flex flex-col gap-2"
    >
      <h2
        id="tools-policy-sequence"
        className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {t("title")}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t("plain")}</p>
      <pre
        className={`${mono} overflow-x-auto rounded-xl border border-border bg-card px-4 py-3 text-xs leading-relaxed text-foreground`}
      >
        {[
          "// a payment requires a prior quote call in the same run",
          'forbid (principal, action == Action::"stripe__create_payment", resource)',
          'unless { context.run.has_prior_call("stripe__list_prices") };',
        ].join("\n")}
      </pre>
    </section>
  );
}

export function Policy({
  at,
  orgRole,
  canWriteRules,
  rules,
  mandates,
  grant,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  /** An org Owner or Admin: the three auto-approval writes' role, and who would draft a version. */
  canWriteRules: boolean;
  rules: Read<ApprovalRuleSet>;
  mandates: Read<MandateList>;
  /** Null for a reader no consequence role can name, who is offered no grant. */
  grant: LedgerGrant | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PolicyVersions canDraft={canWriteRules} />
      <AutoApprovals
        at={at}
        orgRole={orgRole}
        canWrite={canWriteRules}
        read={rules}
      />
      <MandatesLedger read={mandates} orgRole={orgRole} at={at} grant={grant} />
      <WhereAVersionLives />
      <Conditions />
      <SequenceRule />
    </div>
  );
}
