/**
 * A relay name create_relay accepts is a name the broker can route (M12, #4685).
 *
 * The contract lives in @oxagen/oxagen, which must not import the broker, so
 * it keeps its own copy of the name pattern. This test holds the copies
 * together from the one package that may import all three:
 *
 *   contract  RELAY_NAME_REGEX, from tool.relay.create
 *   manifest  RELAY_NAME_PATTERN, from @oxagen/mcp-studio (tools.toml network)
 *   broker    the private RELAY_NETWORK pattern in relay-broker/src/broker.ts,
 *             read through its behavior: a routable name reaches the
 *             connection lookup and fails "disconnected", and any other name
 *             fails "unsupported" before the lookup
 */
import { generateKeyPairSync } from "node:crypto";
import {
  RELAY_NAME_PATTERN,
  TransportError,
  type HttpTransportRequest,
} from "@oxagen/mcp-studio";
import {
  RELAY_NAME_REGEX,
  toolRelayCreate,
} from "@oxagen/oxagen/contracts/tool.relay.create";
import {
  createRelayBroker,
  relaySignerFromPem,
  type RelayBroker,
} from "@oxagen/relay-broker";
import { memoryRelayTokenVerifier } from "@oxagen/relay-broker/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ACCEPTED = [
  "a",
  "0",
  "office-lan",
  "billing-2",
  "9-lives",
  "a-",
  `a${"b".repeat(62)}`,
];

const REFUSED = [
  "",
  "-office",
  "Office",
  "office_lan",
  "office.lan",
  "office lan",
  "office/lan",
  `a${"b".repeat(63)}`,
];

const scope = {
  orgId: "00000000-0000-4000-8000-00000000000a",
  workspaceId: "00000000-0000-4000-8000-00000000000b",
  workspacePublicId: "wrk_0123456789abcdefghjkmn",
};

function request(network: string): HttpTransportRequest {
  return {
    network,
    target: {
      kind: "http",
      scheme: "https",
      method: "POST",
      host: "billing.internal",
      path: "/v1/invoices?limit=5",
    },
    headers: [["Content-Type", "application/json"]],
    body: new Uint8Array(),
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
  };
}

/** The TransportError code the broker answers for a call on relay:<name>. */
async function brokerCode(broker: RelayBroker, name: string): Promise<string> {
  const err = await broker
    .transport(scope)
    .http(request(`relay:${name}`))
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(TransportError);
  return (err as TransportError).code;
}

describe("relay name pattern", () => {
  let broker: RelayBroker;

  beforeAll(() => {
    const pem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    broker = createRelayBroker({
      verifier: memoryRelayTokenVerifier([]),
      signer: relaySignerFromPem(pem),
      credentialEntitled: () => Promise.resolve(true),
    });
  });

  afterAll(async () => {
    await broker.close();
  });

  it("matches the manifest's relay name pattern", () => {
    expect(RELAY_NAME_REGEX.source).toBe(RELAY_NAME_PATTERN.source);
    expect(RELAY_NAME_REGEX.flags).toBe(RELAY_NAME_PATTERN.flags);
  });

  it.each(ACCEPTED)("accepts %j, and the broker routes it", async (name) => {
    expect(RELAY_NAME_REGEX.test(name)).toBe(true);
    expect(toolRelayCreate.input.safeParse({ name }).success).toBe(true);
    // No relay is connected, so a routable name fails at the connection lookup.
    await expect(brokerCode(broker, name)).resolves.toBe("disconnected");
  });

  it.each(REFUSED)("refuses %j, and so does the broker", async (name) => {
    expect(RELAY_NAME_REGEX.test(name)).toBe(false);
    expect(toolRelayCreate.input.safeParse({ name }).success).toBe(false);
    await expect(brokerCode(broker, name)).resolves.toBe("unsupported");
  });
});
