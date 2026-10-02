// @vitest-environment jsdom
// The Repositories page's instruction files section (#4518, ADR-253). It
// reads `list_code_repository_findings`: each linked code repository with a
// statement that repeats or contradicts a steering record lists it, a read
// that fails says why, and a workspace with no finding draws no section.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { CodeRepositoryFindingsRead } from "./instruction-findings-read";

const actions = vi.hoisted(() => ({
  promoteInstructionToSteering: vi.fn(),
}));
vi.mock("./actions", () => actions);

const read = vi.hoisted(() => ({ readCodeRepositoryFindings: vi.fn() }));
vi.mock("./instruction-findings-read", () => read);

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { InstructionFindings } = await import("./instruction-findings");

const viewer = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function section(answer: CodeRepositoryFindingsRead) {
  read.readCodeRepositoryFindings.mockResolvedValue(answer);
  const result = render(
    <IntlProvider>{await InstructionFindings({ ctx: viewer })}</IntlProvider>,
  );
  expect(read.readCodeRepositoryFindings).toHaveBeenCalledWith(viewer);
  return result;
}

beforeEach(() => {
  read.readCodeRepositoryFindings.mockReset();
  actions.promoteInstructionToSteering.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const FINDING = {
  id: "crf_contra1",
  path: "AGENTS.md",
  line: 12,
  statement: "Always push to main.",
  kind: "contradiction" as const,
  record: "Never push to main",
  pullRequest: { number: 318, url: "https://github.com/acme/api/pull/318", merged: false },
  proposalId: null,
};

describe("the instruction files section", () => {
  it("says why when the read fails, and lists nothing (negative)", async () => {
    await section({
      kind: "failed",
      failure: { ok: false, reason: "denied", code: "role_not_held" },
    });
    expect(
      screen.getByRole("heading", { name: "Instruction files" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("instruction-findings-failure")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.queryByTestId("instruction-drift")).toBeNull();
    expect(
      document.querySelector("[data-not-backed]"),
    ).toBeNull();
  });

  it("lists each finding under its code repository, with Promote to steering on a contradiction", async () => {
    await section({
      kind: "ok",
      repositories: [
        {
          repositoryId: "rpb_link01",
          fullName: "acme/api",
          findings: [
            FINDING,
            {
              ...FINDING,
              id: "crf_repeat1",
              path: "CLAUDE.md",
              line: 3,
              kind: "repeat",
            },
          ],
        },
        { repositoryId: "rpb_link02", fullName: "acme/web", findings: [] },
      ],
    });
    const repositories = screen.getAllByTestId(
      "instruction-findings-repository",
    );
    expect(repositories).toHaveLength(1);
    const [api] = repositories;
    if (api === undefined) throw new Error("no repository row");
    expect(api).toHaveTextContent("acme/api");
    expect(api.dataset.repository).toBe("rpb_link01");
    expect(
      within(api)
        .getAllByTestId("instruction-drift-finding")
        .map((finding) => finding.dataset.path),
    ).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(
      within(api).getAllByRole("button", { name: "Promote to steering" }),
    ).toHaveLength(1);
    expect(screen.queryByText("acme/web")).toBeNull();
  });

  it("draws nothing when the read answers and no statement differs (negative)", async () => {
    const { container } = await section({
      kind: "ok",
      repositories: [
        { repositoryId: "rpb_link01", fullName: "acme/api", findings: [] },
      ],
    });
    expect(screen.queryByTestId("instruction-findings")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
