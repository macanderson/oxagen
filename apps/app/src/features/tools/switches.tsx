// Kill switches (#2958; spec §6.11, ADR-071): deny is available at every
// level, and every switch that has ever been flipped in this workspace is a
// card here — allowing or denying, what it stops, when it takes effect, who
// flipped it and why.
//
// The record only knows the switches that exist. A level nobody has ever
// flipped has no row, so the levels themselves are drawn as the wire above the
// cards — the same order the mockup draws, class outermost — and the gold "Flip
// a kill switch" action is how a level with no row gets one.
import { useTranslations } from "next-intl";
import {
  type KillSwitch,
  type KillSwitchBoard,
  KILL_SWITCH_KINDS,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono, panel } from "@/ui/control-styles";
import { Fact, Facts, Section, StateDot, useDate } from "./parts";
import { ReadFailure } from "./read-failure";
import { FlipControls } from "./switch-controls";
import { type ToolsAt, toolsLink } from "./view";

/** How many of the workspace's switches are denying right now: the tab's count. */
export function switchesOn(switches: readonly KillSwitch[]): number {
  return switches.filter((s) => s.on).length;
}

/**
 * The two kinds whose target this page already names: there is one
 * organization and one workspace in view, so their database uuid identifies
 * nothing the heading has not said. Every other kind prints its target — for
 * an operator that uuid is the only identification the record carries.
 */
const SELF_EVIDENT: ReadonlySet<KillSwitch["target"]["kind"]> = new Set([
  "workspace",
  "org",
]);

function SwitchCard({
  at,
  denyGeneration,
  item,
  canFlip,
}: {
  at: ToolsAt;
  denyGeneration: KillSwitchBoard["denyGeneration"];
  item: KillSwitch;
  canFlip: boolean;
}) {
  const t = useTranslations("tools.switches");
  const date = useDate();
  const selfEvident = SELF_EVIDENT.has(item.target.kind);
  return (
    <article
      data-switch={item.id}
      data-on={item.on ? "true" : "false"}
      className={`${panel} flex flex-col gap-3 p-5 ${item.on ? "border-destructive/45" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t(`kinds.${item.target.kind}`)}
          </h3>
          {selfEvident ? null : (
            <p className={`${mono} break-all text-xs text-muted-foreground`}>
              {item.target.ref}
            </p>
          )}
        </div>
        <StateDot
          tone={item.on ? "deny" : "ok"}
          name={item.on ? "denying" : "allowing"}
          label={item.on ? t("denying") : t("allowing")}
        />
      </div>
      <Facts>
        <Fact name="blastRadius" term={t("facts.blastRadius")}>
          {t(`blastRadius.${item.target.kind}`)}
        </Fact>
        <Fact name="takesEffect" term={t("facts.takesEffect")}>
          {t("takesEffect", {
            generation:
              item.scope === "org"
                ? denyGeneration.org
                : denyGeneration.workspace,
          })}
        </Fact>
        {item.on ? (
          <>
            <Fact name="flippedBy" term={t("facts.flippedBy")}>
              <span className="flex flex-col gap-0.5">
                <span className={mono}>
                  {item.flippedByRef ?? t("flippedByUnrecorded")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {date(item.flippedAt)}
                </span>
              </span>
            </Fact>
            <Fact name="reason" term={t("facts.reason")}>
              {item.reason}
            </Fact>
          </>
        ) : item.clearedAt === null ? null : (
          <Fact name="clearedAt" term={t("facts.clearedAt")}>
            {date(item.clearedAt)}
          </Fact>
        )}
      </Facts>
      {canFlip ? (
        <FlipControls at={at} denyGeneration={denyGeneration} existing={item} />
      ) : null}
    </article>
  );
}

function LevelWire() {
  const t = useTranslations("tools.switches");
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {KILL_SWITCH_KINDS.map((kind) => (
        <li
          key={kind}
          data-level={kind}
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground"
        >
          {t(`kinds.${kind}`)}
        </li>
      ))}
    </ol>
  );
}

export function Switches({
  at,
  orgRole,
  canFlip,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  canFlip: boolean;
  read: Read<KillSwitchBoard>;
}) {
  const t = useTranslations("tools.switches");
  if (!read.ok) {
    return (
      <ReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "switches" })}
      />
    );
  }
  const { denyGeneration, switches } = read.value;
  const classSwitches = switches.filter((s) => s.target.kind === "class");
  const scoped = switches.filter((s) => s.target.kind !== "class");
  return (
    <div className="flex flex-col gap-4">
      <Section
        id="tools-switches"
        title={t("title")}
        lead={t("lead")}
        actions={
          canFlip ? (
            <FlipControls
              at={at}
              denyGeneration={denyGeneration}
              existing={null}
            />
          ) : null
        }
      >
        <LevelWire />
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("generation", {
            org: denyGeneration.org,
            workspace: denyGeneration.workspace,
          })}
        </p>
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("noNames")}
        </p>
        {switches.length === 0 ? (
          <p data-state="empty" className="text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : null}
      </Section>
      {classSwitches.length === 0 ? null : (
        <section
          aria-labelledby="tools-switches-class"
          className="flex flex-col gap-2"
        >
          <h2
            id="tools-switches-class"
            className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("classHeading")}
          </h2>
          <div className="flex flex-col gap-3">
            {classSwitches.map((item) => (
              <SwitchCard
                key={item.id}
                at={at}
                denyGeneration={denyGeneration}
                item={item}
                canFlip={canFlip}
              />
            ))}
          </div>
        </section>
      )}
      {scoped.length === 0 ? null : (
        <section
          aria-labelledby="tools-switches-scoped"
          className="flex flex-col gap-2"
        >
          <h2
            id="tools-switches-scoped"
            className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("scopedHeading")}
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {scoped.map((item) => (
              <SwitchCard
                key={item.id}
                at={at}
                denyGeneration={denyGeneration}
                item={item}
                canFlip={canFlip}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
