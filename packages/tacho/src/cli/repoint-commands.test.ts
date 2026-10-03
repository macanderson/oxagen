/**
 * `repointCommands`, the re-apply step of `oxagen agent enroll` on a host that
 * is already enrolled. It moves host.json to the binary running now: the
 * hook, daemon and MCP commands, and the version the daemon reports (#5365).
 */
import { describe, expect, it } from "vitest";
import type { HostFile } from "../host/host-file";
import {
  bundleSigner,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { CliDeps } from "./deps";
import { repointCommands } from "./enroll";

function enrolled(): HostFile {
  const signer = bundleSigner();
  return testHostFile(signer, signer.sign(unsignedBundle()), {
    wrapper_version: "2.1.4-365",
    mcp_stdio_command: ["node", "/opt/tacho/tacho-mcp-stdio.mjs"],
  });
}

/** The runtime of a binary whose commands match what `host` records. */
function sameRuntime(host: HostFile): CliDeps["runtime"] {
  return {
    hookCommand: host.hook_command,
    credentialHelperCommand: "oxagen credential issue --harness claude-code",
    daemonCommand: [...host.daemon_command],
    mcpStdioCommand: [...(host.mcp_stdio_command ?? [])],
    binDir: "/opt/tacho",
  };
}

describe("repointCommands", () => {
  it("returns nothing when the commands and the version already match", () => {
    const host = enrolled();
    expect(repointCommands(host, sameRuntime(host), "2.1.4-365")).toBe(
      undefined,
    );
  });

  it("records a newer version when an upgrade keeps the same paths", () => {
    const host = enrolled();
    const moved = repointCommands(host, sameRuntime(host), "2.1.4-460");
    expect(moved).toEqual({ ...host, wrapper_version: "2.1.4-460" });
  });

  it("moves the commands and the version together", () => {
    const host = enrolled();
    const runtime: CliDeps["runtime"] = {
      hookCommand: "'/opt/oxagen/bin/2.1.4-460/oxagen' hook",
      credentialHelperCommand:
        "'/opt/oxagen/bin/2.1.4-460/oxagen' credential issue --harness claude-code",
      daemonCommand: ["/opt/oxagen/bin/2.1.4-460/oxagen", "daemon"],
      mcpStdioCommand: ["/opt/oxagen/bin/2.1.4-460/oxagen", "mcp-stdio"],
      binDir: "/opt/oxagen/bin/2.1.4-460",
    };
    expect(repointCommands(host, runtime, "2.1.4-460")).toEqual({
      ...host,
      hook_command: runtime.hookCommand,
      daemon_command: runtime.daemonCommand,
      mcp_stdio_command: runtime.mcpStdioCommand,
      wrapper_version: "2.1.4-460",
    });
  });
});
