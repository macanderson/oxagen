// Model fit, first on the Cost tab (pages/run.md, Model fit; the mockup's
// `runFitPanel`): whether the model class and the effort setting were the
// right size for this run, one card each, read by `runFit`, the same reading
// the rig strip's badges print, so the two cannot disagree.
//
// The panel is generated, not the record, and says so in its badge. A reading
// names a capability class, never a model id, and changes nothing on its own:
// a sealed run keeps the model it ran on, and an agent carries no definition
// file to change (ADR-198). No contract changes an agent's model class from
// this page yet, so the card's action is drawn as a stub that says so, never a
// control that silently does nothing.
//
// Effort is never captured today (`fit.ts`, `EffortFit`), so its card names
// why and offers nothing.
import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { Badge } from "@/ui/badge";
import { buttonSecondary } from "@/ui/control-styles";
import { type FitRead, type ModelFit, runFit } from "./fit";
import type { RunMetrics } from "./metrics";
import { Note, Panel, PanelBody } from "./parts";

/** `.btn.sm { padding:4px 9px; font-size:12px; border-radius:7px }` */
const buttonSmall = `${buttonSecondary} min-h-7 rounded-[7px] px-[9px] py-1 text-xs`;

/** `.panel-b b` over `p.muted { margin:6px 0 0; font-size:12.5px }`: a card's title and its reading. */
const cardTitle = "m-0 text-sm font-bold text-foreground";
const cardReading = "mb-0 mt-1.5 text-[12.5px] text-muted-foreground";

function ModelCard({
  model,
  read,
  tier,
}: {
  model: ModelFit | null;
  read: FitRead | null;
  tier: string | null;
}) {
  const t = useTranslations("run.cost.fit");
  if (model === null || read === null) {
    return (
      <PanelBody>
        <div data-testid="fit-model-card">
          <h4 className={cardTitle}>{t("modelTier")}</h4>
          <p className={cardReading}>
            {read === null
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
          <Badge tone="approval">{t("wrongTier")}</Badge>
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
        <div className="mt-2.5 flex flex-wrap items-center gap-[9px]">
          {/* A stub: no contract opens the pull request from this page yet, so
              the button is disabled and the line beside it says what it would do. */}
          <button
            type="button"
            disabled
            aria-describedby="run-fit-move-why"
            data-testid="fit-move"
            className={buttonSmall}
          >
            {t("move", { suggest: model.suggest })}
          </button>
          <span
            id="run-fit-move-why"
            className="min-w-0 text-[11.5px] text-muted-foreground"
          >
            {t("moveStub")}
          </span>
        </div>
      </div>
    </PanelBody>
  );
}

export function ModelFitPanel({
  run,
  metrics,
}: {
  run: RunRow;
  metrics: RunMetrics;
}) {
  const t = useTranslations("run.cost.fit");
  const tRun = useTranslations("run");
  const fit = runFit(run, metrics);
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
        model={fit.model}
        read={fit.read}
        tier={run.model?.tier ?? null}
      />
      <PanelBody>
        <div data-testid="fit-effort-card">
          <h4 className={cardTitle}>{t("effort")}</h4>
          <p className={cardReading}>{t(`effortWhy.${fit.effort.why}`)}</p>
        </div>
      </PanelBody>
      <PanelBody>
        <Note testId="fit-read">
          {fit.read === null
            ? t("readNone")
            : t("read", {
                prompts: fit.read.prompts,
                turns: fit.read.turns,
                steps: fit.read.steps,
                failed: fit.read.failed,
              })}
        </Note>
      </PanelBody>
    </Panel>
  );
}
