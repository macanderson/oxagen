// Auto-approvals (MC spec §6.9 part 2, ADR-070; mockup `tools.md`): the
// workspace's trust-gated rules, each with the tools it applies to, what it
// requires, and what it did in the counting window.
//
// What the mockup draws and this tab does not, because no capability carries
// it:
//
//  - "Qualifying now". `list_approval_rules` does not evaluate a rule against
//    the calls waiting at this moment, and a figure the page computed itself
//    would be a guess dressed as a count.
//  - The "Held by a floor" and "Median wait saved" tiles. Whether a floor
//    held a call is recorded per approval (`get_auto_eligibility`), not
//    aggregated by rule, and no read measures a wait.
//
// `get_auto_eligibility` is also not bound here. It answers for one approval
// request by id, which is a question the approval and its receipt ask, not a
// question a list of rules can.
//
// The two counters are what the contract counts: calls a rule released with
// no person (`hits30d`), and calls that reached a person with the rule read
// beside them (`skipped30d`). The tiles add those up over the rules and add
// nothing else.
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalRule, ApprovalRuleSet } from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell, Table } from "@/ui/table";
import { RuleDelete, RuleEditor, RuleToggle } from "./approval-rule-controls";
import { Chip, Section, StateDot, useDate } from "./parts";
import { ReadFailure } from "./read-failure";
import { type ToolsAt, toolsLink, weekdayKey } from "./view";

const MINUTE_MS = 60_000;

function Tile({
  name,
  title,
  value,
  basis,
}: {
  name: string;
  title: string;
  value: string;
  basis: string;
}) {
  return (
    <dl
      data-tile={name}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-4"
    >
      <dt className="text-xs font-medium text-muted-foreground">{title}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{basis}</dd>
    </dl>
  );
}

function Tiles({ rules, windowDays }: ApprovalRuleSet) {
  const t = useTranslations("tools.autoApprovals.tiles");
  const locale = useLocale();
  const on = rules.filter((rule) => rule.enabled).length;
  const released = rules.reduce((sum, rule) => sum + rule.released, 0);
  const held = rules.reduce((sum, rule) => sum + rule.held, 0);
  return (
    <section aria-label={t("label")} className="grid gap-3 sm:grid-cols-3">
      <Tile
        name="on"
        title={t("on.title")}
        value={formatCount(on, locale)}
        basis={t("on.basis", { total: formatCount(rules.length, locale) })}
      />
      <Tile
        name="released"
        title={t("released.title", { days: windowDays })}
        value={formatCount(released, locale)}
        basis={t("released.basis")}
      />
      <Tile
        name="held"
        title={t("held.title", { days: windowDays })}
        value={formatCount(held, locale)}
        basis={t("held.basis")}
      />
    </section>
  );
}

