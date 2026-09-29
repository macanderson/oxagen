// config.test.ts: loadRelayConfig reads the relay's environment and reports every problem at once.
import { generateKeyPairSync } from "node:crypto";
import { RELAY_CONNECT_PATH } from "@oxagen/relay-broker/protocol";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENV_PREFIX,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  loadRelayConfig,
  MAX_CLOCK_SKEW_MS,
  MAX_MAX_RESPONSE_BYTES,
  MIN_MAX_RESPONSE_BYTES,
  RelayConfigError,
} from "./config";
import { RELAY, testKey, WORKSPACE } from "./test/fixtures";

type Env = Record<string, string | undefined>;

const key = testKey();

/** An environment the relay starts with, changed by `overrides`. */
function validEnv(overrides: Env = {}): Env {
  return {
    RELAY_BROKER_URL: "wss://relay.oxagen.sh",
    RELAY_TOKEN: "rt_test_token",
    RELAY_NAME: RELAY,
    RELAY_WORKSPACE: WORKSPACE,
    RELAY_TRUSTED_KEYS: key.publicKeyPem,
    RELAY_ALLOWED_HOSTS: "billing.internal,ledger.internal:50051",
    ...overrides,
  };
}

/** The error loadRelayConfig throws for `env`. Fails the test when it throws nothing. */
function errorOf(env: Env): RelayConfigError {
  try {
    loadRelayConfig(env);
  } catch (error) {
    if (error instanceof RelayConfigError) return error;
    throw error;
  }
  throw new Error("loadRelayConfig accepted an environment the test expected it to refuse.");
}

function problemsOf(env: Env): readonly string[] {
  return errorOf(env).problems;
}

/** An Ed25519 public key as PEM text. */
function publicPem(): string {
  return testKey().publicKeyPem;
}

