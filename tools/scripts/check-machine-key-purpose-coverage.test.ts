/**
 * The guard for #3237's root file: #3222 added a
 * `purpose === CLI_SESSION_SCOPE_PURPOSE` branch to
 * `packages/iam/src/machine-key-scope.ts`, and #3178's stale-merge-base
 * squash merge deleted it. This file's tests prove the check fails on that
 * exact shape and passes on the live source as it stands today.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allPurposeDeclarations,
  collectSourceFiles,
  extractPurposeDeclarations,
  isBlockedBeforeGate,
  isHandledInSource,
  missingCoverage,
} from "./check-machine-key-purpose-coverage.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("extractPurposeDeclarations", () => {
  it("reads a same-line declaration with as const", () => {
    expect(
      extractPurposeDeclarations(
        'export const TACHO_HOST_PURPOSE = "tacho_host_v1";',
      ),
    ).toEqual([{ name: "TACHO_HOST_PURPOSE", value: "tacho_host_v1" }]);
  });

  it("reads a same-line declaration without as const", () => {
    expect(
      extractPurposeDeclarations(
        'export const TACHO_HOST_PURPOSE = "tacho_host_v1" as const;',
      ),
    ).toEqual([{ name: "TACHO_HOST_PURPOSE", value: "tacho_host_v1" }]);
  });

  it("reads a declaration wrapped onto its own line", () => {
    const source =
      "export const STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE =\n" +
      '  "stella_operational_telemetry_v1" as const;\n';
    expect(extractPurposeDeclarations(source)).toEqual([
      {
        name: "STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE",
        value: "stella_operational_telemetry_v1",
      },
    ]);
  });

  it("finds nothing in a file with no purpose constant", () => {
    expect(extractPurposeDeclarations("export const X = 1;")).toEqual([]);
  });
});

describe("isHandledInSource", () => {
  it("recognises a direct comparison", () => {
    expect(
      isHandledInSource(
        "if (purpose === CLI_SESSION_SCOPE_PURPOSE) { return; }",
        "CLI_SESSION_SCOPE_PURPOSE",
      ),
    ).toBe(true);
  });

  it("recognises a MACHINE_KEY_CAPABILITIES key", () => {
    expect(
      isHandledInSource(
        "const MACHINE_KEY_CAPABILITIES = {\n  [TACHO_HOST_PURPOSE]: new Set([]),\n};",
        "TACHO_HOST_PURPOSE",
      ),
    ).toBe(true);
  });

  it("does not match a name that only appears as a substring of another", () => {
    expect(
      isHandledInSource(
        "if (purpose === CLI_SESSION_SCOPE_PURPOSE_V2) { return; }",
        "CLI_SESSION_SCOPE_PURPOSE",
      ),
    ).toBe(false);
  });

  it("says no when the name is entirely absent", () => {
    expect(isHandledInSource("export const x = 1;", "TACHO_HOST_PURPOSE")).toBe(
      false,
    );
  });
});

describe("isBlockedBeforeGate", () => {
  it("recognises resolveApiKey's purpose_locked refusal", () => {
    const source =
      "const purpose = scopePurposeOf(row.scope);\n" +
      "  if (purpose === AGENT_CREDENTIAL_SCOPE_PURPOSE) {\n" +
      '    return { ok: false, kind: "purpose_locked" };\n' +
      "  }\n";
    expect(isBlockedBeforeGate(source, "AGENT_CREDENTIAL_SCOPE_PURPOSE")).toBe(
      true,
    );
  });

  it("says no when the comparison leads to a successful resolution", () => {
    const source =
      "if (purpose !== CLI_SESSION_SCOPE_PURPOSE) {\n" +
      "    return { ok: true, apiKeyId: row.id };\n" +
      "  }\n";
    expect(isBlockedBeforeGate(source, "CLI_SESSION_SCOPE_PURPOSE")).toBe(
      false,
    );
  });

  it("says no when the name never appears", () => {
    expect(isBlockedBeforeGate("export const x = 1;", "SOME_PURPOSE")).toBe(
      false,
    );
  });
});

describe("missingCoverage", () => {
  const CLI = { name: "CLI_SESSION_SCOPE_PURPOSE", value: "cli_session_v1" };
  const AGENT = {
    name: "AGENT_CREDENTIAL_SCOPE_PURPOSE",
    value: "agent_credential_v1",
  };

  const HANDLED_SOURCE =
    "if (purpose === CLI_SESSION_SCOPE_PURPOSE) { return exempt(); }";
  const BLOCKED_API_KEY_SOURCE =
    'if (purpose === AGENT_CREDENTIAL_SCOPE_PURPOSE) { return { ok: false, kind: "purpose_locked" }; }';

  it("reports nothing when every purpose is handled or blocked", () => {
    expect(
      missingCoverage({
        declarations: [CLI, AGENT],
        machineKeyScopeSource: HANDLED_SOURCE,
        apiKeySource: BLOCKED_API_KEY_SOURCE,
      }),
    ).toEqual([]);
  });

  it("reproduces #3222/#3178: the branch is deleted, so the purpose is reported missing", () => {
    // This is machine-key-scope.ts's exact state on 30adbbb36 (#3178's squash
    // merge): the CLI session comparison is gone. The purpose is neither
    // handled here nor blocked by resolveApiKey (it is meant to reach this
    // gate and be exempted), so it must be reported.
    const staleSource =
      "const allowed = MACHINE_KEY_CAPABILITIES[purpose];\n" +
      "if (allowed === undefined) { return deny(); }\n";
    const missing = missingCoverage({
      declarations: [CLI],
      machineKeyScopeSource: staleSource,
      apiKeySource: "",
    });
    expect(missing).toEqual([
      { value: "cli_session_v1", names: ["CLI_SESSION_SCOPE_PURPOSE"] },
    ]);
  });

  it("collapses two names that mint the same value: handled under either name is enough", () => {
    const decls = [
      { name: "TACHO_HOST_PURPOSE", value: "tacho_host_v1" },
      { name: "TACHO_HOST_SCOPE_PURPOSE", value: "tacho_host_v1" },
    ];
    // Only the SECOND name is referenced in this file; the check must still
    // pass, since a live key minting either name carries the same value.
    expect(
      missingCoverage({
        declarations: decls,
        machineKeyScopeSource: "if (purpose === TACHO_HOST_SCOPE_PURPOSE) {}",
        apiKeySource: "",
      }),
    ).toEqual([]);
  });

  it("does not report a value blocked under a different name than its own", () => {
    // AGENT_CREDENTIAL_SCOPE_PURPOSE is the only name in this fixture, and
    // resolveApiKey blocks it. Nothing to report.
    expect(
      missingCoverage({
        declarations: [AGENT],
        machineKeyScopeSource: "no reference here",
        apiKeySource: BLOCKED_API_KEY_SOURCE,
      }),
    ).toEqual([]);
  });
});

describe("collectSourceFiles and allPurposeDeclarations against the real tree", () => {
  it("finds the purpose constants this codebase actually declares", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const values = declarations.map((d) => d.value);
    expect(values).toContain("cli_session_v1");
    expect(values).toContain("agent_credential_v1");
    expect(values).toContain("tacho_host_v1");
    expect(values).toContain("tacho_gateway_v1");
    expect(values).toContain("stella_operational_telemetry_v1");
  });
});

describe("the live repository", () => {
  it("has no missing purpose coverage today", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const machineKeyScopeSource = readFileSync(
      join(repoRoot, "packages/iam/src/machine-key-scope.ts"),
      "utf8",
    );
    const apiKeySource = readFileSync(
      join(repoRoot, "packages/auth/src/resolvers/api-key.ts"),
      "utf8",
    );
    expect(
      missingCoverage({ declarations, machineKeyScopeSource, apiKeySource }),
    ).toEqual([]);
  });

  it("would have failed on #3178's squash merge (30adbbb36): the CLI exemption removed", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const apiKeySource = readFileSync(
      join(repoRoot, "packages/auth/src/resolvers/api-key.ts"),
      "utf8",
    );
    // The real file, with the one branch the incident deleted removed here,
    // reproducing 30adbbb36's content for this function.
    const realSource = readFileSync(
      join(repoRoot, "packages/iam/src/machine-key-scope.ts"),
      "utf8",
    );
    const staleSource = realSource.replace(
      /if \(purpose === CLI_SESSION_SCOPE_PURPOSE\) \{[\s\S]*?\n {2}\}\n\n/,
      "",
    );
    // The replace must actually have removed something, or this test proves
    // nothing. The docblock above the function still names the constant in
    // prose (it describes the exemption #3178 also left untouched, per the
    // issue), so the assertion is on the functional branch's shape, not on
    // every mention of the identifier in the file.
    expect(staleSource).not.toEqual(realSource);
    expect(staleSource).not.toContain(
      "if (purpose === CLI_SESSION_SCOPE_PURPOSE)",
    );

    const missing = missingCoverage({
      declarations,
      machineKeyScopeSource: staleSource,
      apiKeySource,
    });
    expect(missing.map((m) => m.value)).toContain("cli_session_v1");
  });
});
