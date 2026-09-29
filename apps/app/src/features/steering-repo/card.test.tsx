// @vitest-environment jsdom
// The steering repo card on the repositories page (#4518): the repository
// link, the published version, and the health row once the repo is ready.
// While it provisions, the step list takes the health row's place. When the
// read fails, the card says who was denied what, or which code the control
// plane answered, and draws no state. The page's section reads through the
// DataSource it is handed and decides that only an owner or admin may retry.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  failedSteeringRepo,
  GITHUB_REPOSITORY,
  GITLAB_REPOSITORY,
  steeringRepoSource,
  steeringRepoView,
} from "./steering-repo.builders";
import type { SteeringRepoRead } from "./types";

const actions = vi.hoisted(() => ({
  retrySteeringRepoProvision: vi.fn(),
  repairSteeringRepo: vi.fn(),
}));
vi.mock("./actions", () => actions);

const read = vi.hoisted(() => ({ readSteeringRepo: vi.fn() }));
vi.mock("./read", () => read);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { SteeringRepoCard } = await import("./card");
const { SteeringRepoSection } = await import("./section");

const RETURN_TO = routes.repositories("acme", "core-platform");

const UNREACHABLE: SteeringRepoRead = {
  kind: "failed",
  failure: readError("installation_unreachable", 503),
};

const DENIED: SteeringRepoRead = {
  kind: "failed",
  failure: { ok: false, reason: "denied", permission: "repository.read" },
};

const FAILED = failedSteeringRepo("create_repository", {
  code: "repository_name_taken",
  message: "GitHub already has a repository named acme/oxagen-core-platform.",
});

function card(answer: SteeringRepoRead, { canAct = true } = {}) {
  render(
    <IntlProvider>
      <SteeringRepoCard
        org="acme"
        ws="core-platform"
        read={answer}
        canAct={canAct}
        returnTo={RETURN_TO}
      />
    </IntlProvider>,
  );
  return screen.getByTestId("steering-repo-card");
}

beforeEach(() => {
  actions.retrySteeringRepoProvision.mockReset();
  actions.repairSteeringRepo.mockReset();
  read.readSteeringRepo.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the steering repo card", () => {
  it("names the code the control plane answered and draws no state when the read fails", () => {
    const root = card(UNREACHABLE);
    expect(root).toHaveAttribute("data-kind", "failed");
    expect(root).not.toHaveAttribute("data-health");
    expect(
      within(root).getByRole("heading", { level: 2, name: "Steering repo" }),
    ).toBeInTheDocument();
    const failure = root.querySelector("[data-reason]");
    expect(failure).toHaveAttribute("data-reason", "error");
    expect(failure).toHaveTextContent(
      "Steering repo could not be loaded: the control plane answered installation_unreachable. Nothing was changed, and runs kept recording.",
    );
    expect(screen.queryByTestId("steering-repo-version")).toBeNull();
    expect(screen.queryByTestId("steering-repo-health")).toBeNull();
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
  });

  it("names the permission a denied viewer lacks and draws no state", () => {
    const root = card(DENIED);
    expect(root).toHaveAttribute("data-kind", "failed");
    const failure = root.querySelector("[data-reason]");
    expect(failure).toHaveAttribute("data-reason", "denied");
    expect(failure).toHaveTextContent(
      "You cannot see Steering repo in this workspace. Your roles do not include repository.read. An organization owner can grant it.",
    );
    expect(screen.queryByTestId("steering-repo-link")).toBeNull();
    expect(screen.queryByTestId("steering-repo-version")).toBeNull();
  });

  it("links a ready repository on GitHub and shows its version and health", () => {
    const root = card({ kind: "ok", view: steeringRepoView() });
    expect(root).toHaveAttribute("data-kind", "ok");
    expect(root).toHaveAttribute("data-health", "healthy");
    const link = screen.getByTestId("steering-repo-link");
    expect(link).toHaveTextContent(GITHUB_REPOSITORY.fullName);
    expect(link).toHaveAttribute("href", GITHUB_REPOSITORY.url);
    expect(screen.getByTestId("steering-repo-version")).toHaveTextContent(
      "Version 3",
    );
    const health = screen.getByTestId("steering-repo-health");
    expect(health).toHaveTextContent("Healthy");
    expect(health).toHaveTextContent(
      "Every prescribed setting matches, and main holds only merged steering PRs.",
    );
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
  });

  it("links a ready repository on GitLab", () => {
    card({
      kind: "ok",
      view: steeringRepoView({
        provider: "gitlab",
        repository: GITLAB_REPOSITORY,
      }),
    });
    const link = screen.getByTestId("steering-repo-link");
    expect(link).toHaveTextContent(GITLAB_REPOSITORY.fullName);
    expect(link).toHaveAttribute("href", GITLAB_REPOSITORY.url);
  });

  it("shows the name alone for a repository URL on neither host (negative)", () => {
    card({
      kind: "ok",
      view: steeringRepoView({
        repository: {
          fullName: "acme/oxagen-core-platform",
          url: "https://git.acme.example/acme/oxagen-core-platform",
        },
      }),
    });
    const link = screen.getByTestId("steering-repo-link");
    expect(link).toHaveTextContent("acme/oxagen-core-platform");
    expect(link).not.toHaveAttribute("href");
  });

  it.each([
    [
      "drifted",
      "Settings drift",
      "A prescribed setting differs, so Oxagen merges and publishes nothing until an owner or admin repairs it.",
    ],
    [
      "disconnected",
      "Disconnected",
      "Oxagen Steering lost its grant, so Oxagen merges and publishes nothing until an owner or admin authorizes it again.",
    ],
    [
      "diverged",
      "Unmerged commit on main",
      "Main has a commit no steering PR merged, so Oxagen opened a steering PR that reverts it.",
    ],
  ] as const)("labels a %s repo %s with its note", (health, label, note) => {
    const root = card({ kind: "ok", view: steeringRepoView({ health }) });
    expect(root).toHaveAttribute("data-health", health);
    const row = screen.getByTestId("steering-repo-health");
    expect(row).toHaveTextContent(label);
    expect(row).toHaveTextContent(note);
  });

  it("labels a ready repo Unread before the first health read", () => {
    const root = card({
      kind: "ok",
      view: steeringRepoView({ health: null }),
    });
    expect(root).toHaveAttribute("data-health", "none");
    const row = screen.getByTestId("steering-repo-health");
    expect(row).toHaveTextContent("Unread");
    expect(row).toHaveTextContent(
      "Oxagen has not read the repository's health yet.",
    );
  });

  it("shows the provisioning steps in place of the health row while the repo provisions", () => {
    const root = card({
      kind: "ok",
      view: steeringRepoView({
        status: "provisioning",
        step: "pick_connection",
        repository: null,
        publishedVersion: null,
        health: null,
      }),
    });
    expect(root).toHaveAttribute("data-health", "none");
    expect(root).toHaveTextContent("Not created yet");
    expect(screen.queryByTestId("steering-repo-link")).toBeNull();
    expect(screen.getByTestId("steering-repo-version")).toHaveTextContent(
      "None yet",
    );
    expect(screen.queryByTestId("steering-repo-health")).toBeNull();
    expect(screen.getByTestId("steering-repo-provisioning")).toHaveAttribute(
      "data-status",
      "provisioning",
    );
  });

  it("shows an owner or admin Retry on a failed step", () => {
    card({ kind: "ok", view: FAILED });
    expect(screen.getByTestId("steering-repo-retry")).toHaveTextContent(
      "Retry",
    );
  });

  it("shows a member the failed step and no Retry (negative)", () => {
    card({ kind: "ok", view: FAILED }, { canAct: false });
    expect(screen.getByTestId("steering-repo-step-error")).toHaveTextContent(
      "GitHub already has a repository named acme/oxagen-core-platform.",
    );
    expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
  });
});

