// @vitest-environment jsdom
// The client islands of Register an agent, driven the way an operator drives
// them: the name form's live key, its refusal and its one write; the wrap
// step's harness, OS and SDK tabs, the token and credential it issues, and its
// continue; the run step's countdown to Fleet; Cancel before and after the
// identity exists; and the Request access dialog. Every write is answered ok
// and refused, so each refusal path renders its sentence and changes nothing.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NamedRuntimeList } from "@/data/contracts/runtimes";
import type { ToolbeltList } from "@/data/contracts/toolbelts";
import { type Read, readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { toolbeltList } from "./onboarding.builders";
import type { ReservedAgent } from "./ui/register-form";

const {
  router,
  registerAgent,
  issueEnrollmentToken,
  advanceOnboarding,
  cancelRegistration,
  issueAgentCredential,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  registerAgent: vi.fn(),
  issueEnrollmentToken: vi.fn(),
  advanceOnboarding: vi.fn(),
  cancelRegistration: vi.fn(),
  issueAgentCredential: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  registerAgent,
  issueEnrollmentToken,
  advanceOnboarding,
  bindMainRepository: vi.fn(),
}));
vi.mock("./register-actions", () => ({
  cancelRegistration,
  issueAgentCredential,
  readRegisterPlace: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { RegisterAgentForm } = await import("./ui/register-form");
const { WrapAgent } = await import("./ui/wrap-agent");
const { OpenInFleet } = await import("./ui/first-frame");
const { CancelRegistration } = await import("./ui/cancel-registration");
const { RequestAccess } = await import("./ui/request-access");

const ORG = "acme";
const WS = "core-platform";
const FLEET = routes.fleet(ORG, WS);
const NEXT = routes.register(ORG, WS, "run", { agent: "agt_releasebot" });
const BACK = routes.register(ORG, WS, "name", { agent: "agt_releasebot" });
const PLACE = { keyPrefix: "a-intel.core", repository: "a-intel/platform" };

const DENIED = {
  ok: false,
  reason: "denied",
  code: "org_role_required",
} as const;

/** Mac's laptop runs Claude Code as mac-claude; the build box runs nothing yet. */
const RUNTIMES: NamedRuntimeList = {
  runtimes: [
    {
      id: "rtm_macslaptop",
      name: "Mac's laptop",
      slug: "macs-laptop",
      createdAt: "2026-09-20T10:00:00.000Z",
      agents: [
        {
          id: "agt_macclaude",
          name: "Mac Claude",
          slug: "mac-claude",
          harness: "claude-code",
        },
      ],
      liveHosts: 1,
      lastSeenAt: null,
    },
    {
      id: "rtm_buildbox",
      name: "Build box",
      slug: "build-box",
      createdAt: "2026-09-21T10:00:00.000Z",
      agents: [],
      liveHosts: 0,
      lastSeenAt: null,
    },
  ],
};

type FormOptions = {
  reserved?: ReservedAgent | null;
  runtimes?: Read<NamedRuntimeList>;
  toolbelts?: Read<ToolbeltList>;
  initialRuntime?: string | null;
};

function renderForm({
  reserved = null,
  runtimes = readOk(RUNTIMES),
  toolbelts = readOk(toolbeltList()),
  initialRuntime = null,
}: FormOptions = {}) {
  render(
    <IntlProvider>
      <RegisterAgentForm
        org={ORG}
        ws={WS}
        place={PLACE}
        reserved={reserved}
        runtimes={runtimes}
        toolbelts={toolbelts}
        initialRuntime={initialRuntime}
        wrap={
          reserved === null
            ? null
            : routes.register(ORG, WS, "wrap", { agent: reserved.id })
        }
        fleet={FLEET}
      />
    </IntlProvider>,
  );
}

const harnessOption = (name: RegExp) =>
  within(screen.getByRole("radiogroup", { name: "Harness" })).getByRole(
    "radio",
    { name },
  );
const runtimeOption = (name: RegExp) =>
  within(screen.getByRole("radiogroup", { name: "Runtime" })).getByRole(
    "radio",
    { name },
  );

function renderWrap(
  harness: "claude-code" | "codex" | "cursor" | "stella" | "custom",
  gated = false,
) {
  render(
    <IntlProvider>
      <WrapAgent
        org={ORG}
        ws={WS}
        agentId="agt_releasebot"
        harness={harness}
        credentialPrefix="oxa_ag_7f"
        gated={gated}
        back={BACK}
        next={NEXT}
        fleet={FLEET}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
  registerAgent.mockReset();
  issueEnrollmentToken.mockReset();
  advanceOnboarding.mockReset();
  cancelRegistration.mockReset();
  issueAgentCredential.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
});

describe("the name step", () => {
  it("asks for the name, slug, harness, runtime and toolbelt (ADR-198)", () => {
    renderForm();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toBeInTheDocument();
    expect(
      within(screen.getByRole("radiogroup", { name: "Harness" }))
        .getAllByRole("radio")
        .map((o) => o.getAttribute("data-value")),
    ).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-agent-sdk",
      "custom",
    ]);
    expect(
      within(screen.getByRole("radiogroup", { name: "Runtime" }))
        .getAllByRole("radio")
        .map((o) => o.getAttribute("data-value")),
    ).toEqual(["rtm_macslaptop", "rtm_buildbox"]);
    expect(
      screen.getByRole("radiogroup", { name: "Toolbelt" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Model tier")).toBeNull();
  });

  it("fills the slug from the name, dropping apostrophes, until the slug is edited", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Name"), "Mac's Codex");
    expect(screen.getByLabelText("Slug")).toHaveValue("macs-codex");
    expect(
      screen.getAllByTestId("register-key").map((k) => k.textContent),
    ).toEqual(["a-intel.core.macs-codex", "a-intel.core.macs-codex"]);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "codex-one");
    await user.type(screen.getByLabelText("Name"), " again");
    expect(screen.getByLabelText("Slug")).toHaveValue("codex-one");
  });

  it("keeps a runtime already running the chosen harness visible, disabled, with the reason", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(harnessOption(/Claude Code/));
    const taken = runtimeOption(/Mac's laptop/);
    expect(taken).toHaveAttribute("aria-disabled", "true");
    expect(taken).toHaveAccessibleDescription(
      "Claude Code already runs on Mac's laptop as mac-claude.",
    );
    expect(runtimeOption(/Build box/)).not.toHaveAttribute("aria-disabled");
    await user.click(taken);
    expect(taken).toHaveAttribute("aria-checked", "false");
  });

  it("keeps a harness the chosen runtime already runs visible, disabled, with the reason", () => {
    renderForm({ initialRuntime: "rtm_macslaptop" });
    expect(runtimeOption(/Mac's laptop/)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const taken = harnessOption(/Claude Code/);
    expect(taken).toHaveAttribute("aria-disabled", "true");
    expect(taken).toHaveAccessibleDescription(
      "Claude Code already runs on Mac's laptop as mac-claude.",
    );
    expect(harnessOption(/Codex/)).not.toHaveAttribute("aria-disabled");
  });

  it("refuses a registration with no runtime chosen, without calling the write (negative)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Name"), "Perf watch");
    await user.click(harnessOption(/Codex/));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(registerAgent).not.toHaveBeenCalled();
    expect(
      screen.getByText("Choose the runtime this agent runs on."),
    ).toBeInTheDocument();
  });

  it("registers the agent on its runtime with the chosen toolbelt and opens the wrap step", async () => {
    const user = userEvent.setup();
    const to = routes.register(ORG, WS, "wrap", { agent: "agt_perfwatch" });
    registerAgent.mockResolvedValue({
      ok: true,
      value: {
        agentId: "agt_perfwatch",
        agentKey: "a-intel.core.perf-watch",
        to,
      },
    });
    renderForm();
    await user.type(screen.getByLabelText("Name"), "Perf watch");
    await user.click(harnessOption(/Codex/));
    await user.click(runtimeOption(/Build box/));
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Toolbelt" })).getByRole(
        "radio",
        { name: /Review belt/ },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(registerAgent).toHaveBeenCalledWith(ORG, WS, {
      name: "Perf watch",
      slug: "perf-watch",
      harness: "codex",
      runtimeId: "rtm_buildbox",
      toolbeltId: "tbt_reviewbelt",
    });
    expect(router.push).toHaveBeenCalledWith(to);
  });

  it("completes the toolbelt step when the workspace has no tools, and links to importing MCP servers", async () => {
    const user = userEvent.setup();
    registerAgent.mockResolvedValue({
      ok: true,
      value: {
        agentId: "agt_perfwatch",
        agentKey: null,
        to: routes.register(ORG, WS, "wrap", { agent: "agt_perfwatch" }),
      },
    });
    renderForm({ toolbelts: readOk(toolbeltList(0)) });
    const empty = screen.getByTestId("register-toolbelt-empty");
    expect(
      within(empty).getByTestId("register-toolbelt-done"),
    ).toHaveTextContent("Done");
    expect(empty).toHaveTextContent(
      "There is no toolbelt to choose yet because this workspace has no tools.",
    );
    expect(screen.getByTestId("register-toolbelt-import")).toHaveAttribute(
      "href",
      "/acme/core-platform/tools/providers",
    );
    expect(screen.queryByRole("radiogroup", { name: "Toolbelt" })).toBeNull();
    await user.type(screen.getByLabelText("Name"), "Perf watch");
    await user.click(harnessOption(/Codex/));
    await user.click(runtimeOption(/Build box/));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(registerAgent).toHaveBeenCalledWith(
      ORG,
      WS,
      expect.objectContaining({ toolbeltId: "" }),
    );
  });

  it("names the runtime read's failure and still offers Add a runtime (negative)", () => {
    renderForm({ runtimes: readError("runtimes_unavailable", 503) });
    expect(screen.queryByRole("radiogroup", { name: "Runtime" })).toBeNull();
    expect(screen.getByTestId("register-add-runtime")).toHaveAttribute(
      "href",
      "/acme/core-platform/runtimes",
    );
  });

  it("says when no runtime is named yet", () => {
    renderForm({ runtimes: readOk({ runtimes: [] }) });
    expect(screen.getByTestId("register-runtime-none")).toBeInTheDocument();
  });

  it("names a taken slug on the Slug field and stays on the step (negative)", async () => {
    const user = userEvent.setup();
    registerAgent.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "agent_slug_taken",
    });
    renderForm({ initialRuntime: "rtm_buildbox" });
    await user.type(screen.getByLabelText("Name"), "Perf watch");
    await user.click(harnessOption(/Codex/));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Slug")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription(
      /has held this slug/,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("names a refusal it has no field for in the alert and stays on the step (negative)", async () => {
    const user = userEvent.setup();
    registerAgent.mockResolvedValue(DENIED);
    renderForm({ initialRuntime: "rtm_buildbox" });
    await user.type(screen.getByLabelText("Name"), "Perf watch");
    await user.click(harnessOption(/Codex/));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("register-failure")).toHaveTextContent(
      "This account may not register agents here. An organization owner or admin can.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows a reserved agent read-only and moves on without a second write", () => {
    renderForm({
      reserved: {
        id: "agt_perfwatch",
        name: "Perf watch",
        slug: "perf-watch",
        harness: "codex",
        runtime: { id: "rtm_buildbox", name: "Build box", slug: "build-box" },
        toolbelt: null,
      },
    });
    const reserved = screen.getByTestId("register-reserved");
    expect(reserved).toHaveTextContent("perf-watch");
    expect(reserved).toHaveTextContent("Build box");
    expect(reserved).toHaveTextContent("All tools");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute(
      "href",
      "/acme/core-platform/register/wrap?agent=agt_perfwatch",
    );
    expect(screen.getByTestId("register-note")).toHaveTextContent(
      "a-intel.core.perf-watch is reserved. Continue opens the wrap step.",
    );
  });

  it("carries exactly one gold action, Continue, beside Cancel", () => {
    renderForm();
    expect(screen.getByTestId("register-cancel")).toHaveAttribute(
      "href",
      FLEET,
    );
    expect(
      screen.getByRole("button", { name: "Continue" }).className,
    ).toContain("bg-button-primary-bg");
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });
});

describe("the wrap step", () => {
  it("draws the four harness tabs with their sub-lines and opens on the recorded harness", () => {
    renderWrap("codex");
    const tabs = within(
      screen.getByRole("tablist", { name: "How to wrap the agent" }),
    ).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Claude Codeone command · harness",
      "Codex CLIone command · harness",
      "Cursorone command · harness",
      "SDK agentyour process · harness",
    ]);
    expect(screen.getByRole("tab", { name: /Codex CLI/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-tab", "codex");
    expect(screen.getByText("or observe")).toBeInTheDocument();
  });

  it.each([
    ["stella", "sdk"],
    ["custom", "sdk"],
    ["cursor", "cursor"],
    ["claude-code", "claude-code"],
  ] as const)("opens %s on the %s tab", (harness, tab) => {
    renderWrap(harness);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-tab", tab);
  });

  it("shows the tier ladder with the recorded words and recommends Claude Code", () => {
    renderWrap("claude-code");
    const ladder = screen.getByTestId("tier-ladder");
    expect(
      [...ladder.querySelectorAll("[data-tier]")].map((b) => b.textContent),
    ).toEqual(["harness", "gateway", "contained"]);
    expect(within(ladder).getByText("This agent")).toBeInTheDocument();
    expect(within(ladder).getByText("Next rung")).toBeInTheDocument();
    expect(within(ladder).getByText("Top rung")).toBeInTheDocument();
    expect(screen.getByText("recommended")).toBeInTheDocument();
    expect(screen.queryByText("or observe")).not.toBeInTheDocument();
  });

  it("switches the panel with the arrow keys", async () => {
    const user = userEvent.setup();
    renderWrap("claude-code");
    screen.getByRole("tab", { name: /Claude Code/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-tab", "codex");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-tab", "sdk");
  });

  it("draws Download for the chosen OS disabled, and says installers are not published (NotBacked)", async () => {
    const user = userEvent.setup();
    renderWrap("claude-code");
    const os = screen.getByRole("tablist", { name: "Operating system" });
    expect(
      within(os)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["macOS", "Windows", "Linux"]);
    expect(screen.getByTestId("download-installer")).toHaveTextContent(
      "Download for macOS",
    );
    await user.click(within(os).getByRole("tab", { name: "Linux" }));
    expect(screen.getByTestId("download-installer")).toHaveTextContent(
      "Download for Linux",
    );
    expect(screen.getByTestId("download-installer")).toBeDisabled();
    expect(
      screen.getByTestId("download-installer"),
    ).toHaveAccessibleDescription(
      /Signed installers with the token embedded are not published yet/,
    );
  });

  it("issues the one-time token and prints it with the command that presents it", async () => {
    const user = userEvent.setup();
    issueEnrollmentToken.mockResolvedValue({
      ok: true,
      value: {
        token: "oxe_1time_7QK4M2NV9XR3T8ZP",
        expiresAt: "2026-09-23T14:31:00.000Z",
        agentKey: "a-intel.core.perf-watch",
        enrollCommand:
          "oxagen agent enroll --token oxe_1time_7QK4M2NV9XR3T8ZP --harness claude-code",
      },
    });
    renderWrap("claude-code");
    // Step one is installing the app, which puts the CLI the command runs on
    // PATH, so its links come before the token control.
    const downloads = screen.getByTestId("desktop-downloads");
    expect(
      screen.getByRole("link", { name: "Apple silicon (.dmg)" }),
    ).toHaveAttribute(
      "href",
      "https://downloads.oxagen.sh/latest/Oxagen_aarch64.dmg",
    );
    expect(
      downloads.compareDocumentPosition(
        screen.getByRole("button", { name: "Issue the token" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Issue the token" }));
    expect(issueEnrollmentToken).toHaveBeenCalledWith(
      ORG,
      WS,
      "agt_releasebot",
    );
    expect(screen.getByTestId("enrollment-token-value")).toHaveTextContent(
      "oxe_1time_7QK4M2NV9XR3T8ZP",
    );
    expect(screen.getByTestId("enrollment-token")).toHaveTextContent(
      /expires .* · single use/,
    );
    expect(screen.getByTestId("enroll-command")).toHaveTextContent(
      "oxagen agent enroll --token oxe_1time_7QK4M2NV9XR3T8ZP --harness claude-code",
    );
  });

  it("names a refused token and prints none (negative)", async () => {
    const user = userEvent.setup();
    issueEnrollmentToken.mockResolvedValue(DENIED);
    renderWrap("claude-code");
    await user.click(screen.getByRole("button", { name: "Issue the token" }));
    expect(screen.getByTestId("wrap-failure")).toHaveTextContent(
      "This account may not register agents here.",
    );
    expect(
      screen.queryByTestId("enrollment-token-value"),
    ).not.toBeInTheDocument();
  });

  it("shows the SDK credential by prefix, issues a new one once, and says the SDK is not published (NotBacked)", async () => {
    const user = userEvent.setup();
    issueAgentCredential.mockResolvedValue({
      ok: true,
      value: {
        secret: "oxa_live_s3cr3t3f7a",
        expiresAt: "2027-03-14T00:00:00.000Z",
      },
    });
    renderWrap("custom");
    expect(screen.getByTestId("agent-credential")).toHaveTextContent(
      "issued once to the operator",
    );
    expect(screen.getByTestId("agent-credential")).toHaveTextContent(
      "oxa_ag_7f••••••••••••",
    );
    expect(screen.getByTestId("agent-credential")).toHaveTextContent(
      "hashed at rest · purpose-locked · revocable",
    );
    expect(
      screen.getByText(
        /The Oxagen SDK and its five-line wrap are not published yet/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("download-installer")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Issue a new credential" }),
    );
    expect(issueAgentCredential).toHaveBeenCalledWith(
      ORG,
      WS,
      "agt_releasebot",
    );
    expect(screen.getByTestId("agent-credential")).toHaveTextContent(
      "oxa_live_s3cr3t3f7a",
    );
    expect(
      screen.queryByRole("button", { name: "Issue a new credential" }),
    ).not.toBeInTheDocument();
  });

  it("names a refused credential and shows no secret (negative)", async () => {
    const user = userEvent.setup();
    issueAgentCredential.mockResolvedValue(DENIED);
    renderWrap("custom");
    await user.click(
      screen.getByRole("button", { name: "Issue a new credential" }),
    );
    expect(screen.getByTestId("credential-failure")).toBeInTheDocument();
  });

  it("draws the footer in order with the caption, and the continue button is not gold", () => {
    renderWrap("claude-code");
    expect(screen.getByTestId("register-cancel")).toHaveTextContent("Cancel");
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      BACK,
    );
    expect(
      screen.getByText("Nothing completes until a frame arrives."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "I have already installed it" })
        .className,
    ).not.toContain("bg-button-primary-bg");
  });

  it("moves the gate's step, then opens the run step", async () => {
    const user = userEvent.setup();
    advanceOnboarding.mockResolvedValue({
      ok: true,
      value: { step: "run", changedAt: "2026-09-23T14:02:00.000Z" },
    });
    renderWrap("claude-code", true);
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(advanceOnboarding).toHaveBeenCalledWith(ORG, WS, "run");
    expect(router.push).toHaveBeenCalledWith(NEXT);
  });

  it("moves no gate for a workspace that carries none", async () => {
    const user = userEvent.setup();
    renderWrap("claude-code", false);
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(NEXT);
  });

  it("stays on the step when the gate refuses the move (negative)", async () => {
    const user = userEvent.setup();
    advanceOnboarding.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "already_unlocked",
    });
    renderWrap("claude-code", true);
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(screen.getByTestId("advance-failure")).toHaveTextContent(
      "The gate is already open.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("the received card's footer", () => {
  it("counts six seconds down in #regAuto and then opens Fleet", () => {
    vi.useFakeTimers();
    render(
      <IntlProvider>
        <OpenInFleet fleet={FLEET}>
          <span>Cancel</span>
        </OpenInFleet>
      </IntlProvider>,
    );
    const auto = document.getElementById("regAuto");
    expect(auto).toHaveTextContent("Opening automatically…");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(auto).toHaveTextContent("Opening automatically in 5…");
    expect(router.push).not.toHaveBeenCalled();
    // One second per act: each tick schedules the next once React re-renders.
    for (let second = 0; second < 5; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(router.push).toHaveBeenCalledWith(FLEET);
  });

  it("opens Fleet at once from Open in Fleet, the one gold action", () => {
    render(
      <IntlProvider>
        <OpenInFleet fleet={FLEET}>
          <span>Cancel</span>
        </OpenInFleet>
      </IntlProvider>,
    );
    const open = screen.getByRole("button", { name: "Open in Fleet" });
    expect(open.className).toContain("bg-button-primary-bg");
    act(() => {
      open.click();
    });
    expect(router.push).toHaveBeenCalledWith(FLEET);
  });
});

describe("Cancel", () => {
  function renderCancel(agentId: string | null) {
    render(
      <IntlProvider>
        <CancelRegistration
          org={ORG}
          ws={WS}
          agentId={agentId}
          fleet={FLEET}
          testId="register-cancel"
        />
      </IntlProvider>,
    );
  }

  it("is a link back to Fleet before the identity exists, and writes nothing", () => {
    renderCancel(null);
    expect(screen.getByTestId("register-cancel")).toHaveAttribute(
      "href",
      FLEET,
    );
    expect(cancelRegistration).not.toHaveBeenCalled();
  });

  it("retires the identity and opens Fleet once it exists", async () => {
    const user = userEvent.setup();
    cancelRegistration.mockResolvedValue({ ok: true, value: { to: FLEET } });
    renderCancel("agt_releasebot");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelRegistration).toHaveBeenCalledWith(ORG, WS, "agt_releasebot");
    expect(router.push).toHaveBeenCalledWith(FLEET);
  });

  it("names a refused cancel and stays on the step (negative)", async () => {
    const user = userEvent.setup();
    cancelRegistration.mockResolvedValue(DENIED);
    renderCancel("agt_releasebot");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This account may not register agents here.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("Request access", () => {
  it("opens the request-access dialog, which says what is not backed and who can grant it", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <RequestAccess permission="agent.register on core-platform" />
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = screen.getByRole("dialog", { name: "Request access" });
    expect(dialog).toHaveTextContent(
      "Oxagen cannot send an access request from this page yet. Ask an organization owner to grant agent.register on core-platform.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });
});
