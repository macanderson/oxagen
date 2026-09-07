/**
 * #1383 and #1424 — the managed policy's two silent failures.
 *
 * #1383: `validateServerAgainstPolicy` had no caller, so `checkServerUrl` never
 * ran and `allowedServerUrls` governed nothing. The issue's sharpest line is
 * that nothing today would fail if the control were deleted entirely, so these
 * assert the control refuses, not merely that it exists.
 *
 * #1424: `allowedCommands` was evaluated by two matchers against two different
 * subjects, and the live one was the permissive one for the most natural way to
 * write a binary pin.
 */
import { describe, expect, it } from "vitest";
import {
  checkServerUrl,
  checkStdioCommand,
  checkToolDenied,
  matchUrlPattern,
  validateServerAgainstPolicy,
  formatViolation,
} from "./managed";
import type { ManagedConfig, ManagedPolicy } from "./schema";

const managed = (policy: ManagedPolicy): ManagedConfig =>
  ({ managedPolicy: policy }) as ManagedConfig;

describe("allowedServerUrls is actually enforced (#1383)", () => {
  const policy: ManagedPolicy = {
    allowedServerUrls: ["https://*.corp.com/*"],
  } as ManagedPolicy;

  it("refuses a server outside the allowlist", () => {
    const violation = validateServerAgainstPolicy(
      "rogue",
      { transport: "http", url: "https://evil.com/mcp" } as never,
      managed(policy),
    );
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("url_not_allowed");
    expect(formatViolation(violation!)).toContain("evil.com");
  });

  it("admits one inside it", () => {
    expect(
      validateServerAgainstPolicy(
        "corp",
        { transport: "http", url: "https://api.corp.com/mcp" } as never,
        managed(policy),
      ),
    ).toBeNull();
  });

  it("does not let the allowlist entry hide in the PATH of another host", () => {
    // The exact hole a raw-string glob leaves, named in managed.ts's own
    // comment before anything enforced it.
    expect(
      matchUrlPattern("https://*.corp.com/*", "https://evil.com/x.corp.com/y"),
    ).toBe(false);
  });

  it("matches the host case-insensitively, so a denylist cannot be cased around", () => {
    const denied: ManagedPolicy = {
      deniedServerUrls: ["https://evil.com/*"],
    } as ManagedPolicy;
    for (const url of [
      "https://evil.com/",
      "https://EVIL.com/",
      "https://user@evil.com/mcp",
      "https://evil.com:8443/mcp",
    ]) {
      expect(checkServerUrl(url, denied)?.type, url).toBe("url_denied");
    }
  });

  it("keeps the denylist ahead of the allowlist", () => {
    const both: ManagedPolicy = {
      allowedServerUrls: ["https://*.corp.com/*"],
      deniedServerUrls: ["https://legacy.corp.com/*"],
    } as ManagedPolicy;
    expect(checkServerUrl("https://legacy.corp.com/x", both)?.type).toBe(
      "url_denied",
    );
    expect(checkServerUrl("https://api.corp.com/x", both)).toBeNull();
  });

  it("binds a wildcard to a domain label, not to a substring", () => {
    expect(matchUrlPattern("https://*.corp.com", "https://api.corp.com")).toBe(
      true,
    );
    // Apex is not a subdomain — same rule a wildcard certificate uses.
    expect(matchUrlPattern("https://*.corp.com", "https://corp.com")).toBe(
      false,
    );
    // And a lookalike registered domain must not pass.
    expect(
      matchUrlPattern("https://*.corp.com", "https://api.corp.com.evil.io"),
    ).toBe(false);
  });

  it("compares the port only when the pattern names one", () => {
    expect(matchUrlPattern("https://corp.com", "https://corp.com:8443/x")).toBe(
      true,
    );
    expect(
      matchUrlPattern("https://corp.com:8443", "https://corp.com:8443/x"),
    ).toBe(true);
    expect(
      matchUrlPattern("https://corp.com:8443", "https://corp.com:9000/x"),
    ).toBe(false);
  });

  it("compares the scheme exactly", () => {
    expect(matchUrlPattern("https://corp.com/*", "http://corp.com/x")).toBe(
      false,
    );
  });

  it("refuses a URL it cannot parse rather than admitting it", () => {
    const policyWithList: ManagedPolicy = {
      allowedServerUrls: ["https://corp.com/*"],
    } as ManagedPolicy;
    expect(checkServerUrl("not a url", policyWithList)?.type).toBe(
      "url_not_allowed",
    );
  });

  it("stays out of the way when no list is configured", () => {
    expect(
      checkServerUrl("https://anything.example/x", {} as ManagedPolicy),
    ).toBeNull();
  });
});

/**
 * #1424's measured table. Both paths now call `checkStdioCommand`, so this
 * prices one policy through the one implementation and pins the subject it
 * matches — the full argv.
 */
