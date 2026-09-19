// The grant that created this mandate: who asked, who granted it and under
// which role, what consequence it answers for, which counterparties and tools it
// reaches, when a person has to answer, and how long it runs.
//
// It is the accountability record, so every field is what was recorded and
// nothing is inferred. A field the contract may leave unset reads as unset:
// `grantedBy` is null on a draft nobody has granted, and the panel then names
// the operator who asked instead of printing a blank, because a ledger of drafts
// that cannot say who sought the authority is not an accountability record. The
// `roleAtGrant` is the role the granter held at the moment of the grant, not the
// role they hold now: it is the fact the audit needs, and it is labelled as of
// the grant so nobody reads it as current.
//
// The scope and the approval rule are the two fields a reader is most likely to
// misread, so both are stated in full. `MandateScope` calls out a mandate scoped
// to every tool rather than leaving a reader to spot one character in a list, and
// the approval rule is spelled as sentences rather than as a JSON shape: an empty
// `approvers` list is not "nobody", it is "the roles accountable for the
// consequence", and printing it as empty would read as the opposite.
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { MandateRow } from "@/data/contracts/mandates";
import { mono, panel } from "@/ui/control-styles";
import { MandateScope } from "@/ui/mandate-scope";
import { useMeasureText } from "@/ui/measure";

const term = "text-xs font-medium text-muted-foreground";
const value = "text-sm text-foreground";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-4 py-2.5 first:border-t-0">
      <dt className={term}>{label}</dt>
      <dd className={value}>{children}</dd>
    </div>
  );
}

/**
 * The approval rule as sentences. `humanAbove` is a measure-keyed record of
 * thresholds, `alwaysHumanFor` a list of consequence tags, and `approvers` the
 * entries that narrow who may answer. Each is omitted when it is empty rather
 * than printed as an empty list, except `approvers`: empty there means the
 * consequence roles decide, which is a rule and not an absence.
 */
function Approval({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.grant");
  const measureText = useMeasureText();
  const { approval } = mandate;
  return (
    <span className="flex flex-col gap-1">
      {approval.humanAbove.map((threshold) => (
        // A threshold in a form the mandate's limits establish is printed in
        // that form; one whose form nothing records is printed as the digits
        // the record holds, beside its measure. Neither is guessed into money.
        <span key={threshold.measure} data-approval="above">
          {t("approvalAbove", {
            value:
              threshold.value === null
                ? threshold.recorded
                : measureText(threshold.value),
            measure: threshold.measure,
          })}
        </span>
      ))}
      {approval.alwaysHumanFor.length === 0 ? null : (
        <span data-approval="always">
          {t("approvalAlways", { tags: approval.alwaysHumanFor.join(", ") })}
        </span>
      )}
      <span data-approval="approvers">
        {approval.approvers.length === 0
          ? t("approvalConsequenceRoles")
          : t("approvalApprovers", { approvers: approval.approvers.join(", ") })}
      </span>
    </span>
  );
}

export function MandateGrant({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.grant");
  const format = useFormatter();
  return (
    <section
      aria-labelledby="mandate-grant"
      data-testid="mandate-grant"
      className={panel}
    >
      <h2 id="mandate-grant" className="px-4 pb-2 pt-4 text-base font-semibold">
        {t("title")}
      </h2>
      <dl className="pb-2">
        <Row label={t("agent")}>
          <span className={mono}>{mandate.agentSlug}</span>
        </Row>
        <Row label={t("grantedBy")}>
          {mandate.grantedBy === null ? (
            <span className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">{t("notGranted")}</span>
              {mandate.requestedBy === null ? null : (
                <span
                  data-requested-by={mandate.requestedBy}
                  className="text-xs text-muted-foreground"
                >
                  {t("requestedBy", { user: mandate.requestedBy })}
                </span>
              )}
            </span>
          ) : (
            <span className="flex flex-col gap-0.5">
              <span className={`${mono} break-all`}>{mandate.grantedBy}</span>
              {mandate.roleAtGrant === null ? null : (
                <span className="text-xs text-muted-foreground">
                  {t("roleAtGrant", { role: mandate.roleAtGrant })}
                </span>
              )}
            </span>
          )}
        </Row>
        <Row label={t("effect")}>
          <span className={mono}>{mandate.consequenceTags.join(", ")}</span>
        </Row>
        <Row label={t("counterparties")}>
          {mandate.targets.length === 0 ? (
            <span className="text-muted-foreground">{t("anyTarget")}</span>
          ) : (
            <span className="flex flex-col gap-1">
              {mandate.targets.map((rule) => (
                <span
                  key={rule.measure}
                  data-target={rule.measure}
                  className="flex flex-col"
                >
                  <span className="text-xs text-muted-foreground">
                    {rule.measure}
                  </span>
                  <span>
                    {t("allow")}{" "}
                    <span className={`${mono} break-all`}>
                      {rule.allow.length === 0
                        ? t("noPattern")
                        : rule.allow.join(", ")}
                    </span>
                  </span>
                  <span>
                    {t("deny")}{" "}
                    <span className={`${mono} break-all`}>
                      {rule.deny.length === 0
                        ? t("noPattern")
                        : rule.deny.join(", ")}
                    </span>
                  </span>
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label={t("tools")}>
          <MandateScope tools={mandate.tools} />
        </Row>
        <Row label={t("approval")}>
          <Approval mandate={mandate} />
        </Row>
        <Row label={t("valid")}>
          {t("validWindow", {
            from: format.dateTime(new Date(mandate.validFrom), {
              dateStyle: "medium",
            }),
            to: format.dateTime(new Date(mandate.validTo), {
              dateStyle: "medium",
            }),
          })}
        </Row>
      </dl>
    </section>
  );
}
