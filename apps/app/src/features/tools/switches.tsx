// Kill switches (mockup `tools.md`, Kill switches tab; spec §6.11, ADR-071):
// the class switches with the deny generation, then the scoped switches with
// Create a switch. Each card carries its toggle, what it stops, when it takes
// effect, who flipped it and why.
//
// The organization switch, the workspace switch and the three class switches
// ship with the workspace, so their cards are drawn before anyone flips them.
// A card with no row reads allowing, which is what the record says of a
// target nothing denies. Two of the three class switches, every irreversible
// tool and every tool with third-party egress, have no deny to write:
// `set_kill_switch` stops a class by consequence tag, and side effect and
// egress are not tags. Those two cards say so and carry no toggle (#3866).
//
// A switch someone flipped carries Edit and Remove. Neither has a write: a
// switch row holds its target, and nothing edits or deletes one. Remove on a
// switch that is denying refuses and says to clear it first, because clearing
// records who allowed the traffic and removing would not.
import { useTranslations } from "next-intl";
import {
  type KillSwitch,
  type KillSwitchBoard,
  KILL_SWITCH_BOARD_LIMIT,
  MONEY_TAG,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono, panel } from "@/ui/control-styles";
import { NotBacked } from "./not-backed";
import { Fact, Facts, useDate } from "./parts";
import { ToolsReadFailure } from "./read-failure";
import { StubAction, StubField } from "./stub-action";
import { FlipControls } from "./switch-controls";
import { switchScopeOf, type ToolsAt, toolsLink } from "./view";

/**
 * How many of the switches reaching this workspace are denying right now: the
 * tab's count. It counts what the board holds, so on a truncated board it is a
 * floor and the tab says so.
 */
export function switchesOn(switches: readonly KillSwitch[]): number {
  return switches.filter((s) => s.on).length;
}

type Member = { id: string; name: string | null; email: string };
type Agent = { id: string; slug: string; name: string };

/** Who took a governance action and when; the record carries an id, never a name. */
function Actor({
  userRef,
  at,
  members,
  unrecorded,
}: {
  /** The user id the record holds, or null when it was written by another path. */
  userRef: string | null;
  at: string;
  members: readonly Member[];
  unrecorded: string;
}) {
  const date = useDate();
  const member =
    userRef === null ? undefined : members.find((m) => m.id === userRef);
  return (
    <span className="flex flex-col gap-0.5">
      {member === undefined ? (
        <span className={mono}>{userRef ?? unrecorded}</span>
      ) : (
        <span>{member.name ?? member.email}</span>
      )}
      <span className="text-xs text-muted-foreground">{date(at)}</span>
    </span>
  );
}

/** What a card is headed with: the thing the switch stops, as a person names it. */
function useHeading(
  selfWorkspaceId: string,
  orgName: string,
  wsName: string,
  members: readonly Member[],
  agents: readonly Agent[],
): (target: KillSwitch["target"]) => { title: string; mono: boolean } {
  const t = useTranslations("tools.switches");
  return (target) => {
    switch (target.kind) {
      case "class":
        return { title: t("classTitle", { tag: target.ref }), mono: false };
      case "org":
        return { title: orgName, mono: false };
      case "workspace":
        // A workspace switch is recorded org-wide, so the board carries a
        // sibling workspace's switch too; its uuid is the only thing that
        // says which workspace it denies.
        return target.ref === selfWorkspaceId
          ? { title: wsName, mono: false }
          : { title: target.ref, mono: true };
      case "operator": {
        const member = members.find((m) => m.id === target.ref);
        return member === undefined
          ? { title: target.ref, mono: true }
          : { title: member.name ?? member.email, mono: false };
      }
      case "agent": {
        const agent = agents.find((a) => a.id === target.ref);
        return agent === undefined
          ? { title: target.ref, mono: true }
          : { title: agent.slug, mono: true };
      }
      case "tool_server":
      case "tool_version":
      case "connection":
        return { title: target.ref, mono: true };
    }
  };
}

