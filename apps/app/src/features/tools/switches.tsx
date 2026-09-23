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
  KILL_SWITCH_BOARD_LIMIT,
  KILL_SWITCH_KINDS,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono, panel } from "@/ui/control-styles";
import { Fact, Facts, Section, StateDot, useDate } from "./parts";
import { ToolsReadFailure } from "./read-failure";
import { FlipControls } from "./switch-controls";
import { type ToolsAt, toolsLink } from "./view";

/**
 * How many of the switches reaching this workspace are denying right now: the
 * tab's count. It counts what the board holds, so on a truncated board it is a
 * floor and the tab says so.
 */
export function switchesOn(switches: readonly KillSwitch[]): number {
  return switches.filter((s) => s.on).length;
}

/**
 * Whether the heading alone names this switch's target.
 *
 * The organization in view is the only one a switch can name, so an org switch
 * needs no id. A workspace switch is recorded org-wide (it reaches past the
 * workspace it was flipped in), so the board here also carries the workspace
 * switches of sibling workspaces, and for those the uuid is the only thing
 * that says which workspace is denied, so it is printed. Every other kind
 * prints its target; for an operator that is their `usr_…` public id (#3147).
 */
function headingNamesTarget(
  target: KillSwitch["target"],
  selfWorkspaceId: string,
): boolean {
  if (target.kind === "org") return true;
  return target.kind === "workspace" && target.ref === selfWorkspaceId;
}

/** Who took a governance action and when; the record carries an id, never a name. */
function Actor({
  userRef,
  at,
  unrecorded,
}: {
  /** The user id the record holds, or null when it was written by another path. */
  userRef: string | null;
  at: string;
  unrecorded: string;
}) {
  const date = useDate();
  return (
    <span className="flex flex-col gap-0.5">
      <span className={mono}>{userRef ?? unrecorded}</span>
      <span className="text-xs text-muted-foreground">{date(at)}</span>
    </span>
  );
}

function SwitchCard({
  at,
  denyGeneration,
  item,
  canFlip,
  selfWorkspaceId,
  members,
}: {
  at: ToolsAt;
  denyGeneration: KillSwitchBoard["denyGeneration"];
  item: KillSwitch;
  canFlip: boolean;
  selfWorkspaceId: string;
  members: readonly { id: string; name: string | null; email: string }[];
}) {
  const t = useTranslations("tools.switches");
  const selfEvident = headingNamesTarget(item.target, selfWorkspaceId);
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
        {/* Who imposed the deny and why, on a switch that is denying and on one
            that was: clearing a switch does not rewrite either (`reason` stays
            the deny's; the clearing reason goes to a column this read does not
            carry), so dropping them off the cleared card dropped the whole
            history of the deny rather than the part that had ended. */}
        <Fact name="flippedBy" term={t("facts.flippedBy")}>
          <Actor
            userRef={item.flippedByRef}
            at={item.flippedAt}
            unrecorded={t("flippedByUnrecorded")}
          />
        </Fact>
        <Fact name="reason" term={t("facts.reason")}>
          {item.reason}
        </Fact>
        {item.clearedAt === null ? null : (
          <Fact name="clearedAt" term={t("facts.clearedAt")}>
            {/* Lifting a deny is the action that restores access, so the board
                names who took it exactly as it names who imposed it. */}
            <Actor
              userRef={item.clearedByRef}
              at={item.clearedAt}
              unrecorded={t("flippedByUnrecorded")}
            />
          </Fact>
        )}
      </Facts>
      {canFlip ? (
        <FlipControls
          at={at}
          denyGeneration={denyGeneration}
          existing={item}
          members={members}
        />
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
  selfWorkspaceId,
  members,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  canFlip: boolean;
  /** The workspace in view, to tell its own switch from a sibling's. */
  selfWorkspaceId: string;
  /** The org's members, for the operator level's picker (#3147). */
  members: readonly { id: string; name: string | null; email: string }[];
  read: Read<KillSwitchBoard>;
}) {
  const t = useTranslations("tools.switches");
  if (!read.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "switches" })}
      />
    );
  }
  const { denyGeneration, switches, truncated } = read.value;
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
              members={members}
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
        {truncated ? (
          <p
            data-state="truncated"
            className="max-w-prose rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
          >
            {t("truncated", { limit: KILL_SWITCH_BOARD_LIMIT })}
          </p>
        ) : null}
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
                selfWorkspaceId={selfWorkspaceId}
                members={members}
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
                selfWorkspaceId={selfWorkspaceId}
                members={members}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