describe("allowedCommands means one thing (#1424)", () => {
  const withCommands = (patterns: string[]) =>
    ({ allowedCommands: patterns }) as ManagedPolicy;

  it("accepts a correctly pinned invocation", () => {
    // The live runtime used to BLOCK this, because it matched the binary alone.
    expect(
      checkStdioCommand(
        "npx",
        ["-y", "@good/server"],
        withCommands(["npx -y @good/server"]),
      ),
    ).toBeNull();
  });

  it("does not let a bare binary pin admit the whole registry", () => {
    // The row that matters: the live runtime used to ALLOW this.
    expect(
      checkStdioCommand("npx", ["-y", "@evil/server"], withCommands(["npx"]))
        ?.type,
    ).toBe("command_not_allowed");
  });

  it("still allows a deliberately wildcarded pin", () => {
    expect(
      checkStdioCommand("npx", ["-y", "@evil/server"], withCommands(["npx*"])),
    ).toBeNull();
    expect(
      checkStdioCommand(
        "npx",
        ["-y", "@good/x"],
        withCommands(["npx -y @good/*"]),
      ),
    ).toBeNull();
  });

  it("treats ? as a literal, one dialect everywhere", () => {
    // The runtime's private copy treated `?` as a single-char wildcard, so
    // "nod?" admitted "node". There is one matcher now, and it does not.
    expect(checkStdioCommand("node", [], withCommands(["nod?"]))?.type).toBe(
      "command_not_allowed",
    );
  });

  it("routes a stdio server through the same check as the runtime", () => {
    const violation = validateServerAgainstPolicy(
      "local",
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@evil/server"],
      } as never,
      managed(withCommands(["npx"])),
    );
    expect(violation?.type).toBe("command_not_allowed");
    expect(formatViolation(violation!)).toContain("npx -y @evil/server");
  });

  it("stays out of the way when no allowlist is configured", () => {
    expect(
      checkStdioCommand("anything", ["--x"], {} as ManagedPolicy),
    ).toBeNull();
  });
});

/**
 * #1423: the policy could deny a URL and a tool but not a COMMAND — and stdio
 * is the one transport that spawns a local process, so the floor could not
 * block the single registration that runs code on the machine.
 */
describe("a managed policy can deny a stdio command (#1423)", () => {
  const denied = (patterns: string[]) =>
    ({ deniedCommands: patterns }) as ManagedPolicy;

  it("blocks a denied command", () => {
    const violation = checkStdioCommand(
      "npx",
      ["-y", "@evil/server"],
      denied(["*@evil/*"]),
    );
    expect(violation?.type).toBe("command_denied");
    expect(formatViolation(violation!)).toContain("@evil/server");
  });

  it("checks deny BEFORE allow, as it already does for URLs", () => {
    // An allowlist naming the command must not rescue it from the denylist.
    const both = {
      allowedCommands: ["npx*"],
      deniedCommands: ["*@evil/*"],
    } as ManagedPolicy;
    expect(checkStdioCommand("npx", ["-y", "@evil/server"], both)?.type).toBe(
      "command_denied",
    );
    // …and a command that is allowed and not denied still passes.
    expect(checkStdioCommand("npx", ["-y", "@good/x"], both)).toBeNull();
  });

  it("reaches the command_denied variant, which nothing could produce before", () => {
    const violation = checkStdioCommand(
      "bash",
      ["-c", "curl evil"],
      denied(["bash*"]),
    );
    expect(violation).toMatchObject({
      type: "command_denied",
      pattern: "bash*",
    });
  });

  it("routes a stdio server through the deny check", () => {
    const violation = validateServerAgainstPolicy(
      "local",
      { transport: "stdio", command: "npx", args: ["-y", "@evil/x"] } as never,
      managed(denied(["*@evil/*"])),
    );
    expect(violation?.type).toBe("command_denied");
  });

  it("leaves an unset allowedCommands unrestricted, as before", () => {
    // Stated in schema.ts and kept deliberately: tightening it would silently
    // refuse stdio servers for every policy already deployed.
    expect(
      checkStdioCommand("anything", ["--x"], denied(["*@evil/*"])),
    ).toBeNull();
  });

  it("covers all three restrictable things, which was the gap", () => {
    // URL, tool and command — the policy could express only the first two.
    const policy = {
      deniedServerUrls: ["https://evil.com/*"],
      deniedTools: ["dangerous_*"],
      deniedCommands: ["*@evil/*"],
    } as ManagedPolicy;
    expect(checkServerUrl("https://evil.com/x", policy)?.type).toBe(
      "url_denied",
    );
    expect(checkToolDenied("srv", "dangerous_exec", policy)?.type).toBe(
      "tool_denied",
    );
    expect(checkStdioCommand("npx", ["@evil/x"], policy)?.type).toBe(
      "command_denied",
    );
  });
});
