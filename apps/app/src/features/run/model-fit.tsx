// Model fit, first on the Cost tab (pages/run.md, Model fit; the mockup's
// `runFitPanel`): whether the model class and the effort setting were the
// right size for this run, one card each. Both cards draw `run.fit`, the
// reading Oxagen computed from the record after the seal (ADR-201), the same
// reading the rig strip's badges print, so the two cannot disagree.
//
// The panel is generated, not the record, and says so in its badge. A reading
// names a capability class, never a model id, and changes nothing on its own:
// a sealed run keeps the model it ran on, and an agent carries no definition
// file to change (ADR-198). No contract changes an agent's model class or
// effort setting from this page yet, so a card that argues for a move draws
// the move as a stub that says so, never a control that silently does
// nothing.
//
// The effort card prints the effort the record holds, from the helper the rig
// prints it from, and the reading's verdict beside it only where the reading
// read that same value.
import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { Badge } from "@/ui/badge";
import { buttonSecondary } from "@/ui/control-styles";
import {
  effortVerdict,
  fitOf,
  type FitRead,
  type ModelFit,
  runEffort,
} from "./fit";
import { Note, Panel, PanelBody } from "./parts";

/** `.btn.sm { padding:4px 9px; font-size:12px; border-radius:7px }` */
const buttonSmall = `${buttonSecondary} min-h-7 rounded-[7px] px-[9px] py-1 text-xs`;

/** `.panel-b b` over `p.muted { margin:6px 0 0; font-size:12.5px }`: a card's title and its reading. */
const cardTitle = "m-0 text-sm font-bold text-foreground";
const cardReading = "mb-0 mt-1.5 text-[12.5px] text-muted-foreground";

/**
 * The move a card argues for, drawn as a stub. No contract makes it from
 * this page yet, so the button is disabled and the line beside it says so.
 */
function MoveStub({
  kind,
  label,
  why,
}: {
  kind: "model" | "effort";
  label: string;
  why: string;
}) {
  const whyId = `run-fit-${kind}-why`;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-[9px]">
      <button
        type="button"
        disabled
        aria-describedby={whyId}
        data-testid={`fit-move-${kind}`}
        className={buttonSmall}
      >
        {label}
      </button>
      <span
        id={whyId}
        className="min-w-0 text-[11.5px] text-muted-foreground"
      >
        {why}
      </span>
    </div>
  );
}

function ModelCard({
  run,
  model,
  read,
  live,
}: {
  run: RunRow;
  model: ModelFit | null;
  read: FitRead | null;
  /** No reading exists for this run: it is live, or its reading is not stored yet. */
  live: boolean | null;
}) {
  const t = useTranslations("run.cost.fit");
  const tier = run.model?.tier ?? null;
  if (model === null || read === null) {
    return (
      <PanelBody>
        <div data-testid="fit-model-card">
          <h4 className={cardTitle}>{t("modelTier")}</h4>
          <p className={cardReading}>
            {live === true
              ? t("live")
              : live === false
                ? t("pending")
                : read === null
                  ? t("noRead")
                  : tier === null
                    ? t("noTier")
                    : t("noLadder", { tier })}
          </p>
        </div>
      </PanelBody>
    );
  }
  if (model.verdict === "fit") {
    return (
      <PanelBody>
        <div data-testid="fit-model-card" data-verdict="fit">
          <h4 className={cardTitle}>{t("modelFit")}</h4>
          <p className={cardReading}>{t("fitSay", { tier: model.tier })}</p>
        </div>
      </PanelBody>
    );
  }
  return (
    <PanelBody>
      <div data-testid="fit-model-card" data-verdict={model.verdict}>
        <div className="flex flex-wrap items-center gap-[9px]">
          <h4 className={cardTitle}>{t("wrongTier")}</h4>
          <Badge tone="approval">{t(`modelVerdict.${model.verdict}`)}</Badge>
        </div>
        <p className={cardReading}>
          {model.verdict === "over"
            ? t("overSay", {
                turns: read.turns,
                steps: read.steps,
                suggest: model.suggest,
              })
            : t("underSay", {
                prompts: read.prompts,
                failed: read.failed,
                tier: model.tier,
                suggest: model.suggest,
              })}
        </p>
        <MoveStub
          kind="model"
          label={t("move", { suggest: model.suggest })}
          why={t("moveStub")}
        />
      </div>
    </PanelBody>
  );
}

function EffortCard({ run }: { run: RunRow }) {
  const t = useTranslations("run.cost.fit");
  const effort = runEffort(run);
  const verdict = effortVerdict(run);
  if (!effort.seen) {
    return (
      <PanelBody>
        <div data-testid="fit-effort-card" data-verdict="unseen">
          <h4 className={cardTitle}>{t(`effortTitle.${effort.why}`)}</h4>
          <p className={cardReading}>{t(`effortWhy.${effort.why}`)}</p>
        </div>
      </PanelBody>
    );
  }
  const source = t(`effortSource.${effort.source}`);
  if (verdict === null || verdict.verdict === "fit") {
    return (
      <PanelBody>
        <div
          data-testid="fit-effort-card"
          data-verdict={verdict === null ? "none" : "fit"}
        >
          <h4 className={cardTitle}>
            {verdict === null ? t("effort") : t("effortFit")}
          </h4>
          <p className={cardReading}>
            {verdict === null
              ? t("effortNoVerdict", { effort: effort.value, source })
              : t("effortFitSay", { effort: effort.value, source })}
          </p>
        </div>
      </PanelBody>
    );
  }
  return (
    <PanelBody>
      <div data-testid="fit-effort-card" data-verdict={verdict.verdict}>
        <div className="flex flex-wrap items-center gap-[9px]">
          <h4 className={cardTitle}>{t("wrongEffort")}</h4>
          <Badge tone="approval">{t(`effortVerdict.${verdict.verdict}`)}</Badge>
        </div>
        <p className={cardReading}>
          {verdict.verdict === "over"
            ? t("effortOverSay", {
                effort: effort.value,
                source,
                suggest: verdict.suggest,
              })
            : t("effortUnderSay", {
                effort: effort.value,
                source,
                suggest: verdict.suggest,
              })}
        </p>
        <MoveStub
          kind="effort"
          label={t("setEffort", { suggest: verdict.suggest })}
          why={t("effortStub")}
        />
      </div>
    </PanelBody>
  );
}

export function ModelFitPanel({ run }: { run: RunRow }) {
  const t = useTranslations("run.cost.fit");
  const tRun = useTranslations("run");
  const fit = fitOf(run);
  const read = fit?.read ?? null;
  return (
    <Panel
      title={t("title")}
      testId="model-fit"
      flush
      aside={
        <Badge tone="quiet" dot={false}>
          <span className="text-[10.5px]">{tRun("summary.generated")}</span>
        </Badge>
      }
    >
      <ModelCard
        run={run}
        model={fit?.model ?? null}
        read={read}
        live={fit === null ? run.status === "live" : null}
      />
      <EffortCard run={run} />
      <PanelBody>
        <Note testId="fit-read">
          {read === null
            ? t("readNone")
            : t("read", {
                prompts: read.prompts,
                turns: read.turns,
                steps: read.steps,
                failed: read.failed,
              })}
        </Note>
      </PanelBody>
    </Panel>
  );
}
