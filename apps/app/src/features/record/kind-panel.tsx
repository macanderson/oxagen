// The kind panel (#3395; mockups/pages/record.md, mockup `crecPanel`): one
// panel per kind, and no two alike. Six kinds sharing one generic panel would
// be the failure this page exists to avoid, because the six do not do the
// same thing: a rule steers wording, a constraint can stop a call, a procedure
// is an order, a fact is a claim, a memory is an episode, a preference is a
// taste. Reading them through one frame is what makes an operator treat a
// preference as a rule and a fact as a boundary.
//
// Every panel opens on how the kind reaches a run and ends on what it can
// never do: the one sentence that stops its kind being read as stronger than
// it is. A record never grants authority (MC spec §10.2).
//
// The meters are the record's attribution (§12.7), never a score. Rendered is
// the total; cited and the third meter are shares of it. No store counts the
// third meter yet (runs that went against, crossed or departed from a
// record), so it reads as not recorded rather than a zero that would claim
// every run complied.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ConstraintEffect,
  RecordDetail,
  RecordForce,
  RecordKind,
} from "@/data/contracts/steering";
import { Badge } from "@/ui/badge";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { KIND_FACE, KindBadge } from "./kind";
import { RECORD_GAPS } from "./gaps";
import { note } from "./styles";

type Effect = RecordDetail["effect"];

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;
const strong = (chunks: ReactNode) => <b>{chunks}</b>;

/** `.eyebrow.q`: a panel's section eyebrow. */
const sectionEyebrow =
  "mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

/** `.kv`: a two-column definition list. */
const kv =
  "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:text-foreground";

function Panel({ kind, children }: { kind: RecordKind; children: ReactNode }) {
  const term = useTranslations("ui.record");
  return (
    <section
      aria-labelledby="record-kind-panel"
      data-testid="record-kind-panel"
      data-kind={kind}
      className={panel}
    >
      <div className={`${panelHeader} justify-start`}>
        <h2 id="record-kind-panel" className={panelTitle}>
          {term(`kinds.${kind}`)}
        </h2>
        <KindBadge kind={kind} />
      </div>
      <div className={`${panelBody} flex flex-col`}>{children}</div>
    </section>
  );
}

/** The eyebrow and note every panel opens with. */
function Deliver({
  kind,
  first = true,
}: {
  kind: RecordKind;
  first?: boolean;
}) {
  const t = useTranslations("record.kindPanel");
  return (
    <div data-testid="record-deliver" className={first ? "" : "mt-3.5"}>
      <p className={sectionEyebrow}>{t("deliverEyebrow")}</p>
      <p className={`${note} mb-3.5`}>{t.rich(`deliver.${kind}`, { code })}</p>
    </div>
  );
}

/** The closing line: what the kind can never do. */
function NeverDo({ kind }: { kind: RecordKind }) {
  const t = useTranslations("record.kindPanel");
  return (
    <p
      data-testid="record-kind-never"
      className={`${note} mt-3.5 border-error`}
    >
      <b className="text-foreground">{t("never")} </b>
      {t.rich(`neverDo.${kind}`, { code })}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className={sectionEyebrow}>{title}</p>
      {children}
    </div>
  );
}

/**
 * `.meter`: a label, the figure as "N of total", and a bar. `value` null is
 * a count no store keeps; the bar is empty and the figure says so.
 */
function Meter({
  name,
  label,
  value,
  total,
  tone,
}: {
  name: string;
  label: string;
  value: number | null;
  total: number;
  /** The bar's hue: the default allowed green, proven teal, failed red, or grey. */
  tone: "allowed" | "proven" | "failed" | "grey";
}) {
  const t = useTranslations("record.meters");
  const locale = useLocale();
  const share =
    value === null || total === 0 ? 0 : Math.round((value / total) * 100);
  const fill = {
    allowed: "bg-success",
    proven: "bg-proven",
    failed: "bg-error",
    grey: "bg-rule",
  }[tone];
  return (
    <li data-meter={name} className="grid gap-[5px]">
      <span className="flex text-[11.5px] text-muted-foreground">
        {label}
        <span className="ms-auto font-semibold tabular-nums text-foreground">
          {value === null ? (
            <span data-state="not-recorded" className="font-normal text-dim">
              {t("notRecorded")}
            </span>
          ) : (
            t.rich("of", {
              value: formatCount(value, locale),
              total: formatCount(total, locale),
              dim: (chunks) => <span className="text-dim">{chunks}</span>,
            })
          )}
        </span>
      </span>
      <div
        aria-hidden="true"
        className="mt-1 h-1.5 overflow-hidden rounded-[3px] bg-hl"
      >
        <i
          className={`block h-full rounded-[3px] ${fill}`}
          style={{ width: `${String(share)}%` }}
        />
      </div>
    </li>
  );
}

