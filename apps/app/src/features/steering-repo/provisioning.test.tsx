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
  steeringRepoView,
} from "./steering-repo.builders";
import type { SteeringRepoView } from "./types";

const actions = vi.hoisted(() => ({
  retrySteeringRepoProvision: vi.fn(),
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
  message: "Oxagen Steering can no longer create repositories on this account.",
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
      app: "steering",
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
});
