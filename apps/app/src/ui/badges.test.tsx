// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
import { renderWithIntl } from "./testing/render-with-intl";
import { TierBadge } from "./tier-badge";
import { VerdictBadge } from "./verdict-badge";
import {
  AgentStatus,
  GateDecision,
  PrincipalKind,
  RunStatus,
} from "./vocabulary";

afterEach(() => {
  cleanup();
});

describe("TierBadge", () => {
  it.each(EnforcementTier.options)("shows the recorded tier %s", (tier) => {
    renderWithIntl(<TierBadge tier={tier} />);
    const badge = screen.getByTestId("tier-badge");
    expect(badge).toHaveTextContent(tier);
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("maps gateway to success and observe to neutral", () => {
    renderWithIntl(
      <>
        <TierBadge tier="gateway" />
        <TierBadge tier="observe" />
      </>,
    );
    const [gateway, observe] = screen.getAllByTestId("tier-badge") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(gateway).toHaveAttribute("data-tone", "success");
    expect(observe).toHaveAttribute("data-tone", "neutral");
  });

  it("says not recorded for a null tier, never a stronger value", () => {
    renderWithIntl(<TierBadge tier={null} />);
    const badge = screen.getByTestId("tier-badge");
    expect(badge).toHaveTextContent("not recorded");
    expect(badge).toHaveAttribute("data-tone", "neutral");
    expect(badge.className).toContain("border-dashed");
    expect(badge).toHaveAttribute(
      "title",
      "No enforcement tier was recorded for this run.",
    );
  });
});

describe("GradeBadge", () => {
  it.each(ReplayGrade.options)("shows the recorded grade %s", (grade) => {
    renderWithIntl(<GradeBadge grade={grade} />);
    expect(screen.getByTestId("grade-badge")).toHaveTextContent(grade);
  });

  it("orders tone by strength: retry is success, inspect is neutral", () => {
    renderWithIntl(
      <>
        <GradeBadge grade="retry" />
        <GradeBadge grade="inspect" />
      </>,
    );
    const [retry, inspect] = screen.getAllByTestId("grade-badge") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(retry).toHaveAttribute("data-tone", "success");
    expect(inspect).toHaveAttribute("data-tone", "neutral");
  });

  it("says not recorded for a null grade", () => {
    renderWithIntl(<GradeBadge grade={null} />);
    expect(screen.getByTestId("grade-badge")).toHaveTextContent("not recorded");
  });
});

describe("VerdictBadge", () => {
  it.each(Verdict.options)(
    "renders %s with a label and description",
    (verdict) => {
      renderWithIntl(<VerdictBadge verdict={verdict} />);
      const badge = screen.getByTestId("verdict-badge");
      expect(badge.textContent).not.toBe("");
      expect(badge.getAttribute("title")).toBeTruthy();
    },
  );

  it("marks tampered as critical and none as no verdict", () => {
    renderWithIntl(
      <>
        <VerdictBadge verdict="tampered" />
        <VerdictBadge verdict="none" />
      </>,
    );
    const [tampered, none] = screen.getAllByTestId("verdict-badge") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(tampered).toHaveAttribute("data-tone", "critical");
    expect(none).toHaveTextContent("no verdict");
  });

  it("shows the fail → pass flourish only on a recorded flip", () => {
    renderWithIntl(
      <>
        <VerdictBadge verdict="flipped" flip />
        <VerdictBadge verdict="flipped" />
        <VerdictBadge verdict="failing" flip />
      </>,
    );
    const [withFlip, withoutFlip, failing] = screen.getAllByTestId(
      "verdict-badge",
    ) as [HTMLElement, HTMLElement, HTMLElement];
    expect(withFlip).toHaveTextContent("flipped fail → pass");
    expect(withoutFlip).not.toHaveTextContent("fail → pass");
    expect(failing).not.toHaveTextContent("fail → pass");
  });
});

describe("StatusBadge", () => {
  it.each([...RunStatus.options, ...AgentStatus.options])(
    "renders %s",
    (status) => {
      renderWithIntl(<StatusBadge status={status} />);
      expect(screen.getByTestId("status-badge").textContent).not.toBe("");
    },
  );

  it("pulses only for a live run, and only when motion is allowed", () => {
    renderWithIntl(
      <>
        <StatusBadge status="live" />
        <StatusBadge status="sealed" />
      </>,
    );
    const [live, sealed] = screen.getAllByTestId("status-badge") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(live.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
    expect(sealed.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
  });

  it("names a parked run as waiting for approval", () => {
    renderWithIntl(<StatusBadge status="parked" />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent(
      "parked for approval",
    );
  });
});

describe("RiskBadge and EffectBadge", () => {
  it.each(Risk.options)("renders risk %s", (risk) => {
    renderWithIntl(<RiskBadge risk={risk} />);
    expect(screen.getByTestId("risk-badge")).toHaveTextContent(risk);
  });

  it.each(SideEffect.options)("renders effect %s", (effect) => {
    renderWithIntl(<EffectBadge effect={effect} />);
    expect(screen.getByTestId("effect-badge")).toHaveTextContent(effect);
  });

  it("reserves the critical tone for critical risk", () => {
    renderWithIntl(
      <>
        <RiskBadge risk="critical" />
        <RiskBadge risk="high" />
      </>,
    );
    const [critical, high] = screen.getAllByTestId("risk-badge") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(critical).toHaveAttribute("data-tone", "critical");
    expect(high).toHaveAttribute("data-tone", "warning");
  });
});

describe("Hazard", () => {
  it("draws the risk mark and the side-effect glyph with their words", () => {
    renderWithIntl(<Hazard risk="high" effect="irreversible" />);
    expect(screen.getByTestId("hazard-risk")).toHaveTextContent("high");
    expect(screen.getByTestId("hazard-risk")).toHaveAttribute(
      "title",
      "risk high",
    );
    expect(screen.getByTestId("hazard-effect")).toHaveTextContent(
      "irreversible",
    );
  });

  it("omits the effect glyph when no effect is given", () => {
    renderWithIntl(<Hazard risk="low" />);
    expect(screen.queryByTestId("hazard-effect")).toBeNull();
  });
});

describe("Gate", () => {
  it.each(GateDecision.options)("renders %s", (gate) => {
    renderWithIntl(<Gate gate={gate} />);
    expect(screen.getByTestId("gate").textContent).not.toBe("");
  });

  it("dashes the gates where a person still stands in the way", () => {
    renderWithIntl(
      <>
        <Gate gate="require_approval" />
        <Gate gate="mandate" />
        <Gate gate="allow" />
      </>,
    );
    const [approval, mandate, allow] = screen.getAllByTestId("gate") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(approval.className).toContain("border-dashed");
    expect(mandate.className).toContain("border-dashed");
    expect(allow.className).not.toContain("border-dashed");
  });

  it("uses the note as the explanation when one is given", () => {
    renderWithIntl(
      <Gate gate="killed" note="flipped by Dana Okafor · credential probe" />,
    );
    expect(screen.getByTestId("gate")).toHaveAttribute(
      "title",
      "flipped by Dana Okafor · credential probe",
    );
    expect(screen.getByTestId("gate")).toHaveTextContent("kill switch");
  });
});

describe("RecordKindBadge and PrincipalKindBadge", () => {
  it.each(RecordKind.options)(
    "renders record kind %s as a neutral icon badge",
    (kind) => {
      renderWithIntl(<RecordKindBadge kind={kind} />);
      const badge = screen.getByTestId("record-kind-badge");
      expect(badge).toHaveTextContent(kind);
      expect(badge).toHaveAttribute("data-tone", "neutral");
      expect(badge.querySelector("svg")).not.toBeNull();
    },
  );

  it.each(PrincipalKind.options)("renders principal kind %s", (kind) => {
    renderWithIntl(<PrincipalKindBadge kind={kind} />);
    expect(screen.getByTestId("principal-kind-badge")).toHaveTextContent(kind);
  });

  it("gives the two kind badges different icons for rule and agent", () => {
    renderWithIntl(
      <>
        <RecordKindBadge kind="rule" />
        <PrincipalKindBadge kind="agent" />
      </>,
    );
    const rule = screen.getByTestId("record-kind-badge").querySelector("svg");
    const agent = screen
      .getByTestId("principal-kind-badge")
      .querySelector("svg");
    expect(rule?.getAttribute("class")).not.toBe(agent?.getAttribute("class"));
  });
});
