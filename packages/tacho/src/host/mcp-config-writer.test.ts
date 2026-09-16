import { describe, expect, it } from "vitest";
import {
  gatewayUrl,
  type GatewayInstallConfig,
  isOxagenServerEntry,
  type McpConfigDocument,
  mergeOxagenMcpServer,
  OXAGEN_MCP_SERVER_KEY,
  oxagenMcpPresence,
  stripOxagenMcpServer,
} from "./mcp-config-writer";

const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";
const OTHER_ENROLLMENT = "tch_zyxwvutsrqponmlkjihgfe";

function config(
  overrides: Partial<GatewayInstallConfig> = {},
): GatewayInstallConfig {
  return {
    enrollmentId: ENROLLMENT,
    port: 45231,
    localToken: "local-token-0123456789abcdef",
    shimCommand: "/opt/oxagen/bin/tacho",
    ...overrides,
  };
}

/** A config the operator already had, with a server we must never touch. */
function foreignConfig(): McpConfigDocument {
  return {
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x"],
      },
    },
    globalShortcut: "Cmd+Shift+Space",
  };
}

describe("merge", () => {
  it("adds the gateway on stdio without disturbing a foreign server", () => {
    const before = foreignConfig();
    const merged = mergeOxagenMcpServer(before, config(), "stdio");
    expect(merged.changed).toBe(true);
    expect(merged.displaced).toEqual({});
    expect(merged.config.mcpServers?.["filesystem"]).toEqual(
      before.mcpServers?.["filesystem"],
    );
    expect(merged.config["globalShortcut"]).toBe("Cmd+Shift+Space");
    const entry = merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
    expect(entry?.command).toBe("/opt/oxagen/bin/tacho");
    expect(entry?.args).toEqual([
      "mcp-stdio",
      "--enrollment",
      ENROLLMENT,
      "--port",
      "45231",
    ]);
  });

  it("carries the local bearer in env, never in args", () => {
    const merged = mergeOxagenMcpServer({}, config(), "stdio");
    const entry = merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
    expect(entry?.env?.["TACHO_LOCAL_TOKEN"]).toBe(
      "local-token-0123456789abcdef",
    );
    expect((entry?.args ?? []).join(" ")).not.toContain("local-token");
  });

  it("writes the loopback URL and bearer header on http", () => {
    const merged = mergeOxagenMcpServer({}, config(), "http");
    const entry = merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
    expect(entry?.type).toBe("http");
    expect(entry?.url).toBe(gatewayUrl(45231, ENROLLMENT));
    expect(entry?.url?.startsWith("http://127.0.0.1:")).toBe(true);
    expect(entry?.headers?.["Authorization"]).toBe(
      "Bearer local-token-0123456789abcdef",
    );
  });

  it("passes TACHO_HOME through only when it is set", () => {
    const withHome = mergeOxagenMcpServer(
      {},
      config({ tachoHome: "/tmp/scratch" }),
      "stdio",
    );
    expect(
      withHome.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]?.env?.["TACHO_HOME"],
    ).toBe("/tmp/scratch");
    const without = mergeOxagenMcpServer({}, config(), "stdio");
    expect(
      without.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]?.env,
    ).not.toHaveProperty("TACHO_HOME");
  });

  it("prefixes shimArgs before our own flags", () => {
    const merged = mergeOxagenMcpServer(
      {},
      config({ shimCommand: "/usr/bin/node", shimArgs: ["/opt/tacho.mjs"] }),
      "stdio",
    );
    expect(merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]?.args?.[0]).toBe(
      "/opt/tacho.mjs",
    );
  });

  it("is idempotent", () => {
    const once = mergeOxagenMcpServer(foreignConfig(), config(), "stdio");
    const twice = mergeOxagenMcpServer(once.config, config(), "stdio");
    expect(twice.changed).toBe(false);
    expect(twice.config).toEqual(once.config);
  });

  it("replaces an older enrollment's entry rather than adding a second", () => {
    const old = mergeOxagenMcpServer(
      foreignConfig(),
      config({ enrollmentId: OTHER_ENROLLMENT }),
      "stdio",
    );
    const next = mergeOxagenMcpServer(old.config, config(), "stdio");
    const servers = next.config.mcpServers ?? {};
    expect(Object.keys(servers).sort()).toEqual(["filesystem", "oxagen"]);
    expect((servers["oxagen"]?.args ?? []).join(" ")).toContain(ENROLLMENT);
    expect((servers["oxagen"]?.args ?? []).join(" ")).not.toContain(
      OTHER_ENROLLMENT,
    );
  });

  it("switches transport in place", () => {
    const stdio = mergeOxagenMcpServer(foreignConfig(), config(), "stdio");
    const http = mergeOxagenMcpServer(stdio.config, config(), "http");
    const entry = http.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
    expect(entry?.type).toBe("http");
    expect(entry).not.toHaveProperty("command");
    expect(Object.keys(http.config.mcpServers ?? {})).toHaveLength(2);
  });

  it("reports a foreign server that held our key instead of losing it", () => {
    const squatted: McpConfigDocument = {
      mcpServers: {
        oxagen: { command: "somebody-elses-oxagen", args: ["--serve"] },
      },
    };
    const merged = mergeOxagenMcpServer(squatted, config(), "stdio");
    expect(merged.displaced[OXAGEN_MCP_SERVER_KEY]).toEqual({
      command: "somebody-elses-oxagen",
      args: ["--serve"],
    });
    expect(merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]?.command).toBe(
      "/opt/oxagen/bin/tacho",
    );
  });

  it("does not report our own previous entry as displaced", () => {
    const old = mergeOxagenMcpServer(
      {},
      config({ enrollmentId: OTHER_ENROLLMENT }),
      "stdio",
    );
    const next = mergeOxagenMcpServer(old.config, config(), "stdio");
    expect(next.displaced).toEqual({});
  });

  it("treats a null or non-object document as empty", () => {
    for (const input of [null, undefined, "nonsense", 7]) {
      const merged = mergeOxagenMcpServer(input, config(), "stdio");
      expect(
        merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]?.command,
      ).toBeDefined();
    }
  });
});

