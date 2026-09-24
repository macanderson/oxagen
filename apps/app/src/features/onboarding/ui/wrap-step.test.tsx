// @vitest-environment jsdom
// Onboarding step 2 as an operator drives it: the three harness tabs and their
// panels word for word, the one-time token minted when the step opens and the
// enroll command built from it, Download for <OS> saying no package is
// published, the SDK credential and five lines, the continue that moves the
// gate, and a workspace with no agent to wrap.
import {
  act,
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

const { router, issueEnrollmentToken, advanceOnboarding } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  issueEnrollmentToken: vi.fn(),
  advanceOnboarding: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../actions", () => ({ issueEnrollmentToken, advanceOnboarding }));

const { WrapStep, tabFor, fiveLines } = await import("./wrap-step");

const TOKEN = "oxe_1time_7qk4m2nv9xr3t8zp7qk4m2nv9x";
const NEXT = routes.welcome("aintel", "core", "run", { agent: "agt_rm" });
const AGENT = {
  id: "agt_rm",
  key: "aintel.core.release-manager",
  harness: "claude-code",
  credentialPrefix: "oxa_live_3f7a",
};

function renderStep(props: Partial<Parameters<typeof WrapStep>[0]> = {}): void {
  render(
    <IntlProvider>
      <WrapStep
        org="aintel"
        ws="core"
        agent={AGENT}
        gated
        back={routes.newOrganization()}
        cancel={routes.fleet("aintel", "core")}
        register={routes.register("aintel", "core", "name")}
        next={NEXT}
        {...props}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  router.push.mockReset();
  issueEnrollmentToken.mockReset();
  advanceOnboarding.mockReset();
  issueEnrollmentToken.mockResolvedValue({
    ok: true,
    value: {
      token: TOKEN,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      agentKey: AGENT.key,
      enrollCommand: `oxagen agent enroll --token ${TOKEN}`,
    },
  });
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("tabFor", () => {
  it("opens a registered harness on its tab", () => {
    expect(tabFor("claude-code")).toBe("cc");
    expect(tabFor("cursor")).toBe("cc");
    expect(tabFor("stella")).toBe("cc");
    expect(tabFor("codex")).toBe("codex");
    expect(tabFor("claude-agent-sdk")).toBe("sdk");
    expect(tabFor("custom")).toBe("sdk");
  });
});

describe("fiveLines", () => {
  it("writes the agent key into each language's wrap", () => {
    for (const lang of ["ts", "py", "go"] as const)
      expect(fiveLines(lang, "a.b.c")).toContain('"a.b.c"');
  });
});

describe("WrapStep", () => {
  it("draws the header, the tabs with their sub-lines and the Claude Code panel, then mints the token once", async () => {
    renderStep();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Wrap an agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The installer carries a one-time enrollment token for/),
    ).toHaveTextContent(
      "The installer carries a one-time enrollment token for aintel.core.release-manager, so nothing is copied or pasted.",
    );
    const tabs = within(
      screen.getByRole("tablist", { name: "How to wrap the agent" }),
    ).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Claude Codeone click · harness",
      "Codex CLIone click · harness",
      "SDK agentfive lines · harness",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "wrap-tab-cc");
    expect(
      within(panel).getByRole("heading", { name: "Claude Code recommended" }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "The installer writes the hooks, installs the oxagend collector",
    );
    const ladder = within(screen.getByTestId("tier-ladder"));
    expect(
      [...screen.getByTestId("tier-ladder").querySelectorAll("dd")].map(
        (dd) => dd.textContent,
      ),
    ).toEqual(["harness", "gateway", "contained"]);
    expect(ladder.getByText("This agent")).toBeInTheDocument();
    expect(
      within(screen.getByRole("tablist", { name: "Operating system" }))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["macOS", "Windows", "Linux"]);
    expect(
      await screen.findByTestId("enrollment-token-value"),
    ).toHaveTextContent(TOKEN);
    expect(screen.getByTestId("enrollment-token")).toHaveTextContent(
      "expires in 30 min · single use",
    );
    expect(screen.getByTestId("wrap-enroll-command")).toHaveTextContent(
      `oxagen agent enroll --token ${TOKEN} --harness claude-code`,
    );
    expect(issueEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(issueEnrollmentToken).toHaveBeenCalledWith(
      "aintel",
      "core",
      "agt_rm",
    );
    // The one gold action is Download for macOS; the continue is plain.
    expect(screen.getByTestId("wrap-download")).toHaveTextContent(
      "Download for macOS",
    );
    expect(screen.getByTestId("wrap-download").className).toContain(
      "bg-button-primary-bg",
    );
    expect(
      screen.getByRole("button", {
        name: "I have already installed it — continue",
      }).className,
    ).not.toContain("bg-button-primary-bg");
  });

  it("answers Download with the command, since no signed package is published", async () => {
    renderStep();
    await userEvent.click(screen.getByRole("tab", { name: "Linux" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Download for Linux" }),
    );
    expect(screen.getByTestId("wrap-status")).toHaveTextContent(
      "No signed installer is published for Linux yet",
    );
    expect(screen.getByTestId("wrap-package-not-backed")).toHaveTextContent(
      "no signed package is published",
    );
    // The plain app is published, and it is what puts the CLI on the host.
    expect(screen.getByRole("link", { name: "AppImage" })).toHaveAttribute(
      "href",
      "https://downloads.oxagen.sh/latest/Oxagen_amd64.AppImage",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the Codex CLI tab carries the profile, or observe on the ladder, and its harness flag", async () => {
    renderStep();
    await screen.findByTestId("enrollment-token-value");
    await userEvent.click(screen.getByRole("tab", { name: /Codex CLI/ }));
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("data-tab", "codex");
    expect(panel).toHaveTextContent("~/.codex/config.toml");
    expect(within(panel).getByText("or observe")).toBeInTheDocument();
    expect(within(panel).getByText(/profile: codex-cli/)).toBeInTheDocument();
    expect(screen.getByTestId("wrap-enroll-command")).toHaveTextContent(
      "--harness codex",
    );
  });

  it("the SDK tab has no gold action, shows the credential prefix, and copies the five lines", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderStep({ agent: { ...AGENT, harness: "claude-agent-sdk" } });
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("data-tab", "sdk");
    expect(screen.getByTestId("wrap-credential")).toHaveTextContent(
      "issued once to the operatoroxa_live_3f7a••••hashed at rest · purpose-locked · revocable",
    );
    expect(within(panel).queryByTestId("wrap-download")).toBeNull();
    expect(
      [...document.querySelectorAll("button")].filter((b) =>
        b.className.includes("bg-button-primary-bg"),
      ),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: "Python" }));
    expect(screen.getByTestId("wrap-five-lines")).toHaveTextContent(
      'key="aintel.core.release-manager"',
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy the five lines" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      fiveLines("py", "aintel.core.release-manager"),
    );
    expect(screen.getByTestId("wrap-status")).toHaveTextContent(
      "Five lines copied.",
    );
  });

  it("moves the gate to its run step, then continues; a refusal stays on the step (negative)", async () => {
    advanceOnboarding.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderStep();
    const cont = screen.getByRole("button", {
      name: "I have already installed it — continue",
    });
    await userEvent.click(cont);
    expect(await screen.findByTestId("advance-failure")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    advanceOnboarding.mockResolvedValueOnce({
      ok: true,
      value: { step: "run", changedAt: "2026-09-23T00:00:00.000Z" },
    });
    await userEvent.click(cont);
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(NEXT);
    });
    expect(advanceOnboarding).toHaveBeenLastCalledWith("aintel", "core", "run");
  });

  it("outside an open gate continues without moving it", async () => {
    renderStep({ gated: false });
    await userEvent.click(
      screen.getByRole("button", {
        name: "I have already installed it — continue",
      }),
    );
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(NEXT);
    });
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("names a refused mint and mints again on request (negative)", async () => {
    issueEnrollmentToken.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderStep();
    expect(await screen.findByTestId("wrap-token-failure")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Issue another token" }),
    );
    expect(
      await screen.findByTestId("enrollment-token-value"),
    ).toHaveTextContent(TOKEN);
  });

  it("with no agent to wrap, names the gap, links to registration and mints nothing", async () => {
    renderStep({ agent: null });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(screen.getByTestId("wrap-no-agent")).toHaveTextContent(
      "No agent to wrap yet",
    );
    expect(
      screen.getByRole("link", { name: "Register an agent" }),
    ).toHaveAttribute("href", "/aintel/core/register/name");
    expect(
      screen.getByText(
        "The installer carries a one-time enrollment token for the agent, so nothing is copied or pasted.",
      ),
    ).toBeInTheDocument();
    expect(issueEnrollmentToken).not.toHaveBeenCalled();
  });
});
