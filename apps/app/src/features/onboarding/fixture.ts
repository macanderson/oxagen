// Onboarding fixture data, ported from the Register Agent gate in mc.html @
// mc-baseline-w1 (REG_TOKEN, REG_HOST, regLines, the installer builds). Read only
// through ./reads.ts, which serves it in fixture mode and nothing else.
// Promote: lane L1's fixture seed.
// Shared with the sign-in flows in the same lane; imported relatively because the
// auth barrel carries server-only modules this file must not pull into a client graph.
import { FIXTURE_ORG, FIXTURE_WORKSPACE } from "../auth/fixture";
import { FIXTURE_USER } from "@/server/fixture-session";
import type {
  DetectedRepository,
  FirstFrameScript,
  FlowScope,
  InstallerOffer,
} from "./model";

export const FIXTURE_SCOPE: FlowScope = {
  org: { ...FIXTURE_ORG },
  ws: { ...FIXTURE_WORKSPACE },
  operator: { name: FIXTURE_USER.name, email: FIXTURE_USER.email },
};

const HOST = "mbell-mbp.local";

export const FIXTURE_INSTALLER: InstallerOffer = {
  token: "oxe_1time_7QK4M2NV9XR3T8ZP",
  tokenExpiresInMinutes: 30,
  host: HOST,
  sdkCredentialMasked: "oxa_live_••••••••••••3f7a",
  builds: {
    macos: {
      file: "Oxagen-Agent-2.4.0.pkg",
      size: "14.2 MB",
      signature: "notarized · Developer ID",
      digest: "sha256:3f9c71d2…b40a",
    },
    windows: {
      file: "Oxagen-Agent-2.4.0.msi",
      size: "16.8 MB",
      signature: "signed · EV certificate",
      digest: "sha256:7a21ce55…19f3",
    },
    linux: {
      file: "oxagen-agent_2.4.0_amd64.deb",
      size: "12.9 MB",
      signature: "deb, rpm and curl script",
      digest: "sha256:c40b8e19…62dd",
    },
  },
};

export function fixtureFirstFrameScript(
  key: string,
  harness: string,
  operator: string,
): FirstFrameScript {
  return {
    host: HOST,
    tier: "gateway",
    paceMs: 780,
    log: [
      { at: "14:01:48", text: "host enrolled · device key ed25519:7f3a…c19e" },
      {
        at: "14:01:52",
        text: "collector oxagend running · pid 4412 · launchd com.oxagen.oxagend",
      },
      {
        at: "14:01:55",
        text: "hooks written · ~/.claude/settings.json · 7 events",
      },
      {
        at: "14:01:58",
        text: "ANTHROPIC_BASE_URL set · https://proxy.oxagen.com/v1",
      },
      { at: "14:02:01", text: "model proxy reachable · 41 ms · tier gateway" },
      { at: "14:02:04", text: "MCP endpoint registered · 0 tools granted yet" },
      {
        at: "14:02:11",
        text: "frame received · seq 0 · agent.start",
        firstFrame: true,
      },
    ],
    frames: [
      {
        seq: "0",
        at: "14:02:11.402",
        kind: "agent.start",
        body: `harness=${harness} · host=${HOST} · attested=device-key`,
      },
      {
        seq: "1",
        at: "14:02:11.418",
        kind: "context.assembled",
        body: `agent=${key} · operator=${operator} · tier=gateway · steering=none published`,
      },
    ],
  };
}

export const FIXTURE_REPOSITORY: DetectedRepository = {
  fullName: "acme/platform",
  remote: "git@github.com:acme/platform.git",
  directory: "~/src/platform",
  branch: "main",
  provisionalDays: 14,
};
