"use client";
// One finding as the spend spec draws its card (Detectors, and Counting rules
// 3 to 5). The card names the finding and its badges, then leads with its
// amount and its share of the workspace's spend, side by side, and a per-unit
// price where the detector names one. The finding text, who it is about, the
// kind's definition, and what it cites follow, then Evidence and Fix.
//
// The card writes each kind's finding text from the catalogue, filled from
// the finding's runs, calls, and saving and from the figures the findings job
// stored for the kind (`values`, #5023). Every figure is the job's, so the
// card multiplies nothing (ADR-060). A finding the job wrote before it stored
// values shows the detector's own text (`why`) instead, never a zero. The
// repeat kinds need no values: their text names only the runs, the calls,
// and the saving. A kind with no entry in CARDS, such as one a later detector
// adds, draws the generic card: the same figures and the detector's own text.
// A finding about an agent draws the agent's avatar with its registered
// harness (#4871).
import { useLocale, useTranslations } from "next-intl";
import {
  type Cost,
  type Money as MoneyValue,
  ratioOfMicros,
} from "@/data/contracts/money";
import type { SpendFinding } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono, panel, statTerm } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatMoney, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { type AgentHarnesses, AgentMark, harnessIn } from "./agent-mark";
import { MoneyFigure, NotRecordedValue } from "./figures";
import { FixDialog } from "./fix-dialog";
import type { SpendAt } from "./view";

type FindingKind = SpendFinding["kind"];
type FindingValues = NonNullable<SpendFinding["values"]>;

/** How one kind's card differs from the generic card. */
interface CardSpec {
  /**
   * Where the finding text comes from: `figures` fills the catalogue from
   * the runs, the calls, and the saving; `values` needs the kind's stored
   * values too, and falls back to the detector's text without them;
   * `detector` shows the detector's own text.
   */
  readonly text: "figures" | "values" | "detector";
  /** Detector 4 is a counterfactual, so its card says estimated (rule 3). */
  readonly estimated?: true;
  /** The per-unit price the detector names, after the amount and the share (rule 5). */
  readonly unit?: "weeklyPerThousandTokens";
}

/** The card of a kind with no entry below. */
const GENERIC: CardSpec = { text: "detector" };

/** Each kind's card, as the spec's detector cards word it. */
const CARDS: { readonly [K in FindingKind]?: CardSpec } = {
  cache_writes_never_read: { text: "values" },
  duplicate_tool_calls: { text: "figures" },
  repeated_shell_commands: { text: "figures" },
  unpaged_results: { text: "values" },
  spin_loops: { text: "values" },
  standing_context: { text: "values", unit: "weeklyPerThousandTokens" },
  idle_cache_rewrites: { text: "values" },
  cache_busts: { text: "values" },
  model_class_fit: { text: "values", estimated: true },
  repeated_instructions: { text: "values" },
  recurring_runs: { text: "values" },
  spend_with_no_outcome: { text: "values" },
  retry_loops: { text: "values" },
};

/** The card a kind draws; the generic card for a kind with no entry. */
function cardOf(kind: FindingKind): CardSpec {
  return CARDS[kind] ?? GENERIC;
}

/** The finding's values, when the job stored them for this kind. */
function valuesOf(finding: SpendFinding): FindingValues | null {
  const values = finding.values;
  return values !== undefined && values.kind === finding.kind ? values : null;
}

/**
 * Whether the workspace keeps no prompt text, so prompt habits match whole
 * prompts alone (rule 4). The retention mode the job stored decides it.
 */
function needsPromptText(finding: SpendFinding): boolean {
  const values = valuesOf(finding);
  return (
    values?.kind === "repeated_instructions" &&
    values.retention === "digest_only"
  );
}

/** The per-unit price a card names; null when the job recorded none. */
function unitPrice(finding: SpendFinding): Cost | null {
  const values = valuesOf(finding);
  return values?.kind === "standing_context"
    ? values.weeklyPricePerThousand
    : null;
}

/**
 * The amount for the finding's window and its share of the workspace's spend
 * over the same window, side by side (rule 5). A share the spend does not
 * divide, because no single priced figure was recorded, reads not recorded.
 */
