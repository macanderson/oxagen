"use client";
// One finding as the spend spec draws its card (Detectors, and Counting rules
// 3 to 5). The card names the finding and its badges, then leads with its
// amount and its share of the workspace's spend, side by side, and a per-unit
// price where the detector names one. The finding text, who it is about, the
// kind's definition, and what it cites follow, then Evidence and Fix.
//
// The finding contract carries the subject, the runs, the calls, the saving,
// and the detector's own text (`why`). Where those figures fill every value a
// finding text needs, the card writes it from the catalogue. Where the text
// needs a value the contract does not carry, such as a model name or a
// repeated sentence, the card shows the detector's own text, which names it.
// A kind with no entry in CARDS, such as one a later detector adds, draws the
// generic card: the same figures and the detector's own text. A finding about
// an agent draws the agent's avatar with its registered harness (#4871).
import { useLocale, useTranslations } from "next-intl";
import { type Cost, ratioOfMicros } from "@/data/contracts/money";
import type { SpendFinding } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono, panel, statTerm } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatMoney, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { type AgentHarnesses, AgentMark, harnessIn } from "./agent-mark";
import { NotRecordedValue } from "./figures";
import { FixDialog } from "./fix-dialog";
import type { SpendAt } from "./view";

type FindingKind = SpendFinding["kind"];

/** The kinds whose finding text the contract's own figures fill. */
type CatalogueText =
  | "spin_loops"
  | "duplicate_tool_calls"
  | "repeated_shell_commands"
  | "spend_with_no_outcome";

/** How one kind's card differs from the generic card. */
interface CardSpec {
  /**
   * Where the finding text comes from: the catalogue key the contract's
   * figures fill, or `detector` for the detector's own text.
   */
  readonly text: CatalogueText | "detector";
  /** Detector 4 is a counterfactual, so its card says estimated (rule 3). */
  readonly estimated?: true;
  /** The per-unit price the detector names, after the amount and the share (rule 5). */
  readonly unit?: "weeklyPerThousandTokens";
  /** Detector 6 needs prompt text, which a digest_only workspace does not keep (rule 4). */
  readonly needsPromptText?: true;
}

/** The card of a kind with no entry below. */
const GENERIC: CardSpec = { text: "detector" };

/** Each kind's card, as the spec's detector cards word it. */
const CARDS: { readonly [K in FindingKind]?: CardSpec } = {
  cache_writes_never_read: GENERIC,
  duplicate_tool_calls: { text: "duplicate_tool_calls" },
  repeated_shell_commands: { text: "repeated_shell_commands" },
  unpaged_results: GENERIC,
  spin_loops: { text: "spin_loops" },
  standing_context: { text: "detector", unit: "weeklyPerThousandTokens" },
  idle_cache_rewrites: GENERIC,
  cache_busts: GENERIC,
  model_class_fit: { text: "detector", estimated: true },
  repeated_instructions: { text: "detector", needsPromptText: true },
  recurring_runs: GENERIC,
  spend_with_no_outcome: { text: "spend_with_no_outcome" },
};

/** The card a kind draws; the generic card for a kind with no entry. */
function cardOf(kind: FindingKind): CardSpec {
  return CARDS[kind] ?? GENERIC;
}

/**
 * The words repeated_instructions writes into its text on a digest_only
 * workspace (packages/billing/src/findings/repeated-instructions.ts), where
 * it can match only whole prompts. The finding contract carries no retention
 * mode, so the card reads the detector's own words.
 */
const NEEDS_PROMPT_TEXT = "Needs prompt text";

/** Whether a finding's detector could not read prompt text on this workspace. */
function needsPromptText(finding: SpendFinding): boolean {
  return (
    cardOf(finding.kind).needsPromptText === true &&
    finding.why.includes(NEEDS_PROMPT_TEXT)
  );
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
            className="text-[15px] font-semibold leading-tight"
          >
            {/* The finding contract carries no per-unit price yet. */}
            <NotRecordedValue />
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
  if (card.text === "detector")
    return (
      <p data-finding-text="detector" className="text-[13px]">
        {finding.why}
      </p>
    );
  return (
    <p data-finding-text="catalogue" className="text-[13px]">
      {t(card.text, {
        who,
        runs: finding.runs,
        calls: finding.calls,
        amount: formatMoney(finding.saving, { locale, precision: "cents" }),
      })}
    </p>
  );
}

export function FindingCard({
  finding,
  rank,
  names,
  harnesses = {},
  spend,
  at,
}: {
  finding: SpendFinding;
  rank: number;
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
      <span className={`${mono} text-[12px] text-muted-foreground`}>
        {formatCount(rank, locale)}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold">
            {t(`findings.kind.${finding.kind}`)}
          </h3>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t(`findings.level.${finding.level}`)}
          </span>
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${finding.confidence === "high" ? "border-success/45 text-success" : "border-link/45 text-link"}`}
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
          <p className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
            <AgentMark
              agentKey={finding.subject}
              harness={harnessIn(harnesses, finding.subject)}
              size={20}
            />
            <span className={`${mono} min-w-0 truncate`}>{who}</span>
          </p>
        ) : (
          <p
            className={`text-[12.5px] text-muted-foreground ${finding.level === "operator" ? "" : mono}`}
          >
            {who}
          </p>
        )}
        <p className="text-[12px] text-muted-foreground">
          {t(`findings.kindDefinition.${finding.kind}`)}
        </p>
        <p className={`${mono} text-[11px] text-muted-foreground`}>
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
