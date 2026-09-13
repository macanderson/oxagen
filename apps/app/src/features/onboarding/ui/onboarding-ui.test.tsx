// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "../../auth/test-intl";
import { firstFrameFor } from "@/data/adapters/fixture";
import { seed } from "@/data/adapters/fixture/seed";

const FIXTURE_INSTALLER = seed.onboarding.installer;
const FIXTURE_REPOSITORY = seed.onboarding.repository;

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const createOrganizationAction = vi.fn();
vi.mock("../actions", () => ({ createOrganizationAction }));

const { WrapPanel, harnessFor } = await import("./wrap-panel");
const { FirstFramePanel, linesShown, AUTO_OPEN_SECONDS } = await import(
  "./first-frame-panel"
);
const { RepoPanel } = await import("./repo-panel");
const { OrganizationForm } = await import("./organization-form");
const { NameAgentForm } = await import("./name-agent-form");

function renderWithIntl(ui: ReactNode) {
  return render(<IntlProvider>{ui}</IntlProvider>);
}

beforeEach(() => {
  router.push.mockReset();
  createOrganizationAction.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WrapPanel", () => {
  const base = {
    agentKey: "acme.core.perf-watch",
    initialMethod: "claude-code" as const,
    initialHarness: "claude-code" as const,
    installer: FIXTURE_INSTALLER,
    runPath: "/welcome/run",
    runQuery: { org: "acme", ws: "core-platform" },
    backHref: "/welcome",
  };

  it("offers the one-click installer with the embedded token, and carries the harness to the run step", () => {
    renderWithIntl(<WrapPanel {...base} />);
    expect(screen.getByRole("tab", { name: /Claude Code/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(FIXTURE_INSTALLER.token)).toBeInTheDocument();
    expect(screen.getByTestId("wrap-download")).toHaveAttribute(
      "href",
      "/welcome/run?org=acme&ws=core-platform&harness=claude-code",
    );
    expect(
      screen.getByText(
        `oxagen agent enroll --token ${FIXTURE_INSTALLER.token}`,
      ),
    ).toBeInTheDocument();
  });

  it("switches platform builds and methods; each method names its harness on the way to run", async () => {
    renderWithIntl(<WrapPanel {...base} />);
    await userEvent.click(screen.getByRole("tab", { name: "Windows" }));
    expect(screen.getByText(/Oxagen-Agent-2.4.0.msi/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Codex CLI/ }));
    expect(screen.getByTestId("wrap-continue")).toHaveAttribute(
      "href",
      expect.stringContaining("harness=codex-cli"),
    );
    expect(screen.getByText(/--harness codex-cli/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /SDK agent/ }));
    expect(screen.getByTestId("sdk-snippet")).toHaveTextContent(
      'key: "acme.core.perf-watch"',
    );
    expect(screen.getByTestId("wrap-continue")).toHaveAttribute(
      "href",
      expect.stringContaining("harness=custom"),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Go" }));
    expect(screen.getByTestId("sdk-snippet")).toHaveTextContent(
      "oxagen.Agent.Wrap",
    );
  });

  it("copies the five lines", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithIntl(
      <WrapPanel {...base} initialMethod="sdk" initialHarness="stella" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy the five lines" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("oxagen.agent.wrap"),
    );
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("moves between method tabs with the keyboard", () => {
    renderWithIntl(<WrapPanel {...base} />);
    const first = screen.getByRole("tab", { name: /Claude Code/ });
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /SDK agent/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /SDK agent/ }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: /Claude Code/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Claude Code/ }), {
      key: "ArrowDown",
    });
    expect(screen.getByRole("tab", { name: /Codex CLI/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: /Codex CLI/ }), {
      key: "Enter",
    });
    expect(screen.getByRole("tab", { name: /Codex CLI/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("without a backed installer shows the notice and the token-less CLI path", () => {
    renderWithIntl(
      <WrapPanel
        {...base}
        installer={null}
        installerNotice={<p>not recorded yet</p>}
      />,
    );
    expect(screen.getByText("not recorded yet")).toBeInTheDocument();
    expect(screen.getByText("oxagen agent enroll")).toBeInTheDocument();
    expect(screen.queryByTestId("wrap-download")).toBeNull();
  });

  it("maps an SDK choice to a harness", () => {
    expect(harnessFor("sdk", "claude-code")).toBe("custom");
    expect(harnessFor("sdk", "stella")).toBe("stella");
    expect(harnessFor("codex-cli", "stella")).toBe("codex-cli");
  });
});

describe("FirstFramePanel", () => {
  const script = firstFrameFor(seed.onboarding.firstFrame, {
    agentKey: "acme.core.perf-watch",
    harness: "claude-code",
    operator: "Marcus Bell",
  });

  it("waits line by line, flips to connected on the first frame, then opens Fleet", () => {
    vi.useFakeTimers();
    renderWithIntl(
      <FirstFramePanel
        mode="gate"
        script={script}
        agentKey="acme.core.perf-watch"
        harnessLabel="Claude Code"
        openHref="/acme/core-platform"
      />,
    );
    expect(screen.getByTestId("first-frame-waiting")).toHaveTextContent(
      "acme.core.perf-watch",
    );
    for (let i = 0; i < script.log.length; i++) {
      act(() => {
        vi.advanceTimersByTime(script.paceMs);
      });
    }
    expect(screen.getByTestId("first-frame-connected")).toHaveTextContent(
      "First frame received",
    );
    expect(
      screen.getByRole("link", { name: "Open Mission Control" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    for (let i = 0; i < AUTO_OPEN_SECONDS; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(router.push).toHaveBeenCalledWith("/acme/core-platform");
  });

  it("names the register flow's button", () => {
    vi.useFakeTimers();
    renderWithIntl(
      <FirstFramePanel
        mode="register"
        script={{ ...script, log: [] }}
        agentKey="k"
        harnessLabel="Codex CLI"
        openHref="/acme/core-platform"
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open in Fleet" }),
    ).toBeInTheDocument();
  });

  it("never shows more lines than there are", () => {
    expect(linesShown(10, 3)).toBe(3);
    expect(linesShown(-1, 3)).toBe(0);
  });
});

describe("RepoPanel", () => {
  it("binds the detected repository, or leaves the workspace provisional and binds later", async () => {
    renderWithIntl(<RepoPanel repo={FIXTURE_REPOSITORY} />);
    expect(screen.getByTestId("repo-detected")).toHaveTextContent(
      FIXTURE_REPOSITORY.remote,
    );
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByTestId("repo-skipped")).toHaveTextContent("14 days");
    await userEvent.click(
      screen.getByRole("button", { name: "Bind acme/platform now" }),
    );
    expect(screen.getByTestId("repo-bound")).toBeInTheDocument();
  });

  it("binds in one click", async () => {
    renderWithIntl(<RepoPanel repo={FIXTURE_REPOSITORY} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Bind acme/platform as the main repo",
      }),
    );
    expect(screen.getByTestId("repo-bound")).toBeInTheDocument();
  });
});

describe("OrganizationForm", () => {
  it("derives the address and namespace from the name until they are edited", async () => {
    renderWithIntl(<OrganizationForm />);
    await userEvent.type(
      screen.getByLabelText("Organization name"),
      "Acme Robotics",
    );
    expect(screen.getByLabelText("Address")).toHaveValue("acme-robotics");
    expect(screen.getByLabelText("Namespace")).toHaveValue("acme");
    await userEvent.clear(screen.getByLabelText("Namespace"));
    await userEvent.type(screen.getByLabelText("Namespace"), "acr");
    await userEvent.type(screen.getByLabelText("Organization name"), "!");
    expect(screen.getByLabelText("Namespace")).toHaveValue("acr");
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "Core Platform",
    );
    expect(screen.getByLabelText("Workspace address")).toHaveValue(
      "core-platform",
    );
  });

  it("validates before calling the action", async () => {
    renderWithIntl(<OrganizationForm />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByText("Enter the organization's name."),
    ).toBeInTheDocument();
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });

  it("moves on to wrap, or shows what the server refused", async () => {
    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      fields: { slug: "slugTaken" },
    });
    renderWithIntl(<OrganizationForm initialName="Acme Robotics" />);
    await userEvent.type(
      screen.getByLabelText("Workspace name"),
      "core-platform",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(
        "That address belongs to another organization. Pick a different one.",
      ),
    ).toBeInTheDocument();

    createOrganizationAction.mockResolvedValueOnce({
      ok: false,
      error: "failed",
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByTestId("organization-failed"),
    ).toBeInTheDocument();

    createOrganizationAction.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByTestId("organization-failed"),
    ).toBeInTheDocument();

    createOrganizationAction.mockResolvedValueOnce({
      ok: true,
      to: "/welcome/wrap?org=acme-robotics&ws=core-platform",
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        "/welcome/wrap?org=acme-robotics&ws=core-platform",
      );
    });
  });
});