function Figures({
  finding,
  spend,
  card,
}: {
  finding: SpendFinding;
  spend: Cost | null;
  card: CardSpec;
}) {
  const t = useTranslations("spend.findings.card");
  const locale = useLocale();
  const share = spend === null ? null : ratioOfMicros(finding.saving, spend);
  return (
    <dl
      data-testid="finding-figures"
      className="flex flex-wrap items-end gap-x-6 gap-y-2"
    >
      <div className="flex flex-col">
        <dt className={statTerm}>
          {card.estimated === true ? t("estimatedAmount") : t("amount")}
        </dt>
        <dd
          data-figure="amount"
          className="text-2xl font-bold leading-tight tabular-nums"
        >
          <Money value={finding.saving} />
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className={statTerm}>{t("share")}</dt>
        <dd
          data-figure="share"
          className="text-2xl font-semibold leading-tight tabular-nums"
        >
          {share === null ? <NotRecordedValue /> : formatRatio(share, locale)}
        </dd>
      </div>
      {card.unit === undefined ? null : (
        <div className="flex flex-col">
          <dt className={statTerm}>{t(`unit.${card.unit}`)}</dt>
          <dd
            data-figure="unit"
            className="text-base font-semibold leading-tight"
          >
            <MoneyFigure money={unitPrice(finding)} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function FindingText({
  finding,
  who,
  card,
}: {
  finding: SpendFinding;
  who: string;
  card: CardSpec;
}) {
  const t = useTranslations("spend.findings.card.text");
  const locale = useLocale();
  const money = (value: MoneyValue) =>
    formatMoney(value, { locale, precision: "cents" });
  const amount = money(finding.saving);
  const { runs, calls } = finding;

  /** The catalogue's text for a kind that writes from its values. */
  const fromValues = (values: FindingValues): string => {
    switch (values.kind) {
      case "spin_loops":
        return t("spin_loops", {
          who,
          tool: values.tool,
          repeats: values.repeats,
          calls,
          runs,
          amount,
        });
      case "retry_loops":
        return t("retry_loops", {
          who,
          tool: values.tool,
          failures: values.failures,
          calls,
          runs,
          amount,
        });
      case "standing_context": {
        const { provider } = values;
        const lines = [
          t("standing_context.resent", { who, resent: values.resentTokens }),
        ];
        if (provider !== null) {
          lines.push(
            t("standing_context.provider", {
              provider: provider.name,
              tokens: provider.tokens,
              called: provider.toolsCalled,
              tools: provider.tools,
            }),
          );
          if (provider.weeklyPrice !== null)
            lines.push(
              t("standing_context.providerPrice", {
                weekly: money(provider.weeklyPrice),
              }),
            );
        }
        if (values.contextFrameTokens !== null && values.contextFrameTokens > 0)
          lines.push(t("standing_context.contextFrames"));
        return lines.join(" ");
      }
      case "model_class_fit": {
        const args = {
          who,
          model: values.model,
          lighter: values.lighterModel,
          amount,
        };
        if (values.editedRuns === 0)
          return t("model_class_fit.unchanged", {
            ...args,
            runs: values.unchangedRuns,
          });
        if (values.unchangedRuns === 0)
          return t("model_class_fit.edited", {
            ...args,
            edited: values.editedRuns,
          });
        return t("model_class_fit.mixed", {
          ...args,
          unchanged: values.unchangedRuns,
          edited: values.editedRuns,
        });
      }
      case "repeated_instructions":
        return values.sentence === null
          ? t("repeated_instructions.wholePrompt", {
              prompts: values.prompts,
              promptRuns: values.promptRuns,
              others: values.others,
            })
          : t("repeated_instructions.sentence", {
              sentence: values.sentence,
              prompts: values.prompts,
              others: values.others,
            });
      case "recurring_runs":
        return t("recurring_runs", {
          groupSize: values.groupSize,
          unchanged: values.unchanged,
          otherPrompts: values.otherPrompts,
          amount,
        });
      case "spend_with_no_outcome":
        return t("spend_with_no_outcome", {
          who,
          amount,
          runs,
          closedUnmerged: values.closedUnmerged,
          reverted: values.reverted,
          abandoned: values.abandoned,
        });
      case "cache_writes_never_read":
        return t("cache_writes_never_read", {
          who,
          runs,
          tokens: values.writtenTokens,
          amount,
        });
      case "idle_cache_rewrites":
        return t("idle_cache_rewrites", {
          who,
          span:
            values.minWaitMinutes === values.maxWaitMinutes ? "same" : "range",
          min: values.minWaitMinutes,
          max: values.maxWaitMinutes,
          calls,
          average: values.averageTokens,
          coverage: values.pricedRewrites === calls ? "all" : "some",
          priced: values.pricedRewrites,
          keepAlive: money(values.keepAlive),
          rewrites: money(values.rewrites),
          unknown: values.unknownRewrites,
        });
      case "cache_busts":
        return t("cache_busts", {
          who,
          calls,
          // The text reads the part and its count only when a bust recorded one.
          ...(values.firstChange === null || values.firstChangeBusts === null
            ? { first: "unknown" }
            : {
                first: "known",
                part: values.firstChange,
                busts: values.firstChangeBusts,
              }),
          unknown: values.unknownBusts,
          coverage: values.pricedBusts === calls ? "all" : "some",
          priced: values.pricedBusts,
          amount,
        });
      case "unpaged_results":
        return t("unpaged_results", {
          who,
          results: values.results,
          runs,
          calls,
          amount,
          quoted: values.quoted.results,
          bound:
            values.retention === null
              ? "unread"
              : values.retention === "digest_only"
                ? "digestOnly"
                : values.unchecked.results > 0
                  ? "partial"
                  : "none",
          unchecked: values.unchecked.results,
        });
    }
  };

  const values = valuesOf(finding);
  if (card.text === "figures" && finding.kind === "duplicate_tool_calls")
    return (
      <p data-finding-text="catalogue" className="text-sm">
        {t("duplicate_tool_calls", { who, runs, calls, amount })}
      </p>
    );
  if (card.text === "figures" && finding.kind === "repeated_shell_commands")
    return (
      <p data-finding-text="catalogue" className="text-sm">
        {t("repeated_shell_commands", { runs, calls, amount })}
      </p>
    );
  if (card.text === "values" && values !== null)
    return (
      <p data-finding-text="catalogue" className="text-sm">
        {fromValues(values)}
      </p>
    );
  return (
    <p data-finding-text="detector" className="text-sm">
      {finding.why}
    </p>
  );
}

export function FindingCard({
  finding,
  rank,
  cursor = null,
  names,
  harnesses = {},
  spend,
  at,
}: {
  finding: SpendFinding;
  rank: number;
  /** The cursor of the list page the card sits on, so its evidence closes back to that page (#5303). */
  cursor?: string | null;
  /** An operator finding's subject is a `prn_…` id; this is the person's name for it. */
  names: Readonly<Record<string, string>>;
  /** An agent finding's subject is an agent key; this is its harness by key. */
  harnesses?: AgentHarnesses;
  /** The workspace's priced spend over the findings' window; null when none was recorded. */
  spend: Cost | null;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const format = useFormatter();
  const card = cardOf(finding.kind);
  const who =
    finding.level === "operator"
      ? (names[finding.subject] ?? finding.subject)
      : finding.subject;
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  return (
    <li
      data-finding={finding.id}
      data-kind={finding.kind}
      data-confidence={finding.confidence}
      data-level={finding.level}
      className={`${panel} grid gap-4 p-4 md:grid-cols-[2rem_minmax(0,1fr)_auto]`}
    >
      <span className={`${mono} text-sm text-muted-foreground`}>
        {formatCount(rank, locale)}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">
            {t(`findings.kind.${finding.kind}`)}
          </h3>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {t(`findings.level.${finding.level}`)}
          </span>
          <span
            className={`rounded-md border px-1.5 py-0.5 text-xs font-semibold ${finding.confidence === "high" ? "border-success/45 text-success" : "border-link/45 text-link"}`}
          >
            {t(`findings.confidence.${finding.confidence}`)}
          </span>
          {card.estimated === true ? (
            <Badge tone="quiet" dot={false} data-badge="estimated">
              {t("findings.card.estimated")}
            </Badge>
          ) : null}
          {needsPromptText(finding) ? (
            <Badge tone="approval" data-badge="needs-prompt-text">
              {t("findings.card.needsPromptText")}
            </Badge>
          ) : null}
        </div>
        <Figures finding={finding} spend={spend} card={card} />
        <FindingText finding={finding} who={who} card={card} />
        {finding.level === "agent" ? (
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <AgentMark
              agentKey={finding.subject}
              harness={harnessIn(harnesses, finding.subject)}
              size={20}
            />
            <span className={`${mono} min-w-0 truncate`}>{who}</span>
          </p>
        ) : (
          <p
            className={`text-sm text-muted-foreground ${finding.level === "operator" ? "" : mono}`}
          >
            {who}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {t(`findings.kindDefinition.${finding.kind}`)}
        </p>
        <p className={`${mono} text-xs text-muted-foreground`}>
          {t("findings.evidenceLine", {
            runs: formatCount(finding.runs, locale),
            calls: formatCount(finding.calls, locale),
            from: day(finding.window.from),
            to: day(finding.window.to),
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2 md:flex-col md:items-end">
        <SafeLink
          to={routes.spend(at.org, at.ws, {
            tab: "findings",
            finding: finding.id,
            cursor: cursor ?? undefined,
          })}
          className={buttonSecondary}
        >
          {t("findings.evidence.open")}
        </SafeLink>
        <FixDialog
          at={at}
          findingId={finding.id}
          fix={finding.fix}
          contextDescription={t("findings.fix.draft", {
            id: finding.id,
            subject: finding.subject,
            from: finding.window.from,
            to: finding.window.to,
            amount: formatMoney(finding.saving, {
              locale,
              precision: "exact",
            }),
            currency: finding.saving.currency,
            basis:
              finding.saving.basis === null
                ? t("basisNotRecorded")
                : t(`basis.${finding.saving.basis}`),
            runs: formatCount(finding.runs, locale),
            calls: formatCount(finding.calls, locale),
            fix: finding.fix,
            why: finding.why,
          })}
        />
      </div>
    </li>
  );
}
