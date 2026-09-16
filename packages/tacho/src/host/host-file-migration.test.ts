/**
 * A host enrolled by an earlier build is a host in the fleet. ADR-078 added
 * four members to `host.json` — `endpoints.mcp`, `mcp_stdio_command`,
 * `displaced_mcp_servers`, and `claude-desktop` as a harness — and every one
 * of them is optional or defaulted for exactly this reason: a file written
 * before the connected tier existed must still load, and the machine must
 * still report, without the operator re-enrolling.
 *
 * `hostFileSchema` is `.strict()`, so this cuts both ways: a member added
 * without a default would reject every older file, and an unknown member
 * would reject a *newer* file read by an older build. These tests pin both
 * directions.
 */
import { describe, expect, it } from "vitest";
import { hostFileSchema, mcpEndpointFor, readHostFile } from "./host-file";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleSigner, testHostFile, unsignedBundle } from "./test-support";

const signer = bundleSigner();
const bundle = signer.sign(unsignedBundle());

/** A host.json exactly as the build before ADR-078 wrote it. */
function v1File(): Record<string, unknown> {
  const host = testHostFile(signer, bundle) as Record<string, unknown>;
  const copy = JSON.parse(JSON.stringify(host)) as Record<string, unknown>;
  delete copy["mcp_stdio_command"];
  delete copy["displaced_mcp_servers"];
  delete (copy["endpoints"] as Record<string, unknown>)["mcp"];
  return copy;
}

describe("a host.json written before the connected tier", () => {
  it("still parses", () => {
    const parsed = hostFileSchema.parse(v1File());
    expect(parsed.host_enrollment_id).toMatch(/^tch_/);
  });

  it("gets an empty displaced-server map rather than undefined", () => {
    // unenroll reads this to restore what it displaced; undefined would throw
    // on the first connected unenroll after an upgrade.
    expect(hostFileSchema.parse(v1File()).displaced_mcp_servers).toEqual({});
  });

  it("has no shim argv, which is correct: it connected no app", () => {
    expect(hostFileSchema.parse(v1File()).mcp_stdio_command).toBeUndefined();
  });

  it("still loads off disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-host-"));
    const path = join(dir, "host.json");
    writeFileSync(path, JSON.stringify(v1File(), null, 2));
    expect(readHostFile(path)?.harnesses).toBeDefined();
  });

  it("resolves an MCP endpoint without one in the file", () => {
    const host = hostFileSchema.parse(v1File());
    expect(
      mcpEndpointFor({ ...host, api_url: "https://api.oxagen.sh" }, {}),
    ).toBe("https://mcp.oxagen.sh/mcp");
  });
});

describe("the endpoint resolver", () => {
  const host = (
    apiUrl: string,
    mcp?: string,
  ): Parameters<typeof mcpEndpointFor>[0] =>
    ({
      api_url: apiUrl,
      endpoints: {
        ingest: "https://api.oxagen.sh/v1/tacho/events",
        bundle: "https://api.oxagen.sh/v1/tacho/bundle",
        commands: "https://api.oxagen.sh/v1/tacho/commands",
        ...(mcp === undefined ? {} : { mcp }),
      },
    }) as Parameters<typeof mcpEndpointFor>[0];

  it("prefers the signed claim over the derivation", () => {
    expect(
      mcpEndpointFor(
        host("https://api.oxagen.sh", "https://mcp.example.test/mcp"),
        {},
      ),
    ).toBe("https://mcp.example.test/mcp");
  });

  it("prefers the env override over everything, which is how a local stack works", () => {
    expect(
      mcpEndpointFor(
        host("https://api.oxagen.sh", "https://mcp.example.test/mcp"),
        {
          TACHO_MCP_ENDPOINT: "http://127.0.0.1:4100/mcp",
        },
      ),
    ).toBe("http://127.0.0.1:4100/mcp");
  });

  it("derives from api_url as a last resort", () => {
    expect(mcpEndpointFor(host("https://api.oxagen.sh"), {})).toBe(
      "https://mcp.oxagen.sh/mcp",
    );
    expect(mcpEndpointFor(host("https://api.staging.oxagen.sh"), {})).toBe(
      "https://mcp.staging.oxagen.sh/mcp",
    );
  });

  it("keeps a host that does not start with api., rather than mangling it", () => {
    expect(mcpEndpointFor(host("https://oxagen.example.test"), {})).toBe(
      "https://oxagen.example.test/mcp",
    );
  });

  it("ignores an empty override", () => {
    expect(
      mcpEndpointFor(host("https://api.oxagen.sh"), { TACHO_MCP_ENDPOINT: "" }),
    ).toBe("https://mcp.oxagen.sh/mcp");
  });
});

describe("a host.json written by this build", () => {
  it("round-trips through the schema unchanged", () => {
    const host = testHostFile(signer, bundle);
    expect(hostFileSchema.parse(JSON.parse(JSON.stringify(host)))).toEqual(
      host,
    );
  });

  it("accepts claude-desktop in the harness list", () => {
    const host = testHostFile(signer, bundle, {
      harnesses: ["claude-code", "claude-desktop"],
    });
    expect(
      hostFileSchema.parse(JSON.parse(JSON.stringify(host))).harnesses,
    ).toContain("claude-desktop");
  });

  it("carries a displaced MCP server through a write and a read", () => {
    const host = testHostFile(signer, bundle, {
      displaced_mcp_servers: {
        "claude-desktop": { oxagen: { command: "somebody-elses" } },
      },
    });
    const parsed = hostFileSchema.parse(JSON.parse(JSON.stringify(host)));
    expect(parsed.displaced_mcp_servers["claude-desktop"]?.["oxagen"]).toEqual({
      command: "somebody-elses",
    });
  });
});
