// @vitest-environment jsdom
// ⌘K's "Pause every live run in this workspace" dialog (#3862): the reason is
// required, the confirm sends it to `pause_workspace_runs` through the
// action, the receipt shows the queued count, each skipped run with why and
// the command ids, and a refusal is shown in the handler's words. Each case
// ends with an axe check.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { pauseWorkspaceRunsAction, refresh } = vi.hoisted(() => ({
  pauseWorkspaceRunsAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./pause-workspace-actions", () => ({ pauseWorkspaceRunsAction }));

const { PauseWorkspaceDialog } = await import("./pause-workspace-dialog");

const RECEIPT = {
  queued: 2,
  commandIds: ["tcm_1", "tcm_2"],
  skipped: [
    {
      runId: "tse_0123456789abcdefghjkmn",
      agentKey: "acme.core.cc-laptop",
      reason: "host_offline",
      commandId: "tcm_3",
    },
    {
      runId: "tse_1123456789abcdefghjkmn",
      agentKey: "acme.core.docs",
      reason: "no_host",
      commandId: "tcm_4",
    },
  ],
};

function renderDialog() {
  const onClose = vi.fn();
  render(
    <IntlProvider>
      <PauseWorkspaceDialog org="acme" ws="core-platform" onClose={onClose} />
    </IntlProvider>,
  );
  return { onClose };
}

const dialog = () =>
  screen.getByRole("dialog", {
    name: "Pause every live run in this workspace",
  });
const confirm = () =>
  screen.getByRole("button", { name: "Pause every live run" });

beforeEach(() => {
  pauseWorkspaceRunsAction.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Pause every live run in this workspace", () => {
  it("says what the pause reaches and what it leaves alone, and asks for the reason", () => {
    renderDialog();
    expect(dialog()).toHaveTextContent("observe-tier runs included");
    expect(dialog()).toHaveTextContent(
      "Ledger runs are not paused. Pause one from its row on Fleet.",
    );
    const reason = screen.getByLabelText("Reason");
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute("maxlength", "512");
    expect(reason).toHaveAccessibleDescription(
      "Recorded on every command and on the audit event. Each run reads it when it resumes.",
    );
  });

  it("refuses to send without a reason (negative)", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Reason"), "   ");
    await user.click(confirm());
    expect(pauseWorkspaceRunsAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("pause-workspace-failure")).toHaveTextContent(
      "Give a reason. Nothing was paused.",
    );
  });

  it("sends the reason and shows the receipt: queued, each skipped run with why, and the command ids", async () => {
    pauseWorkspaceRunsAction.mockResolvedValue({ ok: true, value: RECEIPT });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Reason"), "Incident 42");
    await user.click(confirm());

    expect(pauseWorkspaceRunsAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "Incident 42",
    );
    const receipt = await screen.findByTestId("pause-workspace-receipt");
    expect(
      within(receipt).getByTestId("pause-workspace-queued"),
    ).toHaveTextContent("Queued a pause for 2 live runs.");
    expect(receipt).toHaveTextContent("Skipped 2 runs no host can reach:");
    const skipped = within(receipt).getAllByRole("listitem");
    expect(skipped.map((row) => row.textContent)).toEqual([
      "tse_0123456789abcdefghjkmn (acme.core.cc-laptop): its host has not checked in for five minutes",
      "tse_1123456789abcdefghjkmn (acme.core.docs): it names no enrolled host",
    ]);
    expect(screen.getByTestId("pause-workspace-ids")).toHaveTextContent(
      "tcm_1 tcm_2",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("copies the command ids", async () => {
    pauseWorkspaceRunsAction.mockResolvedValue({ ok: true, value: RECEIPT });
    renderDialog();
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await user.type(screen.getByLabelText("Reason"), "Incident 42");
    await user.click(confirm());
    await user.click(
      await screen.findByRole("button", { name: "Copy the command ids" }),
    );
    expect(writeText).toHaveBeenCalledWith("tcm_1\ntcm_2");
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("says when no live run took the pause", async () => {
    pauseWorkspaceRunsAction.mockResolvedValue({
      ok: true,
      value: { queued: 0, commandIds: [], skipped: [] },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Reason"), "Incident 42");
    await user.click(confirm());
    expect(
      await screen.findByTestId("pause-workspace-queued"),
    ).toHaveTextContent("No live run took the pause.");
    expect(screen.queryByTestId("pause-workspace-ids")).toBeNull();
    expect(screen.queryByTestId("pause-workspace-skipped")).toBeNull();
  });

  it("shows a refusal in the handler's words and stays on the form (negative)", async () => {
    pauseWorkspaceRunsAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Reason"), "Incident 42");
    await user.click(confirm());
    const failure = await screen.findByTestId("pause-workspace-failure");
    expect(failure.textContent).not.toBe("");
    expect(failure).not.toHaveTextContent("org_role_required");
    expect(screen.queryByTestId("pause-workspace-receipt")).toBeNull();
    expect(screen.getByLabelText("Reason")).toHaveValue("Incident 42");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a failure when the action throws (negative)", async () => {
    pauseWorkspaceRunsAction.mockRejectedValue(new Error("network"));
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Reason"), "Incident 42");
    await user.click(confirm());
    expect(
      await screen.findByTestId("pause-workspace-failure"),
    ).toBeInTheDocument();
  });

  it("closes on Cancel", async () => {
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