describe("strip", () => {
  it("removes our entry and leaves every foreign one", () => {
    const merged = mergeOxagenMcpServer(foreignConfig(), config(), "stdio");
    const stripped = stripOxagenMcpServer(merged.config, ENROLLMENT);
    expect(stripped.changed).toBe(true);
    expect(stripped.config).toEqual(foreignConfig());
  });

  it("round-trips: a foreign server survives enroll then unenroll", () => {
    const original = foreignConfig();
    const merged = mergeOxagenMcpServer(original, config(), "stdio");
    const stripped = stripOxagenMcpServer(
      merged.config,
      ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.config).toEqual(original);
  });

  it("round-trips a displaced squatter back into its key", () => {
    const squatter = { command: "somebody-elses-oxagen", args: ["--serve"] };
    const original: McpConfigDocument = { mcpServers: { oxagen: squatter } };
    const merged = mergeOxagenMcpServer(original, config(), "stdio");
    const stripped = stripOxagenMcpServer(
      merged.config,
      ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.config).toEqual(original);
  });

  it("does not overwrite a server the operator put in the slot meanwhile", () => {
    const squatter = { command: "somebody-elses-oxagen" };
    const merged = mergeOxagenMcpServer(
      { mcpServers: { oxagen: squatter } },
      config(),
      "stdio",
    );
    // Our entry is gone (uninstalled by hand) and a new one took the key.
    const meanwhile: McpConfigDocument = {
      mcpServers: { oxagen: { command: "third-thing" } },
    };
    const stripped = stripOxagenMcpServer(
      meanwhile,
      ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.config.mcpServers?.["oxagen"]?.command).toBe("third-thing");
  });

  it("leaves another enrollment's entry when scoped to ours", () => {
    const other = mergeOxagenMcpServer(
      {},
      config({ enrollmentId: OTHER_ENROLLMENT }),
      "stdio",
    );
    const stripped = stripOxagenMcpServer(other.config, ENROLLMENT);
    expect(stripped.changed).toBe(false);
    expect(stripped.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY]).toBeDefined();
  });

  it("removes any enrollment's entry when unscoped", () => {
    const other = mergeOxagenMcpServer(
      {},
      config({ enrollmentId: OTHER_ENROLLMENT }),
      "stdio",
    );
    const stripped = stripOxagenMcpServer(other.config);
    expect(stripped.config.mcpServers).toBeUndefined();
  });

  it("drops an emptied mcpServers rather than leaving {}", () => {
    const merged = mergeOxagenMcpServer({}, config(), "stdio");
    expect(
      stripOxagenMcpServer(merged.config, ENROLLMENT).config.mcpServers,
    ).toBeUndefined();
  });

  it("restores into a document that has no mcpServers left", () => {
    const squatter = { command: "somebody-elses-oxagen" };
    const stripped = stripOxagenMcpServer({}, ENROLLMENT, {
      oxagen: squatter,
    });
    expect(stripped.config.mcpServers?.["oxagen"]).toEqual(squatter);
  });

  it("is a no-op on a config that never had us", () => {
    const stripped = stripOxagenMcpServer(foreignConfig(), ENROLLMENT);
    expect(stripped.changed).toBe(false);
  });
});

