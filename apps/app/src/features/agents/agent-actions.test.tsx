// @vitest-environment jsdom
// The writes on an agent identity: each dialog calls its action for the agent
// and the workspace, shows a rotated secret once, reloads the page a suspend
// or deregister leaves, and names every refusal without navigating.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, retireAgent, rotateAgentCredential, setAgentSuspended } =
  vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    retireAgent: vi.fn(),
    rotateAgentCredential: vi.fn(),
    setAgentSuspended: vi.fn(),
  }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
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

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  retireAgent.mockReset();
  rotateAgentCredential.mockReset();
  setAgentSuspended.mockReset();
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

  it("deregisters the agent and goes to the identities list", async () => {
    retireAgent.mockResolvedValue({
      ok: true,
      value: { retiredAt: "2026-09-15T09:00:00.000Z" },
    });
    renderActions();
    await confirm("Deregister", "retire-agent", "Deregister");
    expect(retireAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
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
    await confirm("Deregister", "retire-agent", "Deregister");
    expect(
      await screen.findByTestId("retire-agent-failure"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Deregister" }));
    expect(screen.queryByTestId("retire-agent-failure")).toBeNull();
  });
});

describe("RetireAgent", () => {
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
          name="Other"
          after={LIST}
        />
      </IntlProvider>,
    );
    await confirm("Deregister", "retire-agent", "Deregister");
    expect(retireAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_other",
    );
    expect(router.replace).toHaveBeenCalledWith(LIST);
  });
});