describe("NameAgentForm", () => {
  const props = {
    org: { slug: "acme", namespace: "acme" },
    ws: { slug: "core-platform", name: "core-platform", namespace: "core" },
    cancelHref: "/acme/core-platform",
  };

  it("previews the key, validates the slug and carries the choice to wrap", async () => {
    renderWithIntl(<NameAgentForm {...props} />);
    await userEvent.type(screen.getByLabelText("Slug"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByText("Use 2–40 lowercase letters, digits and hyphens."),
    ).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Slug"));
    await userEvent.type(screen.getByLabelText("Slug"), "Perf Watch");
    expect(
      screen.getByText("The agent key becomes acme.core.perf-watch."),
    ).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText("Harness"),
      "codex-cli",
    );
    await userEvent.selectOptions(screen.getByLabelText("Model tier"), "light");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(router.push).toHaveBeenCalledWith(
      "/acme/core-platform/register/wrap?agent=perf-watch&harness=codex-cli&tier=light",
    );
  });

  it("keeps an earlier choice when coming back", () => {
    renderWithIntl(
      <NameAgentForm
        {...props}
        initial={{ agent: "perf-watch", harness: "stella", tier: "light" }}
      />,
    );
    expect(screen.getByLabelText("Slug")).toHaveValue("perf-watch");
    expect(screen.getByLabelText("Harness")).toHaveValue("stella");
  });
});
