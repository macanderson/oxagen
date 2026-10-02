import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { codeRepositoryFindingsList } from "./repository.findings.list";

const finding = {
  id: "crf_a1B2c3",
  path: "AGENTS.md",
  line: 12,
  statement: "Always push to main.",
  kind: "contradiction",
  record: {
    lineage: "acme.git.no-push-main",
    label: "No pushes to main",
    path: "steering/constraints/acme.git.no-push-main.md",
  },
  pull_request: {
    number: 42,
    url: "https://github.com/acme/api/pull/42",
    state: "open",
    head_sha: "abc123",
  },
  file_url: "https://github.com/acme/api/blob/abc123/AGENTS.md#L12",
  checked_at: "2026-10-02T12:00:00.000Z",
  proposal: null,
};

describe("list_code_repository_findings contract", () => {
  it("registers under its own name as a read", () => {
    expect(getCapability("list_code_repository_findings")).toBe(
      codeRepositoryFindingsList,
    );
    expect(codeRepositoryFindingsList.mutates).toBe(false);
    expect(codeRepositoryFindingsList.noBillingGate).toBe(true);
    expect(codeRepositoryFindingsList.surfaces).toEqual(["api", "mcp", "cli", "agent"]);
    expect(codeRepositoryFindingsList.defaultRoles?.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("takes no input", () => {
    expect(codeRepositoryFindingsList.input.safeParse({}).success).toBe(true);
    expect(
      codeRepositoryFindingsList.input.safeParse({ repository_id: "rpb_1" })
        .success,
    ).toBe(false);
  });

  it("answers repositories with their findings", () => {
    const parsed = codeRepositoryFindingsList.output.safeParse({
      repositories: [
        {
          repository_id: "rpb_link01",
          provider: "github",
          full_name: "acme/api",
          findings: [
            finding,
            {
              ...finding,
              id: "crf_d4",
              kind: "repeat",
              proposal: { id: "prp_x1", status: "pr_open" },
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a finding id of another shape (negative)", () => {
    const parsed = codeRepositoryFindingsList.output.safeParse({
      repositories: [
        {
          repository_id: "rpb_link01",
          provider: "github",
          full_name: "acme/api",
          findings: [{ ...finding, id: "rpb_link01" }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
