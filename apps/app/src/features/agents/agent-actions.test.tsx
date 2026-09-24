// @vitest-environment jsdom
// The writes on an agent identity: each dialog calls its action for the agent
// and the workspace, shows a rotated secret once, reloads the page a suspend
// leaves, leaves a receipt after a deregister and reloads the list once it is
// closed, and names every refusal without navigating.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  readAgentRoleNames,
  retireAgent,
  rotateAgentCredential,
  setAgentSuspended,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  readAgentRoleNames: vi.fn(),
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  readAgentRoleNames,
  retireAgent,
  rotateAgentCredential,
  setAgentSuspended,
}));

const { AgentActions, RetireAgent } = await import("./agent-actions");

const HERE = routes.agent("acme", "core-platform", "release-bot");
const LIST = routes.agents("acme", "core-platform");

function renderActions(suspended = false) {
  render(
    <IntlProvider>
      <AgentActions
        org="acme"
        ws="core-platform"
        agentId="agt_releasebot"
        name="Release bot"
        slug="release-bot"
        suspended={suspended}
        here={HERE}
        list={LIST}
      />
    </IntlProvider>,
  );
}

async function confirm(open: string, testId: string, action: string) {
  await userEvent.click(screen.getByRole("button", { name: open }));
  const dialog = screen.getByTestId(testId);
  await userEvent.click(within(dialog).getByRole("button", { name: action }));
  return dialog;
}

