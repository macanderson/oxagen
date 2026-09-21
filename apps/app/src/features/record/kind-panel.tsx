// The kind panel (#3395; mockups/pages/record.md): one panel per kind, and no
// two alike. Six kinds sharing one generic panel would be the failure this
// page exists to avoid, because the six do not do the same thing — a rule
// steers wording, a constraint can stop a call, a procedure is an order, a
// fact is a claim, a memory is an episode, a preference is a taste. Reading
// them through one frame is what makes an operator treat a preference as a
// rule and a fact as a boundary.
//
// Every panel ends on **What it can never do**: the one sentence that stops
// its kind being read as stronger than it is. A record never grants authority
// (MC spec §10.2), and the six sentences are how the page says so in the
// terms of the kind the reader is looking at.
//
// Kind is an icon and a hue, never a hue alone, and the kind hues never reuse
// a state hue and never use gold: gold is identity on this product and never
// encodes state or class.
import {
  Bookmark,
  Heart,
  ListOrdered,
  type LucideIcon,
  Scale,
  ShieldBan,
  SquareCheckBig,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ConstraintEffect,
  RecordDetail,
  RecordForce,
  RecordKind,
} from "@/data/contracts/steering";
import { eyebrow, mono, panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";

/**
 * A kind's glyph and its hue token. The six hues are the kind palette
 * (`--kind-*` in packages/ui globals.css); none of them is a state hue
 * (success, warning, destructive) and none is the brand gold, so a reader
 * never mistakes what a record IS for how it is DOING.
 */
const KIND_FACE: Record<RecordKind, { icon: LucideIcon; hue: string }> =
  {
    rule: { icon: Scale, hue: "text-kind-rule" },
    constraint: { icon: ShieldBan, hue: "text-kind-constraint" },
    procedure: { icon: ListOrdered, hue: "text-kind-procedure" },
    fact: { icon: SquareCheckBig, hue: "text-kind-fact" },
    memory: { icon: Bookmark, hue: "text-kind-memory" },
    preference: { icon: Heart, hue: "text-kind-preference" },
  };

/** The tinted tile the header and this panel both draw the kind glyph in. */
export function KindGlyph({
  kind,
  size = "md",
}: {
  kind: RecordKind;
  size?: "md" | "sm";
}) {
  const { icon: Icon, hue } = KIND_FACE[kind];
  const box = size === "md" ? "size-11 rounded-xl" : "size-8 rounded-lg";
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={`inline-flex flex-none items-center justify-center border border-border bg-data-surface ${box} ${hue}`}
    >
      <Icon className={size === "md" ? "size-5" : "size-4"} />
    </span>
  );
}

