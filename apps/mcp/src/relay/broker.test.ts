// broker.test.ts: how the MCP server builds its relay broker (lane M12).
import { generateKeyPairSync } from "node:crypto";
import { RELAY_SIGNING_KEY_ENV, type RelayTokenVerifier } from "@oxagen/relay-broker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRelayBroker, relayStatusLogger } from "./broker";
import type { RelayBrokerState } from "./transport";

const VERIFIER: RelayTokenVerifier = { verify: async () => null };

const built: RelayBrokerState[] = [];

afterEach(async () => {
  while (built.length > 0) {
    const state = built.pop();
    if (state?.broker) await state.broker.close();
  }
});

function build(env: Record<string, string | undefined>): RelayBrokerState {
  const state = buildRelayBroker(env, VERIFIER);
  built.push(state);
  return state;
}

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("buildRelayBroker", () => {
  it("builds no broker when the environment holds no signing key, and names the variable", () => {
    for (const value of [undefined, ""]) {
      const state = build({ [RELAY_SIGNING_KEY_ENV]: value });
      expect(state.broker).toBeNull();
      if (state.broker !== null) continue;
      expect(state.reason).toContain("holds no key to sign relay calls");
      expect(state.reason).toContain(RELAY_SIGNING_KEY_ENV);
    }
  });

  it("builds no broker from a key that is not ed25519", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const state = build({ [RELAY_SIGNING_KEY_ENV]: pem });
    expect(state.broker).toBeNull();
    if (state.broker !== null) return;
    expect(state.reason).toContain("does not load");
    expect(state.reason).toContain("not ed25519");
    expect(state.reason).toContain(RELAY_SIGNING_KEY_ENV);
  });

  it("builds no broker from text that is not a key", () => {
    const state = build({ [RELAY_SIGNING_KEY_ENV]: "not a key" });
    expect(state.broker).toBeNull();
    if (state.broker !== null) return;
    expect(state.reason).toContain("does not load");
    expect(state.reason).not.toContain("not a key");
  });

  it("builds a broker from an ed25519 PKCS#8 key", () => {
    const state = build({ [RELAY_SIGNING_KEY_ENV]: ed25519Pem() });
    expect(state.broker).not.toBeNull();
  });

  it("builds a broker from a key written on one line with \\n escapes", () => {
    const oneLine = ed25519Pem().trimEnd().split("\n").join("\\n");
    expect(oneLine).not.toContain("\n");
    const state = build({ [RELAY_SIGNING_KEY_ENV]: oneLine });
    expect(state.broker).not.toBeNull();
  });
});

describe("relayStatusLogger", () => {
  it("logs one line that names the relay, its status, and the reason, with no token", () => {
    const info = vi.fn();
    relayStatusLogger({ info })({
      orgId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      relay: "billing",
      status: "down",
      reason: "its last connection closed",
      at: 0,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Relay billing is down: its last connection closed.", {
      orgId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      relay: "billing",
      status: "down",
    });
  });
});
