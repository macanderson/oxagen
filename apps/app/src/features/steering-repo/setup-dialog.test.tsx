// @vitest-environment jsdom
// The steering repo setup on the repositories page (#4875): one line under
// the header while the repo is not ready, and the setup dialog it opens, with
// what setup does and each step. The dialog opens on its own at
// `?setup=steering`, and an owner starts setup from it. A ready repo keeps the
// line while an import that stopped after its demote step has a tree to move
// (#5082).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  failedSteeringRepo,
  LEGACY_SOURCE,
  notStartedSteeringRepo,
  steeringRepoView,
  stoppedImport,
} from "./steering-repo.builders";
import type { SteeringRepoView } from "./types";

const actions = vi.hoisted(() => ({
  retrySteeringRepoProvision: vi.fn(),
  importWorkspaceSteering: vi.fn(),
  repairSteeringRepo: vi.fn(),
  readSteeringRepoDestinations: vi.fn(),
}));
vi.mock("./actions", () => actions);

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { SteeringRepoSetup } = await import("./setup-dialog");

const RETURN_TO = routes.steeringSetup("acme", "core-platform");

function setup(
  view: SteeringRepoView,
  { canAct = true, initiallyOpen = false } = {},
) {
  render(
    <IntlProvider>
      <SteeringRepoSetup
        org="acme"
        ws="core-platform"
        view={view}
        canAct={canAct}
        returnTo={RETURN_TO}
        initiallyOpen={initiallyOpen}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  // A stopped setup's form reads the places it can move to (#5196).
  actions.readSteeringRepoDestinations.mockReset().mockResolvedValue({
    ok: true,
    value: { destinations: [], default: null, defaultName: null, reauthorize: [] },
  });
  actions.retrySteeringRepoProvision.mockReset();
  actions.importWorkspaceSteering.mockReset();
  nav.refresh.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the steering repo setup", () => {
  it("names the repository that still steers the workspace, and keeps the steps in a closed dialog", () => {
    setup(notStartedSteeringRepo({ legacySource: LEGACY_SOURCE }));
    const notice = screen.getByTestId("steering-repo-setup-notice");
    expect(notice).toHaveAttribute("data-status", "not_started");
    expect(notice).toHaveTextContent("Not set up");
    expect(notice).toHaveTextContent(
      "acme/agent-harness still steers this workspace through its .oxagen/ tree.",
    );
    expect(
      within(notice).getByTestId("steering-repo-setup-open"),
    ).toHaveTextContent("Set up");
    expect(screen.queryByTestId("steering-repo-setup-dialog")).toBeNull();
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
  });

  it("opens the dialog with what setup does, and starts it for an owner", async () => {
    actions.importWorkspaceSteering.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "no_connection",
    });
    setup(notStartedSteeringRepo({ legacySource: LEGACY_SOURCE }));
    await userEvent.click(screen.getByTestId("steering-repo-setup-open"));
    const dialog = await screen.findByTestId("steering-repo-setup-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Steering repo setup" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByTestId("steering-repo-setup-intro"),
    ).toHaveTextContent(
      "Oxagen creates a private steering repo for this workspace and opens steering PRs that move the records in acme/agent-harness's .oxagen/ tree into it.",
    );
    await userEvent.click(within(dialog).getByTestId("steering-repo-start"));
    expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
  });

  it("opens on arrival at ?setup=steering", async () => {
    setup(notStartedSteeringRepo(), { initiallyOpen: true });
    const dialog = await screen.findByTestId("steering-repo-setup-dialog");
    expect(
      within(dialog).getByTestId("steering-repo-setup-intro"),
    ).toHaveTextContent(
      "Oxagen creates a private steering repo for this workspace, seeds it, applies its prescribed settings, and binds it here.",
    );
  });

  it("says which step stopped setup", () => {
    setup(
      failedSteeringRepo(
        "pick_connection",
        { code: "choose_connection", message: "Choose one." },
        { status: "blocked", provider: null },
      ),
    );
    const notice = screen.getByTestId("steering-repo-setup-notice");
    expect(notice).toHaveAttribute("data-status", "blocked");
    expect(notice).toHaveTextContent("Setup stopped at Host connection.");
  });

  it("offers a member the setup to view and no start (negative)", async () => {
    setup(notStartedSteeringRepo(), { canAct: false });
    const open = screen.getByTestId("steering-repo-setup-open");
    expect(open).toHaveTextContent("View setup");
    await userEvent.click(open);
    await screen.findByTestId("steering-repo-setup-dialog");
    expect(screen.queryByTestId("steering-repo-start")).toBeNull();
  });

  it("draws no line once the repo is ready, and a dialog left open shows it ready", async () => {
    setup(steeringRepoView(), { initiallyOpen: true });
    expect(screen.queryByTestId("steering-repo-setup-notice")).toBeNull();
    expect(
      await screen.findByTestId("steering-repo-ready"),
    ).toHaveTextContent("The steering repo is ready at acme/oxagen-core-platform");
  });

  it("keeps the line on a ready repo while a stopped import has a tree to move, and finishes it through the import (#5082)", async () => {
    actions.importWorkspaceSteering.mockResolvedValue({
      ok: true,
      value: {
        outcome: "imported",
        steeringRepository: "acme/oxagen-core-platform",
        pullRequests: [
          {
            branch: "workspace/import-oxagen",
            number: 4,
            url: "https://github.com/acme/oxagen-core-platform/pull/4",
          },
        ],
        cleanup: { number: 9, url: "https://github.com/acme/agent-harness/pull/9" },
        leftForAPerson: 0,
        rulesNeedingKind: [],
        constraintsNeedingEffect: [],
      },
    });
    setup(steeringRepoView({ importRun: stoppedImport() }));
    const notice = screen.getByTestId("steering-repo-setup-notice");
    expect(notice).toHaveAttribute("data-status", "ready");
    expect(notice).toHaveAttribute("data-move", "pending");
    expect(notice).toHaveTextContent("Move pending");
    expect(notice).toHaveTextContent(
      "The records in acme/agent-harness's .oxagen/ tree have not moved to the steering repo yet.",
    );
    const open = within(notice).getByTestId("steering-repo-setup-open");
    expect(open).toHaveTextContent("Finish the move");
    await userEvent.click(open);
    const dialog = await screen.findByTestId("steering-repo-setup-dialog");
    expect(
      within(dialog).getByTestId("steering-repo-setup-intro"),
    ).toHaveTextContent("move the records in acme/agent-harness's .oxagen/ tree");
    expect(within(dialog).getByTestId("steering-repo-finish-move")).toHaveTextContent(
      "acme/agent-harness no longer steers this workspace, and its .oxagen/ records have not moved yet.",
    );
    await userEvent.click(
      within(dialog).getByTestId("steering-repo-finish-move-action"),
    );
    expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(actions.retrySteeringRepoProvision).not.toHaveBeenCalled();
    expect(
      await within(dialog).findByTestId("steering-repo-import-outcome"),
    ).toHaveTextContent(
      "Oxagen created acme/oxagen-core-platform and opened 1 steering PR. Merge them in order from the Steering page, then merge the cleanup PR on the old repository.",
    );
    expect(within(dialog).queryByTestId("steering-repo-finish-move")).toBeNull();
  });

  it("sends a failed bind after the demote to the import, never a retry (#5082)", async () => {
    actions.importWorkspaceSteering.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "steering_repo_provision_failed",
    });
    setup(
      failedSteeringRepo(
        "bind_repository",
        { code: "step_failed", message: "The bind failed." },
        { importRun: stoppedImport() },
      ),
      { initiallyOpen: true },
    );
    const dialog = await screen.findByTestId("steering-repo-setup-dialog");
    const move = within(dialog).getByTestId("steering-repo-retry");
    expect(move).toHaveTextContent("Move steering");
    await userEvent.click(move);
    expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(actions.retrySteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("draws no line once the import is done, and offers a member no finish (negative)", async () => {
    setup(
      steeringRepoView({
        importRun: stoppedImport({ status: "done", step: "cleanup", error: null }),
      }),
    );
    expect(screen.queryByTestId("steering-repo-setup-notice")).toBeNull();
    cleanup();
    setup(steeringRepoView({ importRun: stoppedImport() }), {
      canAct: false,
      initiallyOpen: true,
    });
    expect(screen.getByTestId("steering-repo-setup-open")).toHaveTextContent(
      "View setup",
    );
    await screen.findByTestId("steering-repo-setup-dialog");
    expect(screen.queryByTestId("steering-repo-finish-move")).toBeNull();
  });
});