function Panel({
  kind,
  title,
  children,
}: {
  kind: RecordKind;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="record-kind-panel"
      data-testid="record-kind-panel"
      data-kind={kind}
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      <div className="flex items-center gap-3">
        <KindGlyph kind={kind} size="sm" />
        <h2 id="record-kind-panel" className="text-base font-semibold">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Line({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-prose text-sm text-muted-foreground">{children}</p>
  );
}

/**
 * The closing sentence every kind panel carries.
 *
 * It is drawn as a bordered block rather than another paragraph because it is
 * the one claim on the panel that limits the record: a reader skimming for
 * what a rule can do has to meet what it cannot.
 */
function NeverDo({ text }: { text: string }) {
  const t = useTranslations("record.kindPanel");
  return (
    <div
      data-testid="record-kind-never"
      className="mt-1 flex flex-col gap-1 rounded-lg border border-border bg-data-surface px-3 py-2.5"
    >
      <span className={eyebrow}>{t("never")}</span>
      <p className="max-w-prose text-sm text-foreground">{text}</p>
    </div>
  );
}

/**
 * The effect meters: distinct runs that rendered the record, and distinct runs
 * that cited it, counted from the frame rollup rather than from a column.
 *
 * A third meter, the runs that went against the record, is named in the
 * mockup and is not drawn: no store counts a departure, and a meter reading
 * zero would claim every run complied. The panel says the count is not
 * recorded instead.
 *
 * `effect` null is not the same fact as two zeroes: null means this workspace
 * has no context-use rollup at all, and the panel says that rather than
 * printing zeroes that read as every run ignoring the record.
 */
function Meters({
  effect,
  departure,
}: {
  effect: RecordDetail["effect"];
  /** What a run that did not follow this record is called, in the kind's own words. */
  departure: string;
}) {
  const t = useTranslations("record.meters");
  const locale = useLocale();
  if (effect === null) {
    return (
      <p
        data-testid="record-meters"
        data-state="not-recorded"
        className="max-w-prose text-sm text-foreground"
      >
        {t("notRecorded")}
      </p>
    );
  }
  return (
    <dl
      data-testid="record-meters"
      className="grid gap-3 sm:grid-cols-3"
      aria-label={t("label")}
    >
      <Meter
        name="rendered"
        term={t("rendered")}
        value={formatCount(effect.rendered, locale)}
      />
      <Meter
        name="cited"
        term={t("cited")}
        value={formatCount(effect.cited, locale)}
      />
      <Meter name="departed" term={departure} value={t("uncounted")} muted />
    </dl>
  );
}

function Meter({
  name,
  term,
  value,
  muted = false,
}: {
  name: string;
  term: string;
  value: string;
  muted?: boolean;
}) {
  return (
    // A meter is one term and one figure, so it is a `dt` and a `dd`. The
    // `div` groups the pair for the grid; a `dl` whose children are anything
    // else is a definition list a screen reader cannot pair up.
    <div
      data-meter={name}
      className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2"
    >
      <dt className={eyebrow}>{term}</dt>
      <dd
        className={`text-lg font-semibold ${muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** `must`/`should` sit in the bundle's stable prefix; `may`/`info` are selected by relevance. */
function RulePanel({
  force,
  effect,
}: {
  force: RecordForce | null;
  effect: RecordDetail["effect"];
}) {
  const t = useTranslations("record.kindPanel.rule");
  const placement =
    force === "must" || force === "should" ? "prefix" : "relevance";
  return (
    <Panel kind="rule" title={t("title")}>
      <Line>{t("lead")}</Line>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t("placementTerm")}</dt>
        <dd data-placement={placement} className="text-foreground">
          {force === null ? t("placementUnknown") : t(`placement.${placement}`)}
        </dd>
        <dt className="text-muted-foreground">{t("shareTerm")}</dt>
        {/* The bundle's token budget is compiled per version and no read the
            app may make carries it, so the share is stated as not recorded
            rather than estimated from the statement's length. */}
        <dd data-state="not-recorded" className="text-foreground">
          {t("shareNotRecorded")}
        </dd>
      </dl>
      <Meters effect={effect} departure={t("departure")} />
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/**
 * A constraint's boundary, in the state hue, and what it does to a call that
 * crosses it.
 *
 * The honest sentence is the conditional one. A constraint compiles to a gate
 * only where the record carries an enforcement grant; without a grant it
 * compiles to text, and nothing refuses a call because of it. A page that
 * promised enforcement outright would be the most dangerous sentence on this
 * product, so the panel states the condition first and the effect second.
 */
function ConstraintPanel({
  constraintEffect,
  effect,
}: {
  constraintEffect: ConstraintEffect | null;
  effect: RecordDetail["effect"];
}) {
  const t = useTranslations("record.kindPanel.constraint");
  return (
    <Panel kind="constraint" title={t("title")}>
      <div
        data-testid="record-boundary"
        data-effect={constraintEffect ?? "unknown"}
        className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5"
      >
        <span className={eyebrow}>{t("boundary")}</span>
        <p className="text-sm font-medium text-foreground">
          {constraintEffect === null
            ? t("effectUnknown")
            : t(`effect.${constraintEffect}`)}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("dispatch")}
        </p>
      </div>
      <Line>{t("grant")}</Line>
      <Line>{t("conflict")}</Line>
      <Meters effect={effect} departure={t("departure")} />
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/**
 * A procedure's statement as an ordered list, one step per row.
 *
 * The order is the record: a run that did every step in another order did not
 * follow this procedure, so the statement is split on its own lines and
 * numbered rather than shown as a paragraph. A statement written as one line
 * is one step, which is the right answer for a one-step procedure.
 */
function ProcedurePanel({ statement }: { statement: string | null }) {
  const t = useTranslations("record.kindPanel.procedure");
  const steps = (statement ?? "")
    .split("\n")
    .map((step) => step.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((step) => step !== "");
  return (
    <Panel kind="procedure" title={t("title")}>
      <Line>{t("lead")}</Line>
      {steps.length === 0 ? (
        <p data-state="not-recorded" className="text-sm text-foreground">
          {t("noSteps")}
        </p>
      ) : (
        <ol data-testid="record-steps" className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li
              key={step}
              className="flex items-start gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span
                aria-hidden="true"
                className={`${mono} flex-none pt-0.5 text-sm font-semibold text-kind-procedure`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 text-sm text-foreground">{step}</span>
            </li>
          ))}
        </ol>
      )}
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/** A claim, and how it is checked: what would falsify it, and when it became true. */
function FactPanel({
  validFrom,
  effect,
}: {
  /** The merge time of the commit that published it. */
  validFrom: string | null;
  effect: RecordDetail["effect"];
}) {
  const t = useTranslations("record.kindPanel.fact");
  const format = useFormatter();
  return (
    <Panel kind="fact" title={t("title")}>
      <Line>{t("lead")}</Line>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t("falsifiesTerm")}</dt>
        <dd className="text-foreground">{t("falsifies")}</dd>
        <dt className="text-muted-foreground">{t("validFromTerm")}</dt>
        <dd data-fact="valid-from" className="text-foreground">
          {validFrom === null
            ? t("validFromUnknown")
            : format.dateTime(new Date(validFrom), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </dd>
        <dt className="text-muted-foreground">{t("readTerm")}</dt>
        <dd data-fact="read" className="text-foreground">
          {effect === null
            ? t("readNotRecorded")
            : t("read", { runs: effect.rendered })}
        </dd>
      </dl>
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/** An episode: when it happened, what it explains, and that nothing decays it. */
function MemoryPanel({
  happenedAt,
  effect,
}: {
  happenedAt: string | null;
  effect: RecordDetail["effect"];
}) {
  const t = useTranslations("record.kindPanel.memory");
  const format = useFormatter();
  return (
    <Panel kind="memory" title={t("title")}>
      <Line>{t("lead")}</Line>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t("whenTerm")}</dt>
        <dd data-fact="when" className="text-foreground">
          {happenedAt === null
            ? t("whenUnknown")
            : format.dateTime(new Date(happenedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </dd>
        <dt className="text-muted-foreground">{t("selectionTerm")}</dt>
        <dd className="text-foreground">{t("selection")}</dd>
        <dt className="text-muted-foreground">{t("decayTerm")}</dt>
        <dd className="text-foreground">{t("decay")}</dd>
        <dt className="text-muted-foreground">{t("recalledTerm")}</dt>
        <dd data-fact="recalled" className="text-foreground">
          {effect === null
            ? t("recalledNotRecorded")
            : t("recalled", { runs: effect.rendered })}
        </dd>
      </dl>
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/** A taste. Nothing here blocks a call, and not following one is not a failure. */
function PreferencePanel({ effect }: { effect: RecordDetail["effect"] }) {
  const t = useTranslations("record.kindPanel.preference");
  return (
    <Panel kind="preference" title={t("title")}>
      <Line>{t("lead")}</Line>
      <Line>{t("notFollowed")}</Line>
      <Meters effect={effect} departure={t("departure")} />
      <NeverDo text={t("never")} />
    </Panel>
  );
}

/**
 * A record no Context PR classified. It is not a seventh kind and gets no
 * panel of its own: the page says the file carries no kind and stops, because
 * inventing one here would put a classification on screen that the repository
 * does not hold.
 */
function UnclassifiedPanel() {
  const t = useTranslations("record.kindPanel.unclassified");
  return (
    <section
      aria-labelledby="record-kind-panel"
      data-testid="record-kind-panel"
      data-kind="unclassified"
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      <h2 id="record-kind-panel" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p
        data-state="not-recorded"
        className="max-w-prose text-sm text-foreground"
      >
        {t("body")}
      </p>
    </section>
  );
}

/** The panel for this record's kind. Six kinds, six panels, no shared body. */
export function KindPanel({ detail }: { detail: RecordDetail }) {
  const { record, effect, provenance } = detail;
  const publishedAt = provenance?.committedAt ?? record.publishedAt;
  switch (record.kind) {
    case "rule":
      return <RulePanel force={record.force} effect={effect} />;
    case "constraint":
      return (
        <ConstraintPanel
          constraintEffect={record.constraintEffect}
          effect={effect}
        />
      );
    case "procedure":
      return <ProcedurePanel statement={record.statement} />;
    case "fact":
      return <FactPanel validFrom={publishedAt} effect={effect} />;
    case "memory":
      return <MemoryPanel happenedAt={publishedAt} effect={effect} />;
    case "preference":
      return <PreferencePanel effect={effect} />;
    case null:
      return <UnclassifiedPanel />;
  }
}