describe("the repositories page's steering repo section", () => {
  function ctx(orgRole: "owner" | "admin" | "member" | "viewer") {
    return unsafeMint(WsCtx, {
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole,
      workspaceId: "7b000000-0000-4000-8000-000000000001",
      wsSlug: "core-platform",
      wsName: "Core platform",
      wsRole: "member",
    });
  }

  async function section(
    answer: SteeringRepoRead,
    orgRole: Parameters<typeof ctx>[0],
  ) {
    read.readSteeringRepo.mockResolvedValue(answer);
    const viewer = ctx(orgRole);
    const { source } = steeringRepoSource(readOk(steeringRepoView()));
    render(
      <IntlProvider>
        {await SteeringRepoSection({ ctx: viewer, source })}
      </IntlProvider>,
    );
    expect(read.readSteeringRepo).toHaveBeenCalledWith(source, viewer);
    return screen.getByTestId("steering-repo-card");
  }

  it("says why the card has no state when the read fails", async () => {
    const root = await section(DENIED, "owner");
    expect(root).toHaveAttribute("data-kind", "failed");
    expect(root.querySelector("[data-reason]")).toHaveAttribute(
      "data-reason",
      "denied",
    );
  });

  it.each(["owner", "admin"] as const)(
    "offers an org %s Retry on a failed step",
    async (orgRole) => {
      await section({ kind: "ok", view: FAILED }, orgRole);
      expect(screen.getByTestId("steering-repo-retry")).toBeInTheDocument();
    },
  );

  it.each(["member", "viewer"] as const)(
    "shows an org %s the failed step and no Retry (negative)",
    async (orgRole) => {
      await section({ kind: "ok", view: FAILED }, orgRole);
      expect(
        screen.getByTestId("steering-repo-step-error"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("steering-repo-retry")).toBeNull();
    },
  );

  it("returns an owner who re-authorizes to the repositories page", async () => {
    await section(
      {
        kind: "ok",
        view: failedSteeringRepo(
          "add_to_installation",
          {
            code: "steering_reauthorize",
            message:
              "Oxagen Steering can no longer create repositories on this account.",
          },
          { status: "blocked" },
        ),
      },
      "owner",
    );
    const link = screen.getByTestId("steering-repo-reauthorize-link");
    const href = new URL(
      link.getAttribute("href") ?? "",
      "https://app.oxagen.sh",
    );
    expect(href.searchParams.get("return_to")).toBe(RETURN_TO);
  });
});
