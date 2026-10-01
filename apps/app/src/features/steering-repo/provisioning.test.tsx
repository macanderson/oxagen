// @vitest-environment jsdom
// A steering repo's provisioning over fake retries (#4518): each step and its
// state on GitHub and GitLab, the failed step's message with Retry for an
// owner or admin, the Re-authorize way back on GitHub and GitLab, and the
// ready repository with its link.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  failedSteeringRepo,
  GITHUB_REPOSITORY,
  GITLAB_REPOSITORY,
  LEGACY_SOURCE,
  notStartedSteeringRepo,
  steeringRepoView,
} from "./steering-repo.builders";
import type { SteeringRepoView } from "./types";

const actions = vi.hoisted(() => ({
  retrySteeringRepoProvision: vi.fn(),
  importWorkspaceSteering: vi.fn(),
  repairSteeringRepo: vi.fn(),
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

const { SteeringRepoProvisioning } = await import("./provisioning");

const RETURN_TO = routes.repositories("acme", "core-platform");

const REAUTHORIZE = {
  code: "steering_reauthorize",
  message: "Oxagen can no longer create repositories on this account.",
};

function provisioning(
  view: SteeringRepoView,
  {
    canAct = true,
    ws = "core-platform",
  }: { canAct?: boolean; ws?: string | null } = {},
) {
  render(
    <IntlProvider>
      <SteeringRepoProvisioning
        org="acme"
        ws={ws}
        view={view}
        canAct={canAct}
        returnTo={RETURN_TO}
      />
    </IntlProvider>,
  );
  return screen.getByTestId("steering-repo-provisioning");
}

function stepStates(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>("li[data-step]")].map((li) => [
    li.dataset.step,
    li.dataset.state,
  ]);
}

const FAILED = failedSteeringRepo("create_repository", {
  code: "repository_name_taken",
  message: "GitHub already has a repository named acme/oxagen-core-platform.",
});

beforeEach(() => {
  actions.retrySteeringRepoProvision.mockReset();
  actions.importWorkspaceSteering.mockReset();
  actions.repairSteeringRepo.mockReset();
  nav.refresh.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the steering repo provisioning", () => {
  it("shows each step with its state and marks the running step current", () => {
    const root = provisioning(
      steeringRepoView({
        status: "provisioning",
        step: "create_repository",
        repository: GITHUB_REPOSITORY,
        publishedVersion: null,
        health: null,
      }),
    );
    expect(root).toHaveAttribute("data-status", "provisioning");
    expect(stepStates(root)).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["add_to_installation", "running"],
      ["write_first_commit", "waiting"],
      ["apply_settings", "waiting"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
    const running = within(root).getByRole("listitem", { current: "step" });
    expect(running).toHaveTextContent("Oxagen app access");
    expect(running).toHaveTextContent("Running");
    expect(
      within(root).getByRole("list", { name: "Provisioning steps" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
    expect(screen.queryByTestId("steering-repo-ready")).toBeNull();
  });

  it("shows the project hook step on GitLab in place of the app access step", () => {
    const root = provisioning(
      steeringRepoView({
        status: "provisioning",
        step: "apply_settings",
        provider: "gitlab",
        repository: GITLAB_REPOSITORY,
        publishedVersion: null,
        health: null,
      }),
    );
    expect(stepStates(root)).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["register_webhook", "running"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
    const running = within(root).getByRole("listitem", { current: "step" });
    expect(running).toHaveTextContent("Change notifications");
    expect(running).toHaveTextContent("Running");
  });

  it("shows the failed step's message and Retry to an owner or admin", () => {
    const root = provisioning(FAILED);
    const failed = root.querySelector<HTMLElement>(
      'li[data-step="create_repository"]',
    );
    if (failed === null) throw new Error("the failed step is not rendered");
    expect(failed).toHaveAttribute("data-state", "failed");
    expect(
      within(failed).getByTestId("steering-repo-step-error"),
    ).toHaveTextContent(
      "GitHub already has a repository named acme/oxagen-core-platform.",
    );
    expect(screen.getByTestId("steering-repo-retry")).toHaveTextContent(
      "Retry",
    );
    expect(screen.queryByTestId("steering-repo-reauthorize")).toBeNull();
  });

  it("shows a member the failed step's message and no Retry (negative)", () => {
    provisioning(FAILED, { canAct: false });
    expect(screen.getByTestId("steering-repo-step-error")).toBeInTheDocument();
    expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
  });

  it("retries the job for the workspace and re-reads the page", async () => {
    actions.retrySteeringRepoProvision.mockResolvedValue({
      ok: true,
      value: { status: "provisioning" },
    });
    provisioning(FAILED);
    await userEvent.click(screen.getByTestId("steering-repo-retry"));
    await waitFor(() => {
      expect(nav.refresh).toHaveBeenCalledTimes(1);
    });
    expect(actions.retrySteeringRepoProvision).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(screen.queryByTestId("steering-repo-retry-failure")).toBeNull();
  });

  it("retries an organization's job before it has a workspace, and shows no workspace binding", async () => {
    actions.retrySteeringRepoProvision.mockResolvedValue({
      ok: true,
      value: { status: "provisioning" },
    });
    const root = provisioning(FAILED, { ws: null });
    expect(
      root.querySelector('li[data-step="bind_repository"]'),
    ).toBeNull();
    await userEvent.click(screen.getByTestId("steering-repo-retry"));
    expect(actions.retrySteeringRepoProvision).toHaveBeenCalledWith(
      "acme",
      null,
    );
  });

  it("shows the pending label and retries once however many times a person clicks", async () => {
    let answer: (value: unknown) => void = () => {};
    actions.retrySteeringRepoProvision.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    provisioning(FAILED);
    const retry = screen.getByTestId("steering-repo-retry");
    await userEvent.click(retry);
    expect(retry).toHaveTextContent("Retrying");
    expect(retry).toBeDisabled();
    await userEvent.click(retry);
    expect(actions.retrySteeringRepoProvision).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { status: "provisioning" } });
    await waitFor(() => {
      expect(nav.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("prints a refusal's code as recorded (negative)", async () => {
    actions.retrySteeringRepoProvision.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "provision_running",
    });
    provisioning(FAILED);
    await userEvent.click(screen.getByTestId("steering-repo-retry"));
    expect(
      await screen.findByTestId("steering-repo-retry-failure"),
    ).toHaveTextContent("This was refused: provision_running.");
  });

  it("says the retry went unanswered when the call threw (negative)", async () => {
    actions.retrySteeringRepoProvision.mockRejectedValue(
      new Error("network down"),
    );
    provisioning(FAILED);
    await userEvent.click(screen.getByTestId("steering-repo-retry"));
    expect(
      await screen.findByTestId("steering-repo-retry-failure"),
    ).toHaveTextContent("action_failed");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("offers Re-authorize on GitHub through the API route that returns to this page", () => {
    provisioning(
      failedSteeringRepo("add_to_installation", REAUTHORIZE, {
        status: "blocked",
      }),
    );
    const notice = screen.getByTestId("steering-repo-reauthorize");
    expect(
      within(notice).getByRole("heading", { name: "Authorization needed" }),
    ).toBeInTheDocument();
    const link = screen.getByTestId("steering-repo-reauthorize-link");
    expect(link).toHaveTextContent("Re-authorize");
    expect(link).toHaveAttribute("data-provider", "github");
    const href = new URL(
      link.getAttribute("href") ?? "",
      "https://app.oxagen.sh",
    );
    expect(href.pathname).toBe("/api/v1/acme/connections/steering/github");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      mode: "authorize",
      return_to: RETURN_TO,
    });
    expect(
      screen
        .getByTestId("steering-repo-provisioning")
        .querySelector('li[data-step="add_to_installation"]'),
    ).toHaveAttribute("data-state", "blocked");
  });

  it("tells a member why provisioning stopped and offers no Re-authorize (negative)", () => {
    provisioning(
      failedSteeringRepo("add_to_installation", REAUTHORIZE, {
        status: "blocked",
      }),
      { canAct: false },
    );
    expect(screen.getByTestId("steering-repo-reauthorize")).toHaveTextContent(
      "Authorization needed",
    );
    expect(screen.queryByTestId("steering-repo-reauthorize-link")).toBeNull();
    expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
  });

  it("sends a GitLab owner to the connect step to paste the group token again", () => {
    provisioning(
      failedSteeringRepo("create_repository", REAUTHORIZE, {
        status: "blocked",
        provider: "gitlab",
      }),
    );
    const link = screen.getByTestId("steering-repo-reauthorize-link");
    expect(link).toHaveAttribute("data-provider", "gitlab");
    expect(link).toHaveAttribute("href", routes.welcomeConnect("acme"));
  });

  it("names the ready repository with its GitHub link", () => {
    provisioning(steeringRepoView());
    expect(screen.getByTestId("steering-repo-ready")).toHaveTextContent(
      "The steering repo is ready at acme/oxagen-core-platform",
    );
    expect(screen.getByTestId("steering-repo-ready-link")).toHaveAttribute(
      "href",
      GITHUB_REPOSITORY.url,
    );
  });

  it("names the ready repository with its GitLab link", () => {
    provisioning(
      steeringRepoView({ provider: "gitlab", repository: GITLAB_REPOSITORY }),
    );
    expect(screen.getByTestId("steering-repo-ready-link")).toHaveAttribute(
      "href",
      GITLAB_REPOSITORY.url,
    );
  });

  it("names a repository at an address it cannot check without a link (negative)", () => {
    provisioning(
      steeringRepoView({
        repository: {
          fullName: "acme/oxagen-core-platform",
          url: "https://github.example.com/acme/oxagen-core-platform",
        },
      }),
    );
    const name = screen.getByTestId("steering-repo-ready-link");
    expect(name).toHaveTextContent("acme/oxagen-core-platform");
    expect(name).not.toHaveAttribute("href");
  });

  describe("the way on when setup stopped (#4875)", () => {
    const CHOICES = [
      { provider: "github" as const, id: 11, name: "acme", kind: "organization" as const },
      { provider: "github" as const, id: 12, name: "acme-old", kind: "organization" as const },
      { provider: "github" as const, id: 13, name: "mac", kind: "user" as const },
    ];
    const choosing = (overrides: Partial<SteeringRepoView> = {}) =>
      failedSteeringRepo(
        "pick_connection",
        {
          code: "choose_connection",
          message:
            "This organization has 2 GitHub organizations and GitLab groups. Choose the one that holds steering repos, then retry.",
        },
        { status: "blocked", provider: null, connectionChoices: CHOICES, ...overrides },
      );
    const IMPORTED = {
      outcome: "imported",
      steeringRepository: "acme/oxagen-core-platform",
      pullRequests: [
        {
          branch: "steering/import-workspace",
          number: 1,
          url: "https://github.com/acme/oxagen-core-platform/pull/1",
        },
        {
          branch: "steering/import-records",
          number: 2,
          url: "https://github.com/acme/oxagen-core-platform/pull/2",
        },
      ],
      cleanup: { number: 7, url: "https://github.com/acme/agent-harness/pull/7" },
      leftForAPerson: 0,
      rulesNeedingKind: [],
      constraintsNeedingEffect: [],
    };

    it("lists the organizations to choose from and goes on with the one picked", async () => {
      actions.retrySteeringRepoProvision.mockResolvedValue({
        ok: true,
        value: { status: "provisioning" },
      });
      provisioning(choosing());
      expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
      const use = screen.getByTestId("steering-repo-use-connection");
      expect(use).toBeDisabled();
      const chooser = screen.getByTestId("steering-repo-choose");
      await userEvent.click(within(chooser).getByRole("radio", { name: /acme-old/ }));
      expect(use).toBeEnabled();
      await userEvent.click(use);
      expect(actions.retrySteeringRepoProvision).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { connection: { provider: "github", id: 12 } },
      );
      await waitFor(() => {
        expect(nav.refresh).toHaveBeenCalledTimes(1);
      });
      expect(actions.importWorkspaceSteering).not.toHaveBeenCalled();
    });

    it("goes on through the import when a code repository still steers the workspace", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: true,
        value: IMPORTED,
      });
      provisioning(choosing({ legacySource: LEGACY_SOURCE }));
      const chooser = screen.getByTestId("steering-repo-choose");
      await userEvent.click(within(chooser).getByRole("radio", { name: /^acme(?!-old)/ }));
      await userEvent.click(screen.getByTestId("steering-repo-use-connection"));
      expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { connection: { provider: "github", id: 11 } },
      );
      expect(actions.retrySteeringRepoProvision).not.toHaveBeenCalled();
      const outcome = await screen.findByTestId("steering-repo-import-outcome");
      expect(outcome).toHaveTextContent(
        "Oxagen created acme/oxagen-core-platform and opened 2 steering PRs. Merge them in order, then the cleanup PR.",
      );
      expect(
        within(outcome).getByRole("link", { name: "Cleanup PR #7" }),
      ).toHaveAttribute("href", "https://github.com/acme/agent-harness/pull/7");
    });

    it("shows a member the choices' question and no picker (negative)", () => {
      provisioning(choosing(), { canAct: false });
      expect(screen.getByTestId("steering-repo-step-error")).toBeInTheDocument();
      expect(screen.queryByTestId("steering-repo-choose")).toBeNull();
    });

    it("offers Install and Authorize on GitHub when setup found no organization", () => {
      provisioning(
        failedSteeringRepo(
          "pick_connection",
          {
            code: "no_connection",
            message:
              "This organization has no GitHub organization with the Oxagen GitHub App installed and no GitLab group token. Connect one, then retry.",
          },
          { status: "blocked", provider: null },
        ),
      );
      for (const [testId, mode] of [
        ["steering-repo-connect-install", "install"],
        ["steering-repo-connect-authorize", "authorize"],
      ] as const) {
        const href = new URL(
          screen.getByTestId(testId).getAttribute("href") ?? "",
          "https://app.oxagen.sh",
        );
        expect(href.pathname).toBe("/api/v1/acme/connections/steering/github");
        expect(Object.fromEntries(href.searchParams)).toEqual({
          mode,
          return_to: RETURN_TO,
        });
      }
      expect(screen.getByTestId("steering-repo-retry")).toHaveTextContent("Retry");
    });

    it("moves steering in place of a retry while a code repository steers the workspace", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: false,
        reason: "conflict",
        code: "no_connection",
      });
      provisioning(
        failedSteeringRepo(
          "pick_connection",
          {
            code: "steering_import_required",
            message:
              "acme/agent-harness still steers this workspace through its .oxagen/ tree.",
          },
          { status: "blocked", provider: null, legacySource: LEGACY_SOURCE },
        ),
      );
      const move = screen.getByTestId("steering-repo-retry");
      expect(move).toHaveTextContent("Move steering");
      await userEvent.click(move);
      expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
        "acme",
        "core-platform",
      );
      expect(
        await screen.findByTestId("steering-repo-retry-failure"),
      ).toHaveTextContent("This was refused: no_connection.");
      // A refused import records where setup stopped, so the page reads it.
      expect(nav.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("the organization steering repos go to (#4899)", () => {
    const REFUSED = (overrides: Partial<SteeringRepoView> = {}) =>
      failedSteeringRepo(
        "create_repository",
        {
          code: "repository_create_refused",
          message:
            "GitHub refused to create a repository in acme-old: Due to policy, you are not permitted to perform that operation on this repository.",
        },
        {
          status: "blocked",
          connection: {
            provider: "github",
            id: 12,
            name: "acme-old",
            kind: "organization",
          },
          ...overrides,
        },
      );

    it("names it at the Host connection step and offers a different one", async () => {
      actions.retrySteeringRepoProvision.mockResolvedValue({
        ok: true,
        value: { status: "provisioning" },
      });
      provisioning(REFUSED());
      expect(screen.getByTestId("steering-repo-connection")).toHaveTextContent(
        "Steering repos go to the acme-old organization.",
      );
      await userEvent.click(screen.getByTestId("steering-repo-change-connection"));
      expect(actions.retrySteeringRepoProvision).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { resetConnection: true },
      );
    });

    it("resets through the import for a workspace still steered by a code repository", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: false,
        reason: "conflict",
        code: "choose_connection",
      });
      provisioning(REFUSED({ legacySource: LEGACY_SOURCE }));
      await userEvent.click(screen.getByTestId("steering-repo-change-connection"));
      expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { resetConnection: true },
      );
      expect(actions.retrySteeringRepoProvision).not.toHaveBeenCalled();
    });

    it("names a personal account as one", () => {
      provisioning(
        REFUSED({
          connection: { provider: "github", id: 13, name: "mac", kind: "user" },
        }),
      );
      expect(screen.getByTestId("steering-repo-connection")).toHaveTextContent(
        "Steering repos go to mac's personal account.",
      );
    });

    it("still offers a change when the repo there stopped before its first version", () => {
      provisioning(
        REFUSED({
          repository: GITHUB_REPOSITORY,
          failedStep: "apply_settings",
          error: { code: "github_plan_required", message: "Upgrade to GitHub Pro." },
        }),
      );
      expect(
        screen.getByTestId("steering-repo-change-connection"),
      ).toHaveTextContent("Use a different organization");
    });

    it("calls a GitLab location a group", () => {
      provisioning(
        REFUSED({
          provider: "gitlab",
          connection: {
            provider: "gitlab",
            id: 42,
            name: "acme/platform",
            kind: "organization",
          },
        }),
      );
      expect(screen.getByTestId("steering-repo-connection")).toHaveTextContent(
        "Steering repos go to the acme/platform group.",
      );
      expect(
        screen.getByTestId("steering-repo-change-connection"),
      ).toHaveTextContent("Use a different group");
    });

    it("offers no change once a repo there has a version, or to a member (negative)", () => {
      provisioning(REFUSED({ repository: GITHUB_REPOSITORY, publishedVersion: 1 }));
      expect(screen.getByTestId("steering-repo-connection")).toBeInTheDocument();
      expect(screen.queryByTestId("steering-repo-change-connection")).toBeNull();
      cleanup();
      provisioning(REFUSED(), { canAct: false });
      expect(screen.queryByTestId("steering-repo-change-connection")).toBeNull();
    });
  });

  describe("a setup that never started (#4875)", () => {
    it("draws every step waiting and starts the import from the workspace's old repository", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: false,
        reason: "conflict",
        code: "no_connection",
      });
      const root = provisioning(
        notStartedSteeringRepo({ legacySource: LEGACY_SOURCE }),
      );
      expect(root).toHaveAttribute("data-status", "not_started");
      expect(stepStates(root).every(([, state]) => state === "waiting")).toBe(true);
      expect(within(root).queryByRole("listitem", { current: "step" })).toBeNull();
      const start = screen.getByTestId("steering-repo-start");
      expect(start).toHaveTextContent("Move steering");
      await userEvent.click(start);
      expect(actions.importWorkspaceSteering).toHaveBeenCalledWith(
        "acme",
        "core-platform",
      );
    });

    it("creates the repo through the import when nothing steers the workspace", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: true,
        value: {
          outcome: "provisioned",
          steeringRepository: "acme/oxagen-core-platform",
          pullRequests: [],
          cleanup: null,
          leftForAPerson: 0,
          rulesNeedingKind: [],
          constraintsNeedingEffect: [],
        },
      });
      provisioning(notStartedSteeringRepo());
      const start = screen.getByTestId("steering-repo-start");
      expect(start).toHaveTextContent("Create the steering repo");
      await userEvent.click(start);
      expect(
        await screen.findByTestId("steering-repo-import-outcome"),
      ).toHaveTextContent("Oxagen created acme/oxagen-core-platform.");
    });

    it("says which choices the import needs before it can move anything", async () => {
      actions.importWorkspaceSteering.mockResolvedValue({
        ok: true,
        value: {
          outcome: "needs_choices",
          steeringRepository: null,
          pullRequests: [],
          cleanup: null,
          leftForAPerson: 0,
          rulesNeedingKind: ["rule-a", "rule-b"],
          constraintsNeedingEffect: ["constraint-a"],
        },
      });
      provisioning(notStartedSteeringRepo({ legacySource: LEGACY_SOURCE }));
      await userEvent.click(screen.getByTestId("steering-repo-start"));
      expect(
        await screen.findByTestId("steering-repo-import-outcome"),
      ).toHaveTextContent(
        "2 rules need a kind and 1 constraint needs an effect before Oxagen can move them. Nothing changed.",
      );
    });

    it("offers an empty steering repo, once a person confirms it, when the import refuses a retired sources connection", async () => {
      actions.importWorkspaceSteering
        .mockResolvedValueOnce({
          ok: false,
          reason: "conflict",
          code: "steering_import_legacy_connection",
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            outcome: "provisioned",
            steeringRepository: "acme/oxagen-core-platform",
            pullRequests: [],
            cleanup: null,
            leftForAPerson: 0,
            rulesNeedingKind: [],
            constraintsNeedingEffect: [],
          },
        });
      provisioning(notStartedSteeringRepo());
      expect(screen.queryByTestId("steering-repo-fresh")).toBeNull();
      await userEvent.click(screen.getByTestId("steering-repo-start"));
      const fresh = await screen.findByTestId("steering-repo-fresh");
      expect(fresh).toHaveTextContent(
        "This workspace reads its repository through a retired sources connection",
      );
      await userEvent.click(screen.getByTestId("steering-repo-start-fresh"));
      expect(actions.importWorkspaceSteering).toHaveBeenLastCalledWith(
        "acme",
        "core-platform",
        { startFresh: true },
      );
      expect(
        await screen.findByTestId("steering-repo-import-outcome"),
      ).toHaveTextContent("Oxagen created acme/oxagen-core-platform.");
      expect(screen.queryByTestId("steering-repo-fresh")).toBeNull();
    });

    it("offers no move out of a GitLab repository, which the import cannot read (negative)", () => {
      provisioning(
        notStartedSteeringRepo({
          legacySource: {
            fullName: "acme/platform",
            url: "https://gitlab.com/acme/platform",
            provider: "gitlab",
          },
        }),
      );
      expect(screen.queryByTestId("steering-repo-start")).toBeNull();
      expect(screen.getByTestId("steering-repo-gitlab-source")).toHaveTextContent(
        "Oxagen moves steering only out of GitHub repositories, and acme/platform is on GitLab.",
      );
    });

    it("offers a member no start (negative)", () => {
      provisioning(notStartedSteeringRepo(), { canAct: false });
      expect(screen.queryByTestId("steering-repo-start")).toBeNull();
    });
  });
});