/** The three meters. The third names the kind's own word for not following it. */
function Meters({
  effect,
  third,
  thirdTone,
}: {
  effect: Effect;
  third: string;
  thirdTone: "failed" | "grey";
}) {
  const t = useTranslations("record.meters");
  if (effect === null) {
    return (
      <p
        data-testid="record-meters"
        data-state="not-recorded"
        className="mt-3.5 text-[13px] text-muted-foreground"
      >
        {t("rollupNotRecorded")}
      </p>
    );
  }
  return (
    <div data-testid="record-meters" className="mt-3.5 grid gap-2.5">
      <ul aria-label={t("label")} className="grid gap-2.5">
        <Meter
          name="rendered"
          label={t("rendered")}
          value={effect.rendered}
          total={effect.rendered}
          tone="allowed"
        />
        <Meter
          name="cited"
          label={t("cited")}
          value={effect.cited}
          total={effect.rendered}
          tone="proven"
        />
        <Meter
          name="third"
          label={third}
          value={null}
          total={effect.rendered}
          tone={thirdTone}
        />
      </ul>
      <p
        data-state="not-recorded"
        data-gap={RECORD_GAPS.violated}
        className="text-[11.5px] text-dim"
      >
        {t("thirdNotRecorded")}
      </p>
    </div>
  );
}

/** A rule: where it sits in the bundle, then its three meters. */
function RulePanel({
  force,
  constraintEffect,
  bundleVersion,
  effect,
}: {
  force: RecordForce | null;
  constraintEffect: ConstraintEffect | null;
  bundleVersion: number | null;
  effect: Effect;
}) {
  const t = useTranslations("record.kindPanel.rule");
  const placement =
    force === "must" || force === "should" ? "prefix" : "relevance";
  return (
    <Panel kind="rule">
      <Deliver kind="rule" />
      <Section title={t("whereEyebrow")}>
        <dl className={kv}>
          <dt>{t("force")}</dt>
          <dd data-placement={force === null ? "unknown" : placement}>
            {force === null ? (
              <span data-state="not-recorded">{t("forceUnknown")}</span>
            ) : (
              <>
                <span className={mono}>{force}</span>
                {`: ${t(`placement.${placement}`)}`}
              </>
            )}
          </dd>
          {constraintEffect === null ? null : (
            <>
              <dt>{t("effect")}</dt>
              <dd>
                <Badge
                  tone={constraintEffect === "forbid" ? "denied" : "approval"}
                  dot={false}
                >
                  {constraintEffect}
                </Badge>
              </dd>
            </>
          )}
          <dt>{t("bundle")}</dt>
          <dd data-state="not-recorded" data-gap={RECORD_GAPS.bundle}>
            {bundleVersion === null
              ? t("bundleNotRecorded")
              : t.rich("bundleVersion", {
                  version: bundleVersion,
                  code,
                })}
          </dd>
        </dl>
      </Section>
      <Meters effect={effect} third={t("third")} thirdTone="failed" />
      <NeverDo kind="rule" />
    </Panel>
  );
}

/**
 * A constraint's boundary, in the state hue for its effect, and what it does
 * to a call that crosses it. No record carries an enforcement grant yet (no
 * store records one), so a `forbid` compiles to text and the panel says that
 * nothing refuses a call because of it.
 */