/** Deregister waits on the "cannot be undone" checkbox, as the design draws it. */
async function deregister() {
  await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
  const dialog = screen.getByTestId("retire-agent");
  await userEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand this cannot be undone/,
    }),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Deregister" }),
  );
  return dialog;
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  retireAgent.mockReset();
  rotateAgentCredential.mockReset();
  setAgentSuspended.mockReset();
  readAgentRoleNames.mockReset();
  readAgentRoleNames.mockResolvedValue({
    ok: true,
    value: ["Agent Observer", "Release deputy"],
  });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AgentActions", () => {
  it("rotates the credential and shows the new secret once, in the dialog, without navigating", async () => {
    rotateAgentCredential.mockResolvedValue({
      ok: true,
      value: { secret: "oxa_ag_s3cr3t", expiresAt: "2027-03-15T09:00:00.000Z" },
    });
    renderActions();
    await userEvent.click(
      screen.getByRole("button", { name: "Rotate credential" }),
    );
    const dialog = screen.getByTestId("rotate-credential");
    expect(dialog).toHaveTextContent("Rotate the credential of Release bot");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Rotate" }),
    );
    expect(rotateAgentCredential).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
    );
    expect(await screen.findByTestId("credential-secret")).toHaveTextContent(
      "oxa_ag_s3cr3t",
    );
    expect(dialog).toHaveTextContent("Expires Mar 15, 2027");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("suspends the agent and reloads its page", async () => {
    setAgentSuspended.mockResolvedValue({
      ok: true,
      value: { status: "suspended" },
    });
    renderActions();
    await confirm("Suspend", "suspend-agent", "Suspend");
    expect(setAgentSuspended).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
      true,
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("suspend-agent")).toBeNull();
  });

  it("resumes a suspended agent", async () => {
    setAgentSuspended.mockResolvedValue({
      ok: true,
      value: { status: "active" },
    });
    renderActions(true);
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    await confirm("Resume", "resume-agent", "Resume");
    expect(setAgentSuspended).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
      false,
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("deregisters the agent, leaves a receipt and goes to the identities list once it is closed", async () => {
    retireAgent.mockResolvedValue({
      ok: true,
      value: { retiredAt: "2026-09-15T09:00:00.000Z" },
    });
    renderActions();
    const dialog = await deregister();
    expect(retireAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
    );
    expect(
      await within(dialog).findByTestId("retire-agent-receipt"),
    ).toHaveTextContent(
      "Release bot deregistered. Credential revoked, every run and frame kept.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(router.replace).toHaveBeenCalledWith(LIST);
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "org_role_required" },
      "Your organization role does not allow this change. Nothing was changed.",
    ],
    [
      { ok: false, reason: "denied", code: "no_principal" },
      "The request carried no signed-in user. Sign in and try again.",
    ],
    [
      { ok: false, reason: "denied", code: "authz_denied" },
      "The change was refused: authz_denied. Nothing was changed.",
    ],
    [
      { ok: false, reason: "conflict", code: "agent_retired" },
      "This agent is retired. Nothing was changed.",
    ],
    [
      { ok: false, reason: "conflict", code: "agent_principal_missing" },
      "This agent has no delegated principal. Nothing was changed.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
      "The change is waiting for approval, request acr_1.",
    ],
    [
      { ok: false, reason: "not_found", code: "agent_not_found" },
      "This agent no longer exists.",
    ],
    [
      { ok: false, reason: "invalid", code: "invalid_input", field: "agentId" },
      "The request was refused as invalid. Nothing was changed.",
    ],
    [
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      "The change could not be made: kernel_failure. Nothing was changed.",
    ],
  ])(
    "names a refused write in the dialog and navigates nowhere (negative)",
    async (result, text) => {
      setAgentSuspended.mockResolvedValue(result);
      renderActions();
      await confirm("Suspend", "suspend-agent", "Suspend");
      expect(
        await screen.findByTestId("suspend-agent-failure"),
      ).toHaveTextContent(text);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("names a write that threw before it answered (negative)", async () => {
    rotateAgentCredential.mockRejectedValue(new Error("network"));
    renderActions();
    await confirm("Rotate credential", "rotate-credential", "Rotate");
    expect(
      await screen.findByTestId("rotate-credential-failure"),
    ).toHaveTextContent("The change could not be made: action_failed.");
    expect(screen.queryByTestId("credential-secret")).toBeNull();
  });

  it("closing a dialog forgets its refusal", async () => {
    retireAgent.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderActions();
    await deregister();
    expect(
      await screen.findByTestId("retire-agent-failure"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    expect(screen.queryByTestId("retire-agent-failure")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("AgentActions while a write is open", () => {
  it("forgets a refused rotate when its dialog is closed and opened again", async () => {
    rotateAgentCredential.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderActions();
    const dialog = await confirm(
      "Rotate credential",
      "rotate-credential",
      "Rotate",
    );
    expect(
      await screen.findByTestId("rotate-credential-failure"),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^(Close|Cancel)$/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rotate credential" }),
    );
    expect(screen.queryByTestId("rotate-credential-failure")).toBeNull();
  });

  it("sends one suspend however often the form is submitted while it is pending (negative)", async () => {
    setAgentSuspended.mockReturnValue(new Promise(() => undefined));
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const form = screen.getByTestId("suspend-agent").querySelector("form");
    if (form === null) throw new Error("suspend form not drawn");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(setAgentSuspended).toHaveBeenCalledTimes(1);
  });

  it("sends no deregister when the form is submitted before the person says they understand (negative)", async () => {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    const form = screen.getByTestId("retire-agent").querySelector("form");
    if (form === null) throw new Error("deregister form not drawn");
    fireEvent.submit(form);
    expect(retireAgent).not.toHaveBeenCalled();
  });
});

describe("RetireAgent", () => {
  it("names the roles without a count when they cannot be read (negative)", async () => {
    readAgentRoleNames.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "kernel_failure",
    });
    render(
      <IntlProvider>
        <RetireAgent
          org="acme"
          ws="core-platform"
          agentId="agt_other"
          name="acme.core.other"
          slug="other"
          holds={{ mandates: 2, hosts: 3 }}
          after={LIST}
        />
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    const dialog = screen.getByTestId("retire-agent");
    await vi.waitFor(() => {
      expect(readAgentRoleNames).toHaveBeenCalled();
    });
    expect(dialog).toHaveTextContent(
      "the roles it holds, 2 mandates, 3 host enrollments",
    );
  });

  it("deregisters from a table row and reloads the list it was given", async () => {
    retireAgent.mockResolvedValue({
      ok: true,
      value: { retiredAt: "2026-09-15T09:00:00.000Z" },
    });
    render(
      <IntlProvider>
        <RetireAgent
          org="acme"
          ws="core-platform"
          agentId="agt_other"
          name="acme.core.other"
          slug="other"
          holds={{ mandates: 1, hosts: 1 }}
          after={LIST}
        />
      </IntlProvider>,
    );
    const dialog = await deregister();
    expect(retireAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_other",
    );
    expect(
      await within(dialog).findByTestId("retire-agent-receipt"),
    ).toHaveTextContent("acme.core.other deregistered.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(router.replace).toHaveBeenCalledWith(LIST);
  });

  it("draws the design's dialog: the key, what is kept and what ends, and no pull request it cannot open", async () => {
    render(
      <IntlProvider>
        <RetireAgent
          org="acme"
          ws="core-platform"
          agentId="agt_other"
          name="acme.core.other"
          slug="other"
          holds={{ mandates: 0, hosts: 1 }}
          after={LIST}
          danger
        />
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    const dialog = screen.getByTestId("retire-agent");
    expect(
      within(dialog).getByRole("heading", { name: "Deregister agent" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("acme.core.other");
    expect(readAgentRoleNames).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_other",
    );
    // The design's Ends line: the roles held, the mandates, the enrollment.
    expect(
      await within(dialog).findByText(
        "2 roles, 0 mandates, the host enrollment",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("definition")
        .map((dd) => dd.textContent),
    ).toEqual([
      "every run, frame and receipt. The record is never deleted.",
      "2 roles, 0 mandates, the host enrollment",
    ]);
    // Deregister sits in the footer beside Cancel.
    const footer = dialog.querySelector("[data-sheet-footer]");
    if (!(footer instanceof HTMLElement)) throw new Error("no footer");
    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Deregister"]);
    const pr = dialog.querySelector("[data-not-backed]");
    expect(pr).toHaveAttribute("data-gap", "#3855");
    expect(pr).toHaveTextContent(".oxagen/agents/other.toml");
  });

  it("keeps Deregister disabled until the person says they understand (negative)", async () => {
    render(
      <IntlProvider>
        <RetireAgent
          org="acme"
          ws="core-platform"
          agentId="agt_other"
          name="acme.core.other"
          slug="other"
          after={LIST}
        />
      </IntlProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    const dialog = screen.getByTestId("retire-agent");
    const confirmButton = within(dialog).getByRole("button", {
      name: "Deregister",
    });
    expect(confirmButton).toBeDisabled();
    await userEvent.click(confirmButton);
    expect(retireAgent).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("its roles, mandates and host enrollment");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    expect(confirmButton).toBeEnabled();
  });
});
