// One story per badge family, each showing every value it can take.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  EnforcementTier,
  RecordKind,
  ReplayGrade,
  Risk,
  SideEffect,
  Verdict,
} from "@/data/contracts/common";
import { EffectBadge } from "./effect-badge";
import { Gate } from "./gate";
import { GradeBadge } from "./grade-badge";
import { Hazard } from "./hazard";
import { PrincipalKindBadge } from "./principal-kind-badge";
import { RecordKindBadge } from "./record-kind-badge";
import { RiskBadge } from "./risk-badge";
import { StatusBadge } from "./status-badge";
import { TierBadge } from "./tier-badge";
import { VerdictBadge } from "./verdict-badge";
import {
  AgentStatus,
  GateDecision,
  PrincipalKind,
  RunStatus,
} from "@/data/contracts";

const meta = {
  title: "Mission Control/Badges",
  tags: ["autodocs"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-2">{children}</div>
);

export const Tier: Story = {
  render: () => (
    <Row>
      {EnforcementTier.options.map((tier) => (
        <TierBadge key={tier} tier={tier} />
      ))}
      <TierBadge tier={null} />
    </Row>
  ),
};

export const Grade: Story = {
  render: () => (
    <Row>
      {ReplayGrade.options.map((grade) => (
        <GradeBadge key={grade} grade={grade} />
      ))}
      <GradeBadge grade={null} />
    </Row>
  ),
};

export const VerdictValues: Story = {
  name: "Verdict",
  render: () => (
    <Row>
      <VerdictBadge verdict="flipped" flip />
      {Verdict.options.map((verdict) => (
        <VerdictBadge key={verdict} verdict={verdict} />
      ))}
    </Row>
  ),
};

export const Status: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Row>
        {RunStatus.options.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </Row>
      <Row>
        {AgentStatus.options.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </Row>
    </div>
  ),
};

export const RiskAndEffect: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Row>
        {Risk.options.map((risk) => (
          <RiskBadge key={risk} risk={risk} />
        ))}
      </Row>
      <Row>
        {SideEffect.options.map((effect) => (
          <EffectBadge key={effect} effect={effect} />
        ))}
      </Row>
    </div>
  ),
};

export const HazardGlyphs: Story = {
  name: "Hazard",
  render: () => (
    <div className="flex flex-col gap-2">
      <Hazard risk="low" effect="read" />
      <Hazard risk="medium" effect="write" />
      <Hazard risk="high" effect="irreversible" />
      <Hazard risk="critical" />
    </div>
  ),
};

export const Gates: Story = {
  name: "Gate",
  render: () => (
    <Row>
      {GateDecision.options.map((gate) => (
        <Gate key={gate} gate={gate} />
      ))}
    </Row>
  ),
};

export const Kinds: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Row>
        {RecordKind.options.map((kind) => (
          <RecordKindBadge key={kind} kind={kind} />
        ))}
      </Row>
      <Row>
        {PrincipalKind.options.map((kind) => (
          <PrincipalKindBadge key={kind} kind={kind} />
        ))}
      </Row>
    </div>
  ),
};