function ConstraintPanel({
  constraintEffect,
  publishedTotal,
  effect,
}: {
  constraintEffect: ConstraintEffect | null;
  publishedTotal: number | null;
  effect: Effect;
}) {
  const t = useTranslations("record.kindPanel.constraint");
  const locale = useLocale();
  const tone =
    constraintEffect === "require"
      ? "border-info/45 bg-info/9 [&_[data-word]]:text-info"
      : "border-warning/45 bg-warning/9 [&_[data-word]]:text-warning";
  return (
    <Panel kind="constraint">
      <div
        data-testid="record-boundary"
        data-effect={constraintEffect ?? "unknown"}
        data-grant="none"
        className={`mb-3.5 grid gap-1.5 rounded-[10px] border px-3.5 py-3 ${tone}`}
      >
        <span
          data-word=""
          className="font-mono text-[13px] font-semibold uppercase tracking-[0.06em]"
        >
          {constraintEffect ?? t("effectUnknownWord")}
        </span>
        <span className="text-[12.3px] leading-normal text-foreground">
          {constraintEffect === "require"
            ? t("boundary.require")
            : constraintEffect === "forbid"
              ? t("boundary.forbidNoGrant")
              : t("boundary.unknown")}
        </span>
      </div>
      <Deliver kind="constraint" />
      <Section title={t("conflictsEyebrow")}>
        <p className={note}>
          {publishedTotal === null
            ? t.rich("conflictsNoCount", { code })
            : t.rich("conflicts", {
                count: formatCount(publishedTotal, locale),
                code,
              })}
        </p>
      </Section>
      <Meters effect={effect} third={t("third")} thirdTone="failed" />
      <NeverDo kind="constraint" />
    </Panel>
  );
}

/**
 * The procedure's statement as an ordered list, one step per row. A
 * statement written as numbered lines splits on its numbers; one written as a
 * sentence splits on its commas and full stops after the colon, the way the
 * mockup reads "Cut a release in this order: freeze main, dry-run the
 * migrations, tag, then publish the notes."
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function procedureSteps(statement: string | null): string[] {
  const text = (statement ?? "").trim();
  if (text === "") return [];
  const capital = (step: string) =>
    step.charAt(0).toUpperCase() + step.slice(1);
  if (/(^|\n)\s*(\d+[.)]|[-*])\s/.test(text))
    return text
      .split("\n")
      .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
      .filter((line) => line !== "")
      .map(capital);
  const colon = /:\s*([\s\S]*)$/.exec(text);
  const body = colon?.[1] ?? text;
  return body
    .split(/,\s*(?:then\s+)?|\.\s+/)
    .map((step) =>
      step
        .replace(/^(then|and)\s+/i, "")
        .replace(/\.$/, "")
        .trim(),
    )
    .filter((step) => step !== "")
    .map(capital);
}

function ProcedurePanel({ statement }: { statement: string | null }) {
  const t = useTranslations("record.kindPanel.procedure");
  const steps = procedureSteps(statement);
  return (
    <Panel kind="procedure">
      <Deliver kind="procedure" />
      <Section title={t("stepsEyebrow")}>
        {steps.length === 0 ? (
          <p data-state="not-recorded" className="text-[13px]">
            {t("noSteps")}
          </p>
        ) : (
          <ol
            data-testid="record-steps"
            className={`grid list-decimal gap-2 pl-5 ${KIND_FACE.procedure.marker} marker:font-bold marker:tabular-nums`}
          >
            {steps.map((step, index) => (
              <li
                key={`${String(index)}-${step}`}
                className="pl-1 text-[13px] leading-normal text-foreground"
              >
                {step}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <p className={`${note} mt-3`}>{t("order")}</p>
      <NeverDo kind="procedure" />
    </Panel>
  );
}

function FactPanel({
  validFrom,
  commit,
  effect,
}: {
  validFrom: string | null;
  commit: string | null;
  effect: Effect;
}) {
  const t = useTranslations("record.kindPanel.fact");
  const format = useFormatter();
  const locale = useLocale();
  return (
    <Panel kind="fact">
      <Deliver kind="fact" />
      <Section title={t("claimEyebrow")}>
        <dl className={kv}>
          <dt>{t("falsifiable")}</dt>
          <dd data-state="not-recorded">{t("falsifiableNotRecorded")}</dd>
          <dt className={mono}>{t("validFrom")}</dt>
          <dd data-fact="valid-from">
            {validFrom === null ? (
              <span data-state="not-recorded">{t("validFromNotRecorded")}</span>
            ) : (
              t.rich("validFromValue", {
                date: format.dateTime(new Date(validFrom), {
                  dateStyle: "medium",
                }),
                commit: commit ?? "",
                code,
              })
            )}
          </dd>
          <dt>{t("lastConfirmed")}</dt>
          <dd data-fact="confirmed">
            {effect === null ? (
              <span data-state="not-recorded">
                {t("lastConfirmedNotRecorded")}
              </span>
            ) : (
              t("lastConfirmedValue", {
                runs: formatCount(effect.cited, locale),
              })
            )}
          </dd>
          <dt>{t("steers")}</dt>
          <dd>{t("steersValue")}</dd>
        </dl>
      </Section>
      <p className={`${note} mt-3`}>{t("note")}</p>
      <NeverDo kind="fact" />
    </Panel>
  );
}

function MemoryPanel({
  recordedAt,
  effect,
}: {
  recordedAt: string | null;
  effect: Effect;
}) {
  const t = useTranslations("record.kindPanel.memory");
  const format = useFormatter();
  const locale = useLocale();
  return (
    <Panel kind="memory">
      <Deliver kind="memory" />
      <Section title={t("whenEyebrow")}>
        <dl className={kv}>
          <dt>{t("recorded")}</dt>
          <dd data-fact="recorded">
            {recordedAt === null ? (
              <span data-state="not-recorded">{t("recordedNotRecorded")}</span>
            ) : (
              format.dateTime(new Date(recordedAt), { dateStyle: "medium" })
            )}
          </dd>
          <dt>{t("explains")}</dt>
          <dd data-state="not-recorded">{t("explainsNotRecorded")}</dd>
          <dt>{t("selection")}</dt>
          <dd data-fact="selection">
            {effect === null
              ? t("selectionValue")
              : t("selectionShare", {
                  cited: formatCount(effect.cited, locale),
                  rendered: formatCount(effect.rendered, locale),
                })}
          </dd>
          <dt>{t("decay")}</dt>
          <dd data-fact="decay">{t("decayValue")}</dd>
        </dl>
      </Section>
      <NeverDo kind="memory" />
    </Panel>
  );
}

function PreferencePanel({ effect }: { effect: Effect }) {
  const t = useTranslations("record.kindPanel.preference");
  return (
    <Panel kind="preference">
      <Deliver kind="preference" />
      <Section title={t("softEyebrow")}>
        <p className={note}>{t.rich("soft", { strong })}</p>
      </Section>
      <Meters effect={effect} third={t("third")} thirdTone="grey" />
      <NeverDo kind="preference" />
    </Panel>
  );
}

/**
 * A record no Context PR classified. It is not a seventh kind: the page says
 * the file carries no kind and stops, because inventing one would put a
 * classification on screen the repository does not hold.
 */