describe("loadRelayConfig", () => {
  it("reads a complete environment into the relay's settings", () => {
    const config = loadRelayConfig(validEnv());

    expect(config.brokerUrl).toBe(`wss://relay.oxagen.sh${RELAY_CONNECT_PATH}`);
    expect(config.token).toBe("rt_test_token");
    expect(config.relay).toBe(RELAY);
    expect(config.workspace).toBe(WORKSPACE);
    expect([...config.trustedKeys.keys()]).toEqual([key.keyId]);
    expect(config.trustedKeys.get(key.keyId)?.equals(key.publicKey)).toBe(true);
    expect(config.allowedHosts.exact).toEqual(new Set(["ledger.internal:50051"]));
    expect(config.allowedHosts.defaultPort).toEqual(new Set(["billing.internal"]));
    expect(config.clockSkewMs).toBe(DEFAULT_CLOCK_SKEW_MS);
    expect(config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(config.credentials).toEqual(new Map());
  });

  it("lists every problem in one error, one per line", () => {
    const error = errorOf({});

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RelayConfigError");
    expect(error.problems).toEqual([
      expect.stringContaining("Set RELAY_BROKER_URL"),
      expect.stringContaining("Set RELAY_TOKEN"),
      expect.stringContaining("Set RELAY_NAME"),
      expect.stringContaining("Set RELAY_WORKSPACE"),
      expect.stringContaining("Set RELAY_TRUSTED_KEYS"),
      expect.stringContaining("Set RELAY_ALLOWED_HOSTS"),
    ]);
    expect(error.message).toBe(["The relay cannot start:", ...error.problems.map((problem) => `- ${problem}`)].join("\n"));
  });

  it("reports a bad value in each variable together", () => {
    const problems = problemsOf({
      RELAY_BROKER_URL: "ws://relay.oxagen.sh",
      RELAY_TOKEN: "rt test",
      RELAY_NAME: "Office",
      RELAY_WORKSPACE: "wrk_short",
      RELAY_TRUSTED_KEYS: "not a key",
      RELAY_ALLOWED_HOSTS: "*.internal",
      RELAY_CLOCK_SKEW_MS: "soon",
      RELAY_MAX_RESPONSE_BYTES: "lots",
    });

    expect(problems).toHaveLength(8);
    for (const name of [
      "RELAY_BROKER_URL",
      "RELAY_TOKEN",
      "RELAY_NAME",
      "RELAY_WORKSPACE",
      "RELAY_TRUSTED_KEYS",
      "RELAY_ALLOWED_HOSTS",
      "RELAY_CLOCK_SKEW_MS",
      "RELAY_MAX_RESPONSE_BYTES",
    ]) {
      expect(problems.filter((problem) => problem.includes(name))).toHaveLength(1);
    }
  });
});

describe("RelayConfigError", () => {
  it("keeps the problems and lists them under one heading", () => {
    const error = new RelayConfigError(["First problem.", "Second problem."]);

    expect(error.problems).toEqual(["First problem.", "Second problem."]);
    expect(error.message).toBe("The relay cannot start:\n- First problem.\n- Second problem.");
    expect(error.name).toBe("RelayConfigError");
  });
});

describe("RELAY_BROKER_URL", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("asks for the broker address when the variable is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_BROKER_URL: value }))).toEqual([expect.stringContaining("Set RELAY_BROKER_URL")]);
  });

  it("refuses text that is not a URL", () => {
    expect(problemsOf(validEnv({ RELAY_BROKER_URL: "relay.oxagen.sh" }))).toEqual([
      expect.stringContaining("RELAY_BROKER_URL is not a URL"),
    ]);
  });

  it("refuses a ws:// URL for a host other than loopback", () => {
    expect(problemsOf(validEnv({ RELAY_BROKER_URL: "ws://relay.oxagen.sh" }))).toEqual([
      expect.stringContaining("must start with wss://"),
    ]);
  });

  it.each(["ws://127.0.0.2:8080", "ws://localhost.example.com", "http://relay.oxagen.sh", "https://relay.oxagen.sh"])(
    "refuses %s, which is neither wss:// nor ws:// to loopback",
    (url) => {
      expect(problemsOf(validEnv({ RELAY_BROKER_URL: url }))).toEqual([expect.stringContaining("must start with wss://")]);
    },
  );

  it.each(["ws://127.0.0.1:8080", "ws://localhost:8080", "ws://[::1]:8080"])(
    "allows ws:// for the loopback address %s",
    (url) => {
      expect(loadRelayConfig(validEnv({ RELAY_BROKER_URL: url })).brokerUrl).toBe(`${url}${RELAY_CONNECT_PATH}`);
    },
  );

  it.each(["wss://relay.oxagen.sh", "wss://relay.oxagen.sh/", "  wss://relay.oxagen.sh  "])(
    "adds the connect path to %j, which has no path",
    (url) => {
      expect(loadRelayConfig(validEnv({ RELAY_BROKER_URL: url })).brokerUrl).toBe(
        `wss://relay.oxagen.sh${RELAY_CONNECT_PATH}`,
      );
    },
  );

  it("keeps a port and a URL that already ends in the connect path", () => {
    expect(loadRelayConfig(validEnv({ RELAY_BROKER_URL: "wss://relay.oxagen.sh:8443" })).brokerUrl).toBe(
      `wss://relay.oxagen.sh:8443${RELAY_CONNECT_PATH}`,
    );
    expect(
      loadRelayConfig(validEnv({ RELAY_BROKER_URL: `wss://relay.oxagen.sh${RELAY_CONNECT_PATH}` })).brokerUrl,
    ).toBe(`wss://relay.oxagen.sh${RELAY_CONNECT_PATH}`);
  });

  it.each([
    ["a user name and password", "wss://relay-user:hunter2@relay.oxagen.sh"],
    ["a user name", "wss://relay-user@relay.oxagen.sh"],
    ["a query", "wss://relay.oxagen.sh/?workspace=1"],
    ["a fragment", "wss://relay.oxagen.sh/#top"],
    ["a bare question mark", "wss://relay.oxagen.sh/?"],
    ["a bare hash", `wss://relay.oxagen.sh${RELAY_CONNECT_PATH}#`],
  ])("refuses a URL that holds %s", (_label, url) => {
    const problems = problemsOf(validEnv({ RELAY_BROKER_URL: url }));

    expect(problems).toEqual([expect.stringContaining("must not hold")]);
    expect(problems.join("\n")).not.toContain("hunter2");
  });

  it.each(["wss://relay.oxagen.sh/connect", `wss://relay.oxagen.sh${RELAY_CONNECT_PATH}/`, "wss://relay.oxagen.sh/relay"])(
    "refuses %s, whose path is not the connect path",
    (url) => {
      expect(problemsOf(validEnv({ RELAY_BROKER_URL: url }))).toEqual([
        expect.stringContaining(`must end in ${RELAY_CONNECT_PATH}`),
      ]);
    },
  );
});

