// @vitest-environment jsdom
// The Repositories page's instruction files section (#4518). While no
// capability backs the read, it names `list_code_repository_findings` and
// lists nothing. Once the read answers, each code repository with a drifted
// file lists it with Promote to steering, and a workspace with no drifted file
// draws no section.
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

describe("the instruction files section", () => {
  it("names the missing capability while no read backs it", async () => {
    await section({
      kind: "not_backed",
      capability: "list_code_repository_findings",
    });
    expect(
      screen.getByRole("heading", { name: "Instruction files" }),
    ).toBeInTheDocument();
    const unavailable = screen.getByTestId("instruction-findings-unavailable");
    expect(unavailable).toHaveAttribute(
      "data-capability",
      "list_code_repository_findings",
    );
    expect(unavailable).toHaveTextContent("list_code_repository_findings");
    expect(screen.queryByTestId("instruction-drift")).toBeNull();
  });

  it("lists each drifted file under its code repository with Promote to steering", async () => {
    await section({
      kind: "ok",
      repositories: [
        {
          repositoryId: "rpb_link01",
          fullName: "acme/api",
          findings: [{ path: "AGENTS.md" }, { path: "CLAUDE.md" }],
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
    expect(
      within(api)
        .getAllByTestId("instruction-drift-finding")
        .map((finding) => finding.dataset.path),
    ).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(
      within(api).getAllByRole("button", { name: "Promote to steering" }),
    ).toHaveLength(2);
    expect(screen.queryByText("acme/web")).toBeNull();
  });

  it("draws nothing when the read answers and no file drifted (negative)", async () => {
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