function Card({
  at,
  heading,
  kind,
  item,
  fixed,
  denyGeneration,
  canFlip,
  members,
  ships,
}: {
  at: ToolsAt;
  heading: { title: string; mono: boolean };
  kind: KillSwitch["target"]["kind"];
  /** The recorded switch, or null for a card that ships with the workspace and has no row. */
  item: KillSwitch | null;
  fixed?: { kind: KillSwitch["target"]["kind"]; ref: string | null };
  denyGeneration: KillSwitchBoard["denyGeneration"];
  canFlip: boolean;
  members: readonly Member[];
  /** True for the five switches that ship with the workspace: no Edit, no Remove. */
  ships: boolean;
}) {
  const t = useTranslations("tools.switches");
  const on = item?.on === true;
  const scope = item?.scope ?? switchScopeOf(kind);
  return (
    <article
      data-switch={item?.id ?? `${kind}:${fixed?.ref ?? "self"}`}
      data-on={on ? "true" : "false"}
      className={`${panel} flex flex-col ${on ? "border-destructive/45" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3
            className={`text-[13.5px] font-semibold text-foreground ${heading.mono ? `${mono} break-all` : ""}`}
          >
            {heading.title}
          </h3>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium">
              {t(`kinds.${kind}`)}
            </span>
            <span>{t(`reach.${kind}`)}</span>
          </p>
        </div>
        {canFlip ? (
          <FlipControls
            at={at}
            denyGeneration={denyGeneration}
            existing={item}
            {...(item === null && fixed !== undefined ? { fixed } : {})}
            label={heading.title}
            members={members}
          />
        ) : (
          <span
            data-state={on ? "denying" : "allowing"}
            className={`text-xs font-medium ${on ? "text-destructive" : "text-muted-foreground"}`}
          >
            {on ? t("denying") : t("allowing")}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <Facts>
          <Fact name="blastRadius" term={t("facts.blastRadius")}>
            {t(`blastRadius.${kind}`)}
          </Fact>
          {item === null ? null : (
            <>
              <Fact name="flippedBy" term={t("facts.flippedBy")}>
                <Actor
                  userRef={item.flippedByRef}
                  at={item.flippedAt}
                  members={members}
                  unrecorded={t("flippedByUnrecorded")}
                />
              </Fact>
              <Fact name="reason" term={t("facts.reason")}>
                {item.reason}
              </Fact>
              {item.clearedAt === null ? null : (
                <Fact name="clearedAt" term={t("facts.clearedAt")}>
                  <Actor
                    userRef={item.clearedByRef}
                    at={item.clearedAt}
                    members={members}
                    unrecorded={t("flippedByUnrecorded")}
                  />
                </Fact>
              )}
            </>
          )}
          <Fact name="takesEffect" term={t("facts.takesEffect")}>
            {t("takesEffect", {
              generation:
                scope === "org" ? denyGeneration.org : denyGeneration.workspace,
            })}
          </Fact>
        </Facts>
        {ships || item === null || !canFlip ? null : (
          <div className="flex flex-wrap gap-2">
            <StubAction
              label={t("edit.open")}
              title={t("edit.title")}
              subtitle={heading.title}
              gap="switches"
              note={t("edit.note")}
              confirm={t("edit.confirm")}
              testId={`tools-switch-edit-${item.id}`}
            >
              <StubField
                id={`edit-reason-${item.id}`}
                label={t("edit.reason")}
              />
            </StubAction>
            <StubAction
              label={t("remove.open")}
              tone="danger"
              title={t("remove.title")}
              subtitle={heading.title}
              gap="switches"
              note={on ? t("remove.refused") : t("remove.note")}
              confirm={t("remove.confirm")}
              testId={`tools-switch-remove-${item.id}`}
            />
          </div>
        )}
      </div>
    </article>
  );
}

/** A class switch the contract has no deny for: side effect and egress are not tags. */
function UnbackedClassCard({ which }: { which: "irreversible" | "egress" }) {
  const t = useTranslations("tools.switches");
  return (
    <article
      data-switch={`class:${which}`}
      className={`${panel} flex flex-col`}
    >
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
        <h3 className="text-[13.5px] font-semibold text-foreground">
          {t(`unbacked.${which}`)}
        </h3>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium">
            {t("kinds.class")}
          </span>
          <span>{t("reach.class")}</span>
        </p>
      </div>
      <div className="px-4 py-3.5">
        <NotBacked gap="switches" testId={`tools-switch-unbacked-${which}`}>
          {t("unbacked.note")}
        </NotBacked>
      </div>
    </article>
  );
}

function CreateSwitch({
  agents,
  members,
}: {
  agents: readonly Agent[];
  members: readonly Member[];
}) {
  const t = useTranslations("tools.switches.create");
  return (
    <StubAction
      label={t("open")}
      title={t("title")}
      gap="switches"
      note={t("note")}
      confirm={t("confirm")}
      testId="tools-switch-new"
    >
      <StubField
        id="switch-scope"
        label={t("scope")}
        options={[t("scopes.agent"), t("scopes.device"), t("scopes.operator")]}
      />
      <StubField
        id="switch-target"
        label={t("target")}
        options={[
          ...agents.map((agent) => agent.slug),
          ...members.map((member) => member.name ?? member.email),
        ]}
      />
      <StubField id="switch-why" label={t("why")} />
    </StubAction>
  );
}

export function Switches({
  at,
  orgRole,
  canFlip,
  selfWorkspaceId,
  orgName,
  wsName,
  members,
  agents,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  canFlip: boolean;
  /** The workspace in view, to tell its own switch from a sibling's. */
  selfWorkspaceId: string;
  orgName: string;
  wsName: string;
  /** The org's members, for the operator scope and for naming who flipped. */
  members: readonly Member[];
  /** The workspace's live agents, for the agent scope and a card's heading. */
  agents: readonly Agent[];
  read: Read<KillSwitchBoard>;
}) {
  const t = useTranslations("tools.switches");
  const heading = useHeading(selfWorkspaceId, orgName, wsName, members, agents);
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
  // The newest row per target: the board lists every flip, and a target
  // flipped twice is one switch.
  const byTarget = new Map<string, KillSwitch>();
  for (const item of switches) {
    const key = `${item.target.kind}:${item.target.ref}`;
    const seen = byTarget.get(key);
    if (seen === undefined || seen.flippedAt < item.flippedAt) {
      byTarget.set(key, item);
    }
  }
  const find = (kind: KillSwitch["target"]["kind"], ref: string | null) =>
    [...byTarget.values()].find(
      (s) =>
        s.target.kind === kind &&
        (ref === null
          ? kind === "org" || s.target.ref === selfWorkspaceId
          : s.target.ref === ref),
    ) ?? null;
  const moneyClass = find("class", MONEY_TAG);
  const orgSwitch = find("org", null);
  const wsSwitch = find("workspace", null);
  const shipped = new Set(
    [moneyClass, orgSwitch, wsSwitch]
      .filter((s): s is KillSwitch => s !== null)
      .map((s) => s.id),
  );
  const rest = [...byTarget.values()].filter((s) => !shipped.has(s.id));
  const otherClasses = rest.filter((s) => s.target.kind === "class");
  const scoped = rest.filter((s) => s.target.kind !== "class");
  const card = (item: KillSwitch) => (
    <Card
      key={item.id}
      at={at}
      heading={heading(item.target)}
      kind={item.target.kind}
      item={item}
      denyGeneration={denyGeneration}
      canFlip={canFlip}
      members={members}
      ships={false}
    />
  );
  return (
    <div className="flex flex-col gap-6">
      {truncated ? (
        <p
          data-state="truncated"
          className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
        >
          {t("truncated", { limit: KILL_SWITCH_BOARD_LIMIT })}
        </p>
      ) : null}
      <section
        aria-labelledby="tools-switches-class"
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="tools-switches-class"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            {t("classHeading")}
          </h2>
          <span
            data-testid="tools-deny-generation"
            className={`${mono} rounded border border-border px-1.5 py-0.5 text-[10.5px] uppercase text-muted-foreground`}
          >
            {t("generationBadge", { generation: denyGeneration.org })}
          </span>
        </div>
        <div className="flex flex-col gap-3">
          <Card
            at={at}
            heading={heading({ kind: "class", ref: MONEY_TAG })}
            kind="class"
            item={moneyClass}
            fixed={{ kind: "class", ref: MONEY_TAG }}
            denyGeneration={denyGeneration}
            canFlip={canFlip}
            members={members}
            ships
          />
          <UnbackedClassCard which="irreversible" />
          <UnbackedClassCard which="egress" />
          {otherClasses.map(card)}
        </div>
      </section>
      <section
        aria-labelledby="tools-switches-scoped"
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="tools-switches-scoped"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            {t("scopedHeading")}
          </h2>
          {canFlip ? <CreateSwitch agents={agents} members={members} /> : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Card
            at={at}
            heading={{ title: orgName, mono: false }}
            kind="org"
            item={orgSwitch}
            fixed={{ kind: "org", ref: null }}
            denyGeneration={denyGeneration}
            canFlip={canFlip}
            members={members}
            ships
          />
          <Card
            at={at}
            heading={{ title: wsName, mono: false }}
            kind="workspace"
            item={wsSwitch}
            fixed={{ kind: "workspace", ref: null }}
            denyGeneration={denyGeneration}
            canFlip={canFlip}
            members={members}
            ships
          />
          {scoped.map(card)}
        </div>
      </section>
    </div>
  );
}