describe("RELAY_TOKEN", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("asks for the token when the variable is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_TOKEN: value }))).toEqual([expect.stringContaining("Set RELAY_TOKEN")]);
  });

  it.each([
    ["a space", "rt_secret value"],
    ["a trailing line break", "rt_secret\n"],
    ["a leading tab", "\trt_secret"],
  ])("refuses a token with %s and does not repeat it", (_label, value) => {
    const problems = problemsOf(validEnv({ RELAY_TOKEN: value }));

    expect(problems).toEqual([expect.stringContaining("RELAY_TOKEN holds a space or a line break")]);
    expect(problems.join("\n")).not.toContain("rt_secret");
  });
});

describe("RELAY_NAME", () => {
  it("accepts a name of 63 characters", () => {
    const name = `a${"-".repeat(61)}z`;

    expect(loadRelayConfig(validEnv({ RELAY_NAME: name })).relay).toBe(name);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["uppercase", "Office"],
    ["started with a hyphen", "-office"],
    ["64 characters long", "a".repeat(64)],
    ["holding an underscore", "main_office"],
  ])("asks for the relay's name when the value is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_NAME: value }))).toEqual([expect.stringContaining("Set RELAY_NAME")]);
  });
});

describe("RELAY_WORKSPACE", () => {
  it.each([
    ["missing", undefined],
    ["too short", "wrk_short"],
    ["uppercase", WORKSPACE.toUpperCase()],
    ["holding letters Crockford base32 leaves out", "wrk_0123456789abcdefghijkl"],
    ["missing the wrk_ prefix", "0123456789abcdefghjkmnpq"],
  ])("asks for the workspace id when the value is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_WORKSPACE: value }))).toEqual([expect.stringContaining("Set RELAY_WORKSPACE")]);
  });
});