function UnclassifiedPanel() {
  const t = useTranslations("record.kindPanel.unclassified");
  return (
    <section
      aria-labelledby="record-kind-panel"
      data-testid="record-kind-panel"
      data-kind="unclassified"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="record-kind-panel" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <p
        data-state="not-recorded"
        className={`${panelBody} text-[13px] text-foreground`}
      >
        {t("body")}
      </p>
    </section>
  );
}

/** The panel for this record's kind. Six kinds, six panels, no shared body. */
export function KindPanel({
  detail,
  bundleVersion,
  publishedTotal,
}: {
  detail: RecordDetail;
  /** The workspace's compiled bundle version; null when it could not be read. */
  bundleVersion: number | null;
  /** How many records are published in the workspace; null when unread. */
  publishedTotal: number | null;
}) {
  const { record, effect, provenance } = detail;
  const publishedAt = provenance?.committedAt ?? record.publishedAt;
  const commit = (provenance?.commit ?? record.commit)?.slice(0, 7) ?? null;
  switch (record.kind) {
    case "rule":
      return (
        <RulePanel
          force={record.force}
          constraintEffect={record.constraintEffect}
          bundleVersion={bundleVersion}
          effect={effect}
        />
      );
    case "constraint":
      return (
        <ConstraintPanel
          constraintEffect={record.constraintEffect}
          publishedTotal={publishedTotal}
          effect={effect}
        />
      );
    case "procedure":
      return <ProcedurePanel statement={record.statement} />;
    case "fact":
      return (
        <FactPanel validFrom={publishedAt} commit={commit} effect={effect} />
      );
    case "memory":
      return <MemoryPanel recordedAt={publishedAt} effect={effect} />;
    case "preference":
      return <PreferencePanel effect={effect} />;
    case null:
      return <UnclassifiedPanel />;
  }
}
