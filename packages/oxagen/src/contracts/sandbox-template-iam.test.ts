/**
 * sandbox-template-iam.test.ts
 *
 * Table-driven IAM guard proof for the sandbox-template surface: every MUTATION
 * contract in the sandbox.template.* and agent.environment.* families must be
 * closed by default (defaultEffect "deny") and grant only Owner + Admin at the
 * org scope. A drift here (a new mutation shipping open, or handing a write to a
 * broader role) is a tenancy/authz regression — this test is the ratchet.
 *
 * Read-only capabilities (get / list / export) are intentionally excluded; this
 * asserts the write path.
 */
import { describe, expect, it } from "vitest";
import { sandboxTemplateCreate } from "./sandbox.template.create";
import { sandboxTemplateUpdate } from "./sandbox.template.update";
import { sandboxTemplateDelete } from "./sandbox.template.delete";
import { sandboxTemplateSetDefault } from "./sandbox.template.set_default";
import { sandboxTemplateSetTools } from "./sandbox.template.set_tools";
import { sandboxTemplateImport } from "./sandbox.template.import";
import { agentEnvironmentBind } from "./agent.environment.bind";
import { agentEnvironmentUnbind } from "./agent.environment.unbind";

const MUTATION_CONTRACTS = [
  sandboxTemplateCreate,
  sandboxTemplateUpdate,
  sandboxTemplateDelete,
  sandboxTemplateSetDefault,
  sandboxTemplateSetTools,
  sandboxTemplateImport,
  agentEnvironmentBind,
  agentEnvironmentUnbind,
] as const;

describe("sandbox-template mutation contracts — IAM defaults", () => {
  it.each(MUTATION_CONTRACTS.map((c) => [c.name, c] as const))(
    "%s is deny-by-default and grants only Owner + Admin at org scope",
    (_name, contract) => {
      expect(contract.defaultEffect).toBe("deny");
      expect(contract.defaultRoles.org).toEqual({
        Owner: "allow",
        Admin: "allow",
      });
      // No workspace-scoped grants — these are org-admin operations.
      expect(contract.defaultRoles.workspace ?? {}).toEqual({});
      // The families are scoped (org + workspace tenancy enforced).
      expect(contract.scoped).toBe(true);
    },
  );

  it("pins the roster of write capabilities this suite covers", () => {
    // Pins the covered set so a rename or an accidental removal from
    // MUTATION_CONTRACTS fails loudly. It does NOT discover new contracts: a
    // brand-new sandbox.template.* mutation is invisible here until it is added
    // to MUTATION_CONTRACTS *and* to this list, so adding both is part of
    // shipping one.
    expect(MUTATION_CONTRACTS.map((c) => c.name).sort()).toEqual([
      "bind_agent_environment",
      "create_sandbox_template",
      "delete_sandbox_template",
      "import_sandbox_template",
      "set_default_sandbox_template",
      "set_sandbox_template_tools",
      "unbind_agent_environment",
      "update_sandbox_template",
    ]);
  });
});