describe("RELAY_TRUSTED_KEYS", () => {
  it.each([
    ["missing", undefined],
    ["blank", " \n "],
  ])("asks for the signing key when the variable is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: value }))).toEqual([expect.stringContaining("Set RELAY_TRUSTED_KEYS")]);
  });

  it("reads a PEM written on one line with \\n escapes", () => {
    const oneLine = key.publicKeyPem.replace(/\n/g, "\\n");

    expect(oneLine).not.toContain("\n");
    expect([...loadRelayConfig(validEnv({ RELAY_TRUSTED_KEYS: oneLine })).trustedKeys.keys()]).toEqual([key.keyId]);
  });

  it("trusts every PEM block in the variable", () => {
    const second = testKey();
    const config = loadRelayConfig(validEnv({ RELAY_TRUSTED_KEYS: `${key.publicKeyPem}\n${second.publicKeyPem}` }));

    expect([...config.trustedKeys.keys()].sort()).toEqual([key.keyId, second.keyId].sort());
    expect(config.trustedKeys.get(second.keyId)?.equals(second.publicKey)).toBe(true);
  });

  it("refuses a private key", () => {
    const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: privatePem }))).toEqual([
      expect.stringContaining("RELAY_TRUSTED_KEYS holds a private key"),
    ]);
  });

  it("refuses a private key even beside a public key", () => {
    const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: `${key.publicKeyPem}${privatePem}` }))).toEqual([
      expect.stringContaining("RELAY_TRUSTED_KEYS holds a private key"),
    ]);
  });

  it("reports text with no PEM block", () => {
    const body = key.publicKeyPem.split("\n")[1] ?? "";

    expect(body).not.toBe("");
    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: body }))).toEqual([
      expect.stringContaining("RELAY_TRUSTED_KEYS holds no PEM public key"),
    ]);
  });

  it("refuses a public key that is not Ed25519", () => {
    const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();

    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: ecPem }))).toEqual([
      expect.stringMatching(/^RELAY_TRUSTED_KEYS holds a key the relay cannot use: .*Ed25519/),
    ]);
  });

  it("reports a damaged block once, without also saying there is no key", () => {
    const damaged = "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----";

    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: damaged }))).toEqual([
      expect.stringContaining("RELAY_TRUSTED_KEYS holds a key the relay cannot use"),
    ]);
  });

  it("refuses the whole variable when one of its blocks is damaged", () => {
    const damaged = "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----";

    expect(problemsOf(validEnv({ RELAY_TRUSTED_KEYS: `${publicPem()}\n${damaged}` }))).toEqual([
      expect.stringContaining("RELAY_TRUSTED_KEYS holds a key the relay cannot use"),
    ]);
  });
});

describe("RELAY_ALLOWED_HOSTS", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["only separators", " , ,\n"],
  ])("asks for the hosts when the variable is %s", (_label, value) => {
    expect(problemsOf(validEnv({ RELAY_ALLOWED_HOSTS: value }))).toEqual([
      expect.stringContaining("Set RELAY_ALLOWED_HOSTS"),
    ]);
  });

  it("splits on commas and whitespace, and sorts host:port from bare hosts", () => {
    const config = loadRelayConfig(
      validEnv({ RELAY_ALLOWED_HOSTS: "billing.internal, ledger.internal:50051\napi.internal  10.0.0.5:8443,," }),
    );

    expect(config.allowedHosts.exact).toEqual(new Set(["ledger.internal:50051", "10.0.0.5:8443"]));
    expect(config.allowedHosts.defaultPort).toEqual(new Set(["billing.internal", "api.internal"]));
  });

  it("lowercases each entry", () => {
    const config = loadRelayConfig(validEnv({ RELAY_ALLOWED_HOSTS: "Billing.Internal,LEDGER.internal:50051" }));

    expect(config.allowedHosts.exact).toEqual(new Set(["ledger.internal:50051"]));
    expect(config.allowedHosts.defaultPort).toEqual(new Set(["billing.internal"]));
  });

  it("accepts ports 1 and 65535", () => {
    const config = loadRelayConfig(validEnv({ RELAY_ALLOWED_HOSTS: "a.internal:1,b.internal:65535" }));

    expect(config.allowedHosts.exact).toEqual(new Set(["a.internal:1", "b.internal:65535"]));
    expect(config.allowedHosts.defaultPort).toEqual(new Set());
  });

  it.each([
    "https://billing.internal",
    "*.internal",
    "billing.internal/v1",
    "billing_internal",
    "[::1]",
    "billing.internal:",
    "billing.internal:http",
    "billing.internal:0",
    "billing.internal:65536",
    "billing.internal:123456",
  ])("refuses the entry %s and names it", (entry) => {
    expect(problemsOf(validEnv({ RELAY_ALLOWED_HOSTS: `billing.internal,${entry}` }))).toEqual([
      expect.stringContaining(`RELAY_ALLOWED_HOSTS entry ${entry} is not a host or host:port`),
    ]);
  });

  it("names a refused entry as written, before lowercasing", () => {
    expect(problemsOf(validEnv({ RELAY_ALLOWED_HOSTS: "Billing_Internal" }))).toEqual([
      expect.stringContaining("entry Billing_Internal is not"),
    ]);
  });

  it("reports each refused entry", () => {
    expect(problemsOf(validEnv({ RELAY_ALLOWED_HOSTS: "*.internal ledger.internal:0" }))).toEqual([
      expect.stringContaining("entry *.internal"),
      expect.stringContaining("entry ledger.internal:0"),
    ]);
  });
});