/** Each condition a rule names, one line apiece, in the order the evaluator reads them. */
function Requires({ rule }: { rule: ApprovalRule }) {
  const t = useTranslations("tools.autoApprovals.requires");
  const days = useTranslations("tools.autoApprovals.days");
  const locale = useLocale();
  const lines: { key: string; text: string }[] = [
    ...Object.entries(rule.maxMeasures).map(([measure, value]) => ({
      key: `max:${measure}`,
      text: t("ceiling", { measure, value }),
    })),
    ...Object.entries(rule.allowTargets).map(([measure, globs]) => ({
      key: `allow:${measure}`,
      text: t("allow", { measure, globs: globs.join(", ") }),
    })),
  ];
  if (rule.standingWindowMs !== null) {
    lines.push({
      key: "standing",
      text: t("standing", {
        minutes: formatCount(
          Math.round(rule.standingWindowMs / MINUTE_MS),
          locale,
        ),
      }),
    });
  }
  if (rule.businessHours !== null) {
    const hours = rule.businessHours;
    lines.push({
      key: "hours",
      text: t("hours", {
        days: hours.days.map((day) => days(weekdayKey(day))).join(", "),
        start: hours.start,
        end: hours.end,
        timezone: hours.timezone,
      }),
    });
  }
  if (lines.length === 0) {
    return (
      <span data-requires="floors-only" className="text-xs text-foreground">
        {t("floorsOnly")}
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-foreground">
      {lines.map((line) => (
        <li key={line.key} data-requires={line.key}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

function Row({
  at,
  rule,
  canWrite,
}: {
  at: ToolsAt;
  rule: ApprovalRule;
  canWrite: boolean;
}) {
  const t = useTranslations("tools.autoApprovals");
  const locale = useLocale();
  const date = useDate();
  return (
    <tr data-rule={rule.slug} data-enabled={rule.enabled ? "true" : "false"}>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{rule.name}</span>
          {rule.disabledReason && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="rule-disabled-reason"
            >
              {t(`disabledReason.${rule.disabledReason.code}`, {
                tool: rule.disabledReason.tool,
              })}
            </span>
          )}
          <span className={`${mono} text-xs text-muted-foreground`}>
            {t("slug", { slug: rule.slug })}
          </span>
          <span className="text-xs text-muted-foreground">
            {rule.lastWrittenBy === null
              ? t("writtenUnattributed", { at: date(rule.lastWrittenAt) })
              : t("written", {
                  at: date(rule.lastWrittenAt),
                  by: rule.lastWrittenBy,
                })}
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-1.5">
          <span className="flex flex-wrap gap-1">
            {rule.tools.map((glob) => (
              <Chip key={glob}>{glob}</Chip>
            ))}
          </span>
          {rule.authoredConsequences === null ? (
            // The evaluator reads a missing stamp as "does not qualify", so
            // the row says the rule releases nothing until it is saved again.
            <span
              data-state="unstamped"
              className="text-xs text-muted-foreground"
            >
              {t("unstamped")}
            </span>
          ) : rule.authoredConsequences.length === 0 ? null : (
            <span className="text-xs text-muted-foreground">
              {t("checkedAgainst", {
                tags: rule.authoredConsequences.join(", "),
              })}
            </span>
          )}
        </span>
      </td>
      <td className={cell}>
        <Requires rule={rule} />
      </td>
      <td className={numericCell}>{formatCount(rule.released, locale)}</td>
      <td className={numericCell}>{formatCount(rule.held, locale)}</td>
      <td className={cell}>
        <span className="flex flex-col items-start gap-2">
          <StateDot
            tone={rule.enabled ? "ok" : "neutral"}
            name={rule.enabled ? "on" : "off"}
            label={rule.enabled ? t("on") : t("off")}
          />
          {canWrite ? <RuleToggle at={at} rule={rule} /> : null}
        </span>
      </td>
      {canWrite ? (
        <td className={cell}>
          <span className="flex flex-wrap gap-2">
            <RuleEditor at={at} existing={rule} />
            <RuleDelete at={at} rule={rule} />
          </span>
        </td>
      ) : null}
    </tr>
  );
}

export function AutoApprovals({
  at,
  orgRole,
  canWrite,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  /** An org Owner or Admin: the roles all three rule writes assert. */
  canWrite: boolean;
  read: Read<ApprovalRuleSet>;
}) {
  const t = useTranslations("tools.autoApprovals");
  if (!read.ok) {
    return (
      <ReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "autoapprovals" })}
      />
    );
  }
  const { rules, windowDays } = read.value;
  const create = canWrite ? <RuleEditor at={at} existing={null} /> : null;

  if (rules.length === 0) {
    return (
      <Section
        id="tools-autoapprovals"
        title={t("empty.title")}
        lead={t("empty.body")}
        actions={create ?? undefined}
        data-state="empty"
      >
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("floors")}
        </p>
      </Section>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Tiles rules={rules} windowDays={windowDays} />
      <Section
        id="tools-autoapprovals"
        title={t("title")}
        lead={t("lead")}
        actions={create ?? undefined}
      >
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.rule") },
            { label: t("columns.appliesTo") },
            { label: t("columns.requires") },
            {
              label: t("columns.released", { days: windowDays }),
              numeric: true,
            },
            { label: t("columns.held", { days: windowDays }), numeric: true },
            { label: t("columns.on") },
            ...(canWrite ? [{ label: t("columns.actions") }] : []),
          ]}
        >
          {rules.map((rule) => (
            <Row key={rule.slug} at={at} rule={rule} canWrite={canWrite} />
          ))}
        </Table>
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("floors")}
        </p>
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("counted", { days: windowDays })}
        </p>
      </Section>
    </div>
  );
}
