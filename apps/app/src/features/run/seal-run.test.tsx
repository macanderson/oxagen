// @vitest-environment jsdom
// Seal run (ADR-168) as a person drives it: open the dialog, read what it will
// do, submit, and read what the control plane did.
//
// The rule these hold is that the dialog never claims more than `seal_run`
// answered. It says before submitting whether a kill can reach the agent, and
// after, whether one was queued. A queued kill is not a stopped agent, and a
// kill that could not be sent is said as such, beside a seal that went ahead.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandBlock } from "@/data/contracts/runs";
import type { OrgRole, WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { sealRun, refresh, replace } = vi.hoisted(() => ({
  sealRun: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("./actions", () => ({ sealRun }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh }),
}));

const { SealRunAction } = await import("./seal-run");

const RUN = "tse_7k2m9q";

function renderSeal({
  commandBlock = null,
  orgRole = "member",
  wsRole = "owner",
}: {
  commandBlock?: CommandBlock | null;
  orgRole?: OrgRole;
  wsRole?: WsRole;
} = {}) {
  return render(
    <IntlProvider>
      <SealRunAction
        org="acme"
        ws="core-platform"
        runId={RUN}
        commandBlock={commandBlock}
        orgRole={orgRole}
        wsRole={wsRole}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  for (const fn of [sealRun, refresh, replace]) fn.mockReset();
});

afterEach(cleanup);

const sealed = (kill: object) => ({
  ok: true,
  value: {
    runId: RUN,
    sealedAt: "2026-09-24T12:00:00.000Z",
    sessionsSealed: 1,
    kill,
  },
});

describe("SealRunAction", () => {
  it("seals with the reason typed and says the kill is queued, never that the agent stopped", async () => {
    sealRun.mockResolvedValue(
      sealed({ status: "queued", commandId: "tcm_kill1" }),
    );
    const user = userEvent.setup();
    const { container } = renderSeal();
    await user.click(screen.getByTestId("run-seal"));
    expect(screen.getByTestId("run-seal-kill")).toHaveTextContent(
      "Oxagen also queues a kill for the agent on its host.",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Reason" }),
      "  finished an hour ago  ",
    );
    await user.click(screen.getByRole("button", { name: "Seal the run" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The run is sealed.",
      );
    });
    expect(sealRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
      "  finished an hour ago  ",
    );
    expect(screen.getByTestId("run-seal-kill-queued")).toHaveTextContent(
      "The kill is queued. The host carries it out when it next checks for commands. tcm_kill1",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/stopped/);
    await expectNoAxe(container);
  });

  it("says in advance that no kill can reach an offline host, and after, that none was sent (negative)", async () => {
    sealRun.mockResolvedValue(
      sealed({ status: "not_sent", reason: "host_offline" }),
    );
    const user = userEvent.setup();
    renderSeal({ commandBlock: "host_offline" });
    await user.click(screen.getByTestId("run-seal"));
    expect(screen.getByTestId("run-seal-kill")).toHaveTextContent(
      "The run's host has not checked in for five minutes, so a kill would go unread. The run is sealed anyway.",
    );
    await user.click(screen.getByRole("button", { name: "Seal the run" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-seal-kill-not-sent")).toHaveTextContent(
        "No kill was sent, because the run's host has not checked in for five minutes.",
      );
    });
    expect(screen.queryByTestId("run-seal-kill-queued")).toBeNull();
  });

  it("names the handler's refusal and seals nothing (negative)", async () => {
    sealRun.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "run_sealed",
    });
    const user = userEvent.setup();
    renderSeal();
    await user.click(screen.getByTestId("run-seal"));
    await user.click(screen.getByRole("button", { name: "Seal the run" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-seal-failure")).toHaveTextContent(
        "This run has ended",
      );
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names a write that threw before it answered rather than falling silent (negative)", async () => {
    sealRun.mockRejectedValue(new Error("socket hang up"));
    const user = userEvent.setup();
    renderSeal();
    await user.click(screen.getByTestId("run-seal"));
    await user.click(screen.getByRole("button", { name: "Seal the run" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-seal-failure")).toHaveTextContent(
        "command_failed",
      );
    });
  });

  it("re-reads the run when the person asks, so the status is what says the run sealed", async () => {
    sealRun.mockResolvedValue(
      sealed({ status: "queued", commandId: "tcm_kill1" }),
    );
    const user = userEvent.setup();
    renderSeal();
    await user.click(screen.getByTestId("run-seal"));
    await user.click(screen.getByRole("button", { name: "Seal the run" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: "Re-read the run" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("offers an org Owner or Admin the seal, whatever their workspace role", () => {
    renderSeal({ orgRole: "admin", wsRole: "viewer" });
    expect(screen.getByTestId("run-seal")).toBeEnabled();
  });

  it("disables Seal run for a workspace Member, with the reason on the button (negative)", async () => {
    const user = userEvent.setup();
    const { container } = renderSeal({ orgRole: "member", wsRole: "member" });
    const button = screen.getByTestId("run-seal");
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Sealing a run needs an organization Owner or Admin role, or the workspace Owner role.",
    );
    await user.click(button);
    expect(screen.queryByTestId("run-seal-dialog")).toBeNull();
    expect(sealRun).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });
});