describe("RELAY_CLOCK_SKEW_MS", () => {
  it.each([
    ["missing", undefined],
    ["blank", "  "],
  ])("defaults when the variable is %s", (_label, value) => {
    expect(loadRelayConfig(validEnv({ RELAY_CLOCK_SKEW_MS: value })).clockSkewMs).toBe(DEFAULT_CLOCK_SKEW_MS);
  });

  const readable: [string, number][] = [
    ["0", 0],
    [" 250 ", 250],
    [String(MAX_CLOCK_SKEW_MS), MAX_CLOCK_SKEW_MS],
  ];
  it.each(readable)("reads %j", (value, expected) => {
    expect(loadRelayConfig(validEnv({ RELAY_CLOCK_SKEW_MS: value })).clockSkewMs).toBe(expected);
  });

  it.each(["-1", String(MAX_CLOCK_SKEW_MS + 1), "1.5", "five", "5s", "0x10", "1e3", "+5"])("refuses %j and states the range", (value) => {
    expect(problemsOf(validEnv({ RELAY_CLOCK_SKEW_MS: value }))).toEqual([
      `RELAY_CLOCK_SKEW_MS must be a whole number from 0 to ${MAX_CLOCK_SKEW_MS}.`,
    ]);
  });
});

describe("RELAY_MAX_RESPONSE_BYTES", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
  ])("defaults when the variable is %s", (_label, value) => {
    expect(loadRelayConfig(validEnv({ RELAY_MAX_RESPONSE_BYTES: value })).maxResponseBytes).toBe(
      DEFAULT_MAX_RESPONSE_BYTES,
    );
  });

  it.each([MIN_MAX_RESPONSE_BYTES, 65_536, MAX_MAX_RESPONSE_BYTES])("reads %i", (bytes) => {
    expect(loadRelayConfig(validEnv({ RELAY_MAX_RESPONSE_BYTES: String(bytes) })).maxResponseBytes).toBe(bytes);
  });

  it.each([String(MIN_MAX_RESPONSE_BYTES - 1), String(MAX_MAX_RESPONSE_BYTES + 1), "8MiB", "NaN"])(
    "refuses %j and states the range",
    (value) => {
      expect(problemsOf(validEnv({ RELAY_MAX_RESPONSE_BYTES: value }))).toEqual([
        `RELAY_MAX_RESPONSE_BYTES must be a whole number from ${MIN_MAX_RESPONSE_BYTES} to ${MAX_MAX_RESPONSE_BYTES}.`,
      ]);
    },
  );
});

describe("RELAY_CREDENTIAL_* variables", () => {
  it("collects every variable with the credential prefix, and nothing else", () => {
    const config = loadRelayConfig(
      validEnv({
        RELAY_CREDENTIAL_BILLING_API_TOKEN: "s3cret",
        RELAY_CREDENTIAL_LEDGER_USERNAME: "",
        RELAY_CREDENTIAL_UNSET_VALUE: undefined,
        relay_credential_lowercase_token: "ignored",
        RELAY_CREDENTIALS: "ignored",
        PATH: "/usr/bin",
      }),
    );

    expect(CREDENTIAL_ENV_PREFIX).toBe("RELAY_CREDENTIAL_");
    expect(config.credentials).toEqual(
      new Map([
        ["RELAY_CREDENTIAL_BILLING_API_TOKEN", "s3cret"],
        ["RELAY_CREDENTIAL_LEDGER_USERNAME", ""],
      ]),
    );
  });
});
