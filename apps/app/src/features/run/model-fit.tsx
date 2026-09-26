// Model fit, first on the Cost tab (pages/run.md, Model fit; the mockup's
// `runFitPanel`): whether the model class and the effort setting were the
// right size for this run, one card each. Both cards draw `run.fit`, the
// reading Oxagen computed from the record after the seal (ADR-194), the same
// reading the rig strip's badges print, so the two cannot disagree.
//
// The panel is generated, not the record, and says so in its badge. A reading
// names a capability class, never a model id, and changes nothing on its own:
// a card that argues for a move offers it as a Context pull request against
// the agent's definition file (`fit-change.tsx`), and a sealed run keeps the
// model it ran on.
//
// The effort card prints the effort the record holds, from the helper the rig
// prints it from, and the reading's verdict beside it only where the reading
// read that same value.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import {
  effortVerdict,
  fitOf,
  type FitRead,
  type ModelFit,
  runEffort,
} from "./fit";
import { definitionPath, FitChange } from "./fit-change";
import { Note, Panel, PanelBody } from "./parts";
import type { Place } from "./tab-props";

/** `.panel-b b` over `p.muted { margin:6px 0 0; font-size:12.5px }`: a card's title and its reading. */
const cardTitle = "m-0 text-sm font-bold text-foreground";
const cardReading = "mb-0 mt-1.5 text-[12.5px] text-muted-foreground";
const cardAction = "mt-2.5";

/**
 * The file a reading argues against: the path the agent's last committed
 * definition was recorded at, else `.oxagen/agents/<slug>.toml`, where a
 * definition is committed. Null when the agent was not read, and the note
 * says "the agent definition" rather than naming a path it cannot see.
 */
function definitionFile(agent: Read<AgentDetail> | null): string | null {
  if (agent === null || !agent.ok) return null;
  return definitionPath(agent.value.identity, agent.value.definition);
}

type Move = {
  agent: Read<AgentDetail> | null;
  place: Place;
  orgRole: OrgRole;
};

function ModelCard({
  run,
  model,
  read,
  live,
  move,
}: {
  run: RunRow;
  model: ModelFit | null;
  read: FitRead | null;
  /** No reading exists for this run: it is live, or its reading is not stored yet. */
  live: boolean | null;
  move: Move;
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
        <div className={cardAction}>
          <FitChange
            kind="model"
            today={run.model?.slug ?? model.tier}
            suggest={model.suggest}
            {...move}
          />
        </div>
      </div>
    </PanelBody>
  );
}

function EffortCard({ run, move }: { run: RunRow; move: Move }) {
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
        <div className={cardAction}>
          <FitChange
            kind="effort"
            today={effort.value}
            suggest={verdict.suggest}
            {...move}
          />
        </div>
      </div>
    </PanelBody>
  );
}

export function ModelFitPanel({
  run,
  agent,
  place,
  orgRole,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
  place: Place;
  /** The viewer's organization role: the change is refused below Member. */
  orgRole: OrgRole;
}) {
  const t = useTranslations("run.cost.fit");
  const tRun = useTranslations("run");
  const fit = fitOf(run);
  const file = definitionFile(agent);
  const fileNode = () =>
    file === null ? t("fileFallback") : <span className={mono}>{file}</span>;
  const move = { agent, place, orgRole };
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
        move={move}
      />
      <EffortCard run={run} move={move} />
      <PanelBody>
        <Note testId="fit-read">
          {read === null
            ? t.rich("readNone", { file: fileNode })
            : t.rich("read", {
                prompts: read.prompts,
                turns: read.turns,
                steps: read.steps,
                failed: read.failed,
                file: fileNode,
              })}
        </Note>
      </PanelBody>
    </Panel>
  );
}
