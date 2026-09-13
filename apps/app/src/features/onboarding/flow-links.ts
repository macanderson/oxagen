// Hrefs between the steps of the gate and of Register an agent. The chosen org,
// workspace, agent slug, harness and tier ride in the query string, so every
// step is a deep link and Back never loses a choice.
import { AgentSlug } from "./agent-key";
import { type FlowMode, Harness, ModelTier } from "./steps";

export type GateQuery = { org: string; ws: string };
export type AgentChoice = { agent: string; harness: Harness; tier: ModelTier };

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function gateHref(
  step: "organization" | "wrap" | "run",
  q: GateQuery | null,
): string {
  const base = step === "organization" ? "/welcome" : `/welcome/${step}`;
  return q ? `${base}?${new URLSearchParams(q).toString()}` : base;
}

export function registerHref(
  org: string,
  ws: string,
  step: "name" | "wrap" | "run",
  choice: AgentChoice | null,
): string {
  const base = `/${org}/${ws}/register${step === "name" ? "" : `/${step}`}`;
  return choice ? `${base}?${new URLSearchParams(choice).toString()}` : base;
}

export function readGateQuery(params: Params): GateQuery | null {
  const org = one(params, "org");
  const ws = one(params, "ws");
  return org && ws ? { org, ws } : null;
}

/** The register flow's choice from the query, or null when any part is missing or malformed. */
export function readAgentChoice(params: Params): AgentChoice | null {
  const agent = AgentSlug.safeParse(one(params, "agent") ?? "");
  const harness = Harness.safeParse(one(params, "harness") ?? "");
  const tier = ModelTier.safeParse(one(params, "tier") ?? "complex");
  if (!agent.success || !harness.success || !tier.success) return null;
  return { agent: agent.data, harness: harness.data, tier: tier.data };
}

/** The gate names no agent: the installer mints the key from the harness it wraps. */
export function gateAgentChoice(params: Params): AgentChoice {
  const harness = Harness.safeParse(one(params, "harness") ?? "");
  const h = harness.success ? harness.data : "claude-code";
  return {
    agent: h === "claude-code" || h === "codex-cli" ? h : "sdk-agent",
    harness: h,
    tier: "complex",
  };
}

export function flowHref(
  mode: FlowMode,
  step: string,
  ctx: { org: string; ws: string; choice: AgentChoice | null },
): string {
  if (mode === "gate") {
    const gateStep = step === "wrap" || step === "run" ? step : "organization";
    return gateHref(
      gateStep,
      gateStep === "organization" ? null : { org: ctx.org, ws: ctx.ws },
    );
  }
  const registerStep = step === "wrap" || step === "run" ? step : "name";
  return registerHref(
    ctx.org,
    ctx.ws,
    registerStep,
    registerStep === "name" ? null : ctx.choice,
  );
}
