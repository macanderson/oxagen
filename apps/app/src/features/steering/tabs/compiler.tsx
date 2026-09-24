// The Compiler: what one agent receives for one prompt (roadmap
// pages/steering-compiler.md). The controls, the two meters, the three parts
// named by their injection points, Manifest cuts and the closing note, in the
// design's order; "Nothing to compile yet" when no record is published, and
// "No agent in this workspace is set up for preview." when no agent is
// enrolled.
//
// What is read today: the enrolled agents (list_agents, ../agents-read.ts),
// which fill the Agent select, and whether any record is published, which the
// hub already read. What is not: the assembly. No capability runs
// assembleSteering for one agent and one prompt (#3879), and no store holds
// the six preview prompts, the budget, an agent's tier, its repository or the
// repository's skill sync state. So every figure and row the assembler would
// produce prints "not recorded" under a NotBacked panel naming the issue.
// Nothing here repaints a result nobody computed.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { Badge } from "@/ui/badge";
import { eyebrow, panel, panelBody } from "@/ui/control-styles";
import { CreateButton } from "@/ui/create-button";
import { readSteeringAgents, type SteeringAgents } from "../agents-read";
import {
  type CompilerAgentOption,
  CompilerControls,
} from "../compiler-controls";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";
import { TabEmpty } from "../page-state";
import { SteeringReadFailure } from "../read-failure";
import { code, Note, TabPanel, Unrecorded } from "../tab-parts";
import { type SteeringAt, steeringLink } from "../view";

export async function CompilerTab({
  ctx,
  source,
  at,
  agent,
  published,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  /** The agent the URL names, or null on `/steering/compiler`. */
  agent: string | null;
  /** Records in force, from the hub's own read. */
  published: number;
}) {
  if (published === 0) return <CompilerEmpty />;
  const agents = await readSteeringAgents(ctx, source);
  return <CompilerBody at={at} agent={agent} read={agents} />;
}

/** "Nothing to compile yet"; its Write a context record is the screen's one gold action. */
function CompilerEmpty() {
  const t = useTranslations("steering.bodies.compiler.empty");
  const create = useTranslations("steering.create");
  return (
    <TabEmpty
      testId="compiler-empty"
      title={t("title")}
      action={<CreateButton kind="record" label={create("record")} />}
    >
      {t("body")}
    </TabEmpty>
  );
}

function Meter({ id, label }: { id: string; label: string }) {
  return (
    <section
      aria-labelledby={id}
      className={`${panel} ${panelBody} flex flex-col gap-2`}
      data-meter={id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={id} className="text-[12.5px] text-muted-foreground">
          {label}
        </h3>
        <Unrecorded issue={STEERING_GAPS.assembler} />
      </div>
    </section>
  );
}

function Part({
  id,
  title,
  tally,
  sub,
}: {
  id: string;
  title: string;
  tally: string;
  sub: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-1.5"
      data-part={id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={id} className={eyebrow}>
          {title}
        </h3>
        <span className="font-mono text-[11px] text-dim">{tally}</span>
      </div>
      <p className="text-[12.5px] text-muted-foreground">{sub}</p>
      <Unrecorded issue={STEERING_GAPS.assembler} />
    </section>
  );
}

function CompilerBody({
  at,
  agent,
  read,
}: {
  at: SteeringAt;
  agent: string | null;
  read: Read<SteeringAgents>;
}) {
  const t = useTranslations("steering.bodies.compiler");
  const harness = useTranslations("agents.harness");
  if (!read.ok) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="tab-compiler">
        <SteeringReadFailure read={read} section={t("agent")} />
      </div>
    );
  }
  const { agents } = read.value;
  if (agents.length === 0) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="tab-compiler">
        <p
          className={`${panel} ${panelBody} text-[13px] text-muted-foreground`}
          data-state="no-agent"
        >
          {t("noAgent")}
        </p>
      </div>
    );
  }
  const selected =
    agents.find((a) => a.slug === agent)?.slug ?? agents[0]?.slug ?? "";
  const options: CompilerAgentOption[] = agents.map((a) => ({
    slug: a.slug,
    label: t("option", { name: a.name, harness: harness(a.harness) }),
    to: steeringLink(at, { tab: "compiler", agent: a.slug }),
  }));
  const issue = String(STEERING_GAPS.assembler);
  return (
    <div
      className="flex flex-col gap-3.5"
      data-testid="tab-compiler"
      data-agent={selected}
    >
      <NotBacked
        testId="compiler-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.assembler}
      />
      <div className={`${panel} ${panelBody} flex flex-col gap-3`}>
        <CompilerControls
          agents={options}
          selected={selected}
          hint={t("hint", { issue })}
        />
        <div
          role="group"
          aria-label={t("chips")}
          className="flex flex-wrap items-center gap-2"
          data-testid="compiler-chips"
        >
          <Unrecorded issue={STEERING_GAPS.assembler} />
        </div>
      </div>
      <div className="grid gap-3.5 md:grid-cols-2">
        <Meter id="compiler-meter-prefix" label={t("prefixMeter")} />
        <Meter id="compiler-meter-volatile" label={t("volatileMeter")} />
      </div>
      <div className={`${panel} ${panelBody} flex flex-col gap-5`}>
        <Part
          id="compiler-part-prefix"
          title={t("parts.prefix.title")}
          tally={t("parts.prefix.tally")}
          sub={t.rich("parts.prefix.sub", { code })}
        />
        <Part
          id="compiler-part-volatile"
          title={t("parts.volatile.title")}
          tally={t("parts.volatile.tally")}
          sub={t.rich("parts.volatile.sub", { code })}
        />
        <Part
          id="compiler-part-skills"
          title={t("parts.skills.title")}
          tally={t("parts.skills.tally")}
          sub={t("parts.skills.sub")}
        />
      </div>
      <TabPanel
        id="compiler-cuts"
        title={t("cutsTitle")}
        testId="compiler-cuts"
        badge={
          <Badge tone="quiet" dot={false}>
            {t.rich("cutsBadge", { code })}
          </Badge>
        }
      >
        <div className={`${panelBody} flex flex-col gap-2.5`}>
          <Unrecorded issue={STEERING_GAPS.assembler} />
          <Note testId="compiler-closing">{t.rich("closing", { code })}</Note>
        </div>
      </TabPanel>
    </div>
  );
}