describe("presence", () => {
  it("reports our entry and counts the servers that route around us", () => {
    const merged = mergeOxagenMcpServer(foreignConfig(), config(), "stdio");
    const presence = oxagenMcpPresence(merged.config, ENROLLMENT);
    expect(presence.present).toBe(true);
    expect(presence.foreignEnrollment).toBe(false);
    expect(presence.otherServers).toBe(1);
    expect(presence.otherServerNames).toEqual(["filesystem"]);
  });

  it("flags a stale entry from a previous enrollment", () => {
    const other = mergeOxagenMcpServer(
      {},
      config({ enrollmentId: OTHER_ENROLLMENT }),
      "stdio",
    );
    const presence = oxagenMcpPresence(other.config, ENROLLMENT);
    expect(presence.present).toBe(false);
    expect(presence.foreignEnrollment).toBe(true);
  });

  it("reports absent on an untouched config", () => {
    const presence = oxagenMcpPresence(foreignConfig(), ENROLLMENT);
    expect(presence.present).toBe(false);
    expect(presence.foreignEnrollment).toBe(false);
    expect(presence.otherServers).toBe(1);
  });

  it("reports absent on a document with no mcpServers at all", () => {
    const presence = oxagenMcpPresence({ theme: "dark" }, ENROLLMENT);
    expect(presence).toEqual({
      present: false,
      foreignEnrollment: false,
      otherServers: 0,
      otherServerNames: [],
    });
  });
});

describe("marker recognition", () => {
  it("recognises our stdio and http entries by the enrollment id", () => {
    expect(isOxagenServerEntry(stdio(), ENROLLMENT)).toBe(true);
    expect(isOxagenServerEntry(http(), ENROLLMENT)).toBe(true);
  });

  it("recognises any enrollment when none is given", () => {
    expect(isOxagenServerEntry(stdio(OTHER_ENROLLMENT))).toBe(true);
  });

  it("does not match a different enrollment when one is given", () => {
    expect(isOxagenServerEntry(stdio(OTHER_ENROLLMENT), ENROLLMENT)).toBe(
      false,
    );
  });

  it("does not match a foreign entry that merely mentions oxagen", () => {
    expect(
      isOxagenServerEntry({ command: "oxagen-something", args: ["--serve"] }),
    ).toBe(false);
    expect(
      isOxagenServerEntry({ type: "http", url: "https://mcp.oxagen.sh/mcp" }),
    ).toBe(false);
  });

  it("does not match a prefix of an enrollment id", () => {
    expect(
      isOxagenServerEntry({
        args: ["mcp-stdio", "--enrollment", `${ENROLLMENT}x`],
      }),
    ).toBe(false);
  });

  it("does not match a non-object", () => {
    for (const input of [null, undefined, "x", 3, []]) {
      expect(isOxagenServerEntry(input, ENROLLMENT)).toBe(false);
    }
  });
});

function stdio(enrollment = ENROLLMENT) {
  return mergeOxagenMcpServer({}, config({ enrollmentId: enrollment }), "stdio")
    .config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
}

function http(enrollment = ENROLLMENT) {
  return mergeOxagenMcpServer({}, config({ enrollmentId: enrollment }), "http")
    .config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
}
