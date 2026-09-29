// @vitest-environment jsdom
// Organization › Notifications (#4608): the Slack connection that steering
// repo health notices post through, and the writes on it.
//
// The cases the tab turns on:
//   - a deployment with no Slack app offers no Connect Slack, but a stored
//     connection on it still shows its channel and keeps Disconnect;
//   - the connection shows the workspace, the channel, when it was made, and
//     the last post Slack refused, with what to do about it;
//   - the outcome the OAuth callback put on the URL is one fixed sentence;
//   - the picker reads the channels only when it opens, and Save and
//     Disconnect leave a receipt and re-read the tab at its plain URL;
//   - Disconnect asks first, in the page;
//   - each refused write names what happened and what to do.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackConnection } from "@/data/contracts/org";
import { type Read, readError, readOk } from "@/data/read";
import type { SlackConnectOutcome } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  recordReceipt: vi.fn(),
  startSlackConnection: vi.fn(),
  listSlackChannels: vi.fn(),
  setSlackChannel: vi.fn(),
  disconnectSlack: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("./receipt", () => ({ recordReceipt: mocks.recordReceipt }));
vi.mock("./slack-actions", () => ({
  startSlackConnection: mocks.startSlackConnection,
  listSlackChannels: mocks.listSlackChannels,
  setSlackChannel: mocks.setSlackChannel,
  disconnectSlack: mocks.disconnectSlack,
}));

const { NotificationsTab } = await import("./notifications");

const NOT_CONFIGURED: SlackConnection = {
  configured: false,
  connected: false,
  teamName: null,
  channel: null,
  lastFailure: null,
  connectedAt: null,
};

const NOT_CONNECTED: SlackConnection = { ...NOT_CONFIGURED, configured: true };

const CONNECTED: SlackConnection = {
  configured: true,
  connected: true,
  teamName: "Acme",
  channel: { channelRef: "C0123ABCD", name: "eng-alerts", isPrivate: false },
  lastFailure: null,
  connectedAt: "2026-09-28T10:00:00.000Z",
};

const CHANNELS = {
  ok: true,
  value: {
    channels: [
      { channelRef: "C0123ABCD", name: "eng-alerts", isPrivate: false },
      { channelRef: "G0456DEFG", name: "security", isPrivate: true },
    ],
    truncated: false,
  },
};

function renderTab(
  read: Read<SlackConnection>,
  outcome: SlackConnectOutcome | null = null,
) {
  return render(
    <IntlProvider>
      <NotificationsTab org="acme" read={read} outcome={outcome} />
    </IntlProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("NotificationsTab", () => {
  it("offers no Connect Slack on a deployment with no Slack app", async () => {
    const { container } = renderTab(readOk(NOT_CONFIGURED));
    expect(screen.getByText("unavailable").closest("[data-slack]")).toHaveAttribute(
      "data-slack",
      "unavailable",
    );
    expect(screen.getByTestId("slack-unavailable")).toHaveTextContent(
      "Slack is unavailable on this deployment because it has no Slack app credentials. Contact your Oxagen admin.",
    );
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    await expectNoAxe(container);
  });

  it("keeps a stored connection manageable on a deployment that lost its Slack app", async () => {
    const { container } = renderTab(readOk({ ...CONNECTED, configured: false }));
    expect(screen.getByText("connected").closest("[data-slack]")).toHaveAttribute(
      "data-slack",
      "connected",
    );
    expect(screen.queryByTestId("slack-unavailable")).toBeNull();
    expect(screen.getByTestId("slack-facts")).toHaveTextContent("Acme");
    expect(screen.getByTestId("slack-channel")).toHaveTextContent(
      "#eng-alerts",
    );
    expect(
      screen.getByRole("button", { name: "Change channel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    await expectNoAxe(container);
  });

  it("disconnects a stored connection on a deployment that lost its Slack app", async () => {
    mocks.disconnectSlack.mockResolvedValue({ ok: true, value: null });
    renderTab(readOk({ ...CONNECTED, configured: false }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Disconnect" }),
    );
    expect(mocks.disconnectSlack).toHaveBeenCalledWith("acme");
    await waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith(
        "/acme?tab=notifications",
      );
    });
  });

  it("offers Connect Slack when no workspace is connected", async () => {
    const { container } = renderTab(readOk(NOT_CONNECTED));
    expect(
      screen.getByText("not connected").closest("[data-slack]"),
    ).toHaveAttribute("data-slack", "not-connected");
    expect(screen.getByTestId("slack-not-connected")).toHaveTextContent(
      "No Slack workspace is connected.",
    );
    expect(
      screen.getByRole("button", { name: "Connect Slack" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("slack-facts")).toBeNull();
    await expectNoAxe(container);
  });

  it("shows the workspace, the channel, and when the connection was made", async () => {
    const { container } = renderTab(readOk(CONNECTED));
    expect(screen.getByText("connected").closest("[data-slack]")).toHaveAttribute(
      "data-slack",
      "connected",
    );
    const facts = screen.getByTestId("slack-facts");
    expect(facts).toHaveTextContent("Acme");
    expect(facts).toHaveTextContent("Sep 28, 2026");
    expect(screen.getByTestId("slack-channel")).toHaveTextContent(
      "#eng-alerts",
    );
    expect(screen.queryByTestId("slack-last-failure")).toBeNull();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Change channel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("marks a private channel and says when no channel is picked", () => {
    renderTab(
      readOk({
        ...CONNECTED,
        channel: { channelRef: "G0456DEFG", name: "security", isPrivate: true },
      }),
    );
    expect(screen.getByTestId("slack-channel")).toHaveTextContent(
      "#security (private)",
    );
    cleanup();

    renderTab(readOk({ ...CONNECTED, channel: null, teamName: null }));
    expect(screen.getByTestId("slack-channel")).toHaveTextContent(
      "None picked. Oxagen posts nothing until you pick one.",
    );
    expect(screen.getByTestId("slack-facts")).toHaveTextContent(
      "not recorded",
    );
    expect(
      screen.getByRole("button", { name: "Pick a channel" }),
    ).toBeInTheDocument();
  });

  it("says what to do about the last post Slack refused", () => {
    renderTab(
      readOk({
        ...CONNECTED,
        lastFailure: { code: "not_in_channel", at: "2026-09-28T11:00:00.000Z" },
      }),
    );
    const line = screen.getByTestId("slack-last-failure");
    expect(line).toHaveAttribute("data-code", "not_in_channel");
    expect(line).toHaveTextContent(
      "The bot is not in the channel. Run /invite @Oxagen in it.",
    );
    expect(screen.getByTestId("slack-facts")).toHaveTextContent(
      "Last failed post",
    );
  });

  it.each([
    ["token_revoked", "Someone removed the app from Slack or revoked its token."],
    ["invalid_auth", "Someone removed the app from Slack or revoked its token."],
    ["is_archived", "The channel is archived."],
    ["token_unreadable", "Oxagen could not decrypt the stored token."],
  ])("gives the failed post %s its own sentence", (code, sentence) => {
    renderTab(
      readOk({
        ...CONNECTED,
        lastFailure: { code, at: "2026-09-28T11:00:00.000Z" },
      }),
    );
    expect(screen.getByTestId("slack-last-failure")).toHaveTextContent(
      sentence,
    );
  });

  it.each(["rate_limited", "toString", "__proto__"])(
    "prints a failed post's code %s as Slack recorded it when it has no sentence (negative)",
    (code) => {
      renderTab(
        readOk({
          ...CONNECTED,
          lastFailure: { code, at: "2026-09-28T11:00:00.000Z" },
        }),
      );
      expect(screen.getByTestId("slack-last-failure")).toHaveTextContent(
        `Slack refused the post: ${code}.`,
      );
    },
  );

  it.each([
    ["connected", "Slack is connected. Pick the channel notices post to."],
    ["cancelled", "You cancelled in Slack, so Oxagen connected nothing."],
    ["expired", "The connect link expired or belongs to someone else."],
    ["refused", "Slack did not grant what Oxagen needs."],
    ["pendingApproval", "Connecting Slack is waiting for approval."],
    ["unavailable", "Slack or Oxagen did not answer."],
    ["denied", "Only an organization owner or admin can change Slack."],
    ["notConfigured", "Slack is unavailable on this deployment"],
  ] as const)("says how a connection attempt ended as %s", (outcome, text) => {
    renderTab(readOk(NOT_CONNECTED), outcome);
    const line = screen.getByRole("status");
    expect(line).toHaveAttribute("data-outcome", outcome);
    expect(line).toHaveTextContent(text);
  });

  it("shows no outcome line without an outcome", () => {
    renderTab(readOk(CONNECTED));
    expect(screen.queryByTestId("slack-outcome")).toBeNull();
  });

  it("names the failed read in place of the connection (negative)", async () => {
    const { container } = renderTab(
      readError("control_plane_unreachable", 503),
    );
    expect(screen.getByText(/could not be loaded/)).toHaveTextContent(
      "Slack could not be loaded: the control plane answered control_plane_unreachable.",
    );
    expect(container.querySelector("[data-slack]")).toBeNull();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    expect(screen.queryByTestId("slack-facts")).toBeNull();
    await expectNoAxe(container);
  });
});

describe("Connect Slack", () => {
  it("starts a connection and keeps its busy label while the browser leaves", async () => {
    mocks.startSlackConnection.mockReturnValue(new Promise(() => {}));
    renderTab(readOk(NOT_CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    const busy = screen.getByRole("button", { name: "Opening Slack" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(busy);
    expect(mocks.startSlackConnection).toHaveBeenCalledTimes(1);
    expect(mocks.startSlackConnection).toHaveBeenCalledWith("acme");
  });

  it("names a role refusal and offers the button again (negative)", async () => {
    mocks.startSlackConnection.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderTab(readOk(NOT_CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Only an organization owner or admin can change Slack.",
    );
    expect(
      screen.getByRole("button", { name: "Connect Slack" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("names a start that threw before it answered (negative)", async () => {
    mocks.startSlackConnection.mockRejectedValue(new Error("network"));
    renderTab(readOk(NOT_CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Slack or Oxagen did not answer: action_failed. Try again.",
    );
  });

  it("names an authorize URL Oxagen would not follow (negative)", async () => {
    mocks.startSlackConnection.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "slack_authorization_url_invalid",
    });
    renderTab(readOk(NOT_CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Slack or Oxagen did not answer: slack_authorization_url_invalid. Try again.",
    );
  });
});

describe("the channel picker", () => {
  it("reads the channels only when it opens, with the current channel picked", async () => {
    mocks.listSlackChannels.mockResolvedValue(CHANNELS);
    const { container } = renderTab(readOk(CONNECTED));
    expect(mocks.listSlackChannels).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    expect(mocks.listSlackChannels).toHaveBeenCalledWith("acme");
    const select = await screen.findByLabelText("Channel");
    expect(select).toHaveValue("C0123ABCD");
    expect(
      screen.getByRole("option", { name: "#security (private)" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("slack-picker-truncated")).toBeNull();
    expect(screen.queryByTestId("slack-picker-empty")).toBeNull();
    expect(screen.queryByTestId("slack-pick")).toBeNull();
    await expectNoAxe(container);
  });

  it("saves the picked channel, leaves a receipt, and re-reads the tab", async () => {
    mocks.listSlackChannels.mockResolvedValue(CHANNELS);
    mocks.setSlackChannel.mockResolvedValue({ ok: true, value: null });
    renderTab(readOk(CONNECTED), "connected");

    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Channel"),
      "G0456DEFG",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setSlackChannel).toHaveBeenCalledWith("acme", "G0456DEFG");
    await waitFor(() => {
      expect(mocks.recordReceipt).toHaveBeenCalledWith(
        "Notices now post to #security. Recorded in the audit record.",
      );
    });
    // The plain URL: the callback's outcome does not outlive the change.
    expect(mocks.router.replace).toHaveBeenCalledWith("/acme?tab=notifications");
    expect(mocks.router.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("slack-picker")).toBeNull();
  });

  it("says when Slack holds more channels than the list shows", async () => {
    mocks.listSlackChannels.mockResolvedValue({
      ok: true,
      value: { ...CHANNELS.value, truncated: true },
    });
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    expect(
      await screen.findByTestId("slack-picker-truncated"),
    ).toHaveTextContent(
      "Slack holds more channels than this list shows, so yours may be missing.",
    );
  });

  it("says when Slack returned no channel, and saves nothing (negative)", async () => {
    mocks.listSlackChannels.mockResolvedValue({
      ok: true,
      value: { channels: [], truncated: false },
    });
    renderTab(readOk({ ...CONNECTED, channel: null }));
    await userEvent.click(
      screen.getByRole("button", { name: "Pick a channel" }),
    );
    expect(await screen.findByTestId("slack-picker-empty")).toHaveTextContent(
      "Slack returned no channel Oxagen can post to.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.setSlackChannel).not.toHaveBeenCalled();
  });

  it("closes on Cancel without a write", async () => {
    mocks.listSlackChannels.mockResolvedValue(CHANNELS);
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    await screen.findByTestId("slack-picker");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("slack-picker")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Change channel" }),
    ).toBeInTheDocument();
    expect(mocks.setSlackChannel).not.toHaveBeenCalled();
  });

  it("names a channel list the viewer may not read (negative)", async () => {
    mocks.listSlackChannels.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Only an organization owner or admin can change Slack.",
    );
    expect(screen.queryByTestId("slack-picker")).toBeNull();
  });

  it("names a connection Slack no longer accepts (negative)", async () => {
    mocks.listSlackChannels.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "slack_connection_broken",
    });
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "The Slack connection no longer works. Select Disconnect, then Connect Slack.",
    );
  });

  it("names a channel that is gone, leaves no receipt, and keeps the picker open (negative)", async () => {
    mocks.listSlackChannels.mockResolvedValue(CHANNELS);
    mocks.setSlackChannel.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "slack_channel_not_found",
    });
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    await screen.findByTestId("slack-picker");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "That channel cannot take posts because it was deleted or archived. Pick another channel.",
    );
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("slack-picker")).toBeInTheDocument();
  });

  it.each([
    [
      { reason: "invalid", code: "invalid_input", field: "channelId" },
      "Oxagen refused that channel. Pick another one.",
    ],
    [
      { reason: "pending_approval", accessRequestId: "areq_1" },
      "The change is waiting for approval, request areq_1.",
    ],
    [
      { reason: "conflict", code: "slack_connection_changed" },
      "Someone connected another Slack workspace. Reload the page.",
    ],
    [
      { reason: "conflict", code: "slack_not_connected" },
      "No Slack workspace is connected. Select Connect Slack.",
    ],
    [
      { reason: "conflict", code: "slack_other_reason" },
      "The change was refused: slack_other_reason. Nothing was changed.",
    ],
  ])("names a refused save %j (negative)", async (failure, text) => {
    mocks.listSlackChannels.mockResolvedValue(CHANNELS);
    mocks.setSlackChannel.mockResolvedValue({ ok: false, ...failure });
    renderTab(readOk(CONNECTED));
    await userEvent.click(
      screen.getByRole("button", { name: "Change channel" }),
    );
    await screen.findByTestId("slack-picker");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(text);
  });
});

describe("Disconnect", () => {
  it("asks first, in the page, and Keep it writes nothing", async () => {
    renderTab(readOk(CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByTestId("slack-disconnect-confirm")).toHaveTextContent(
      "Disconnect Slack? Oxagen deletes the stored token, asks Slack to revoke it, and stops posting.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByTestId("slack-disconnect-confirm")).toBeNull();
    expect(mocks.disconnectSlack).not.toHaveBeenCalled();
  });

  it("disconnects on the second Disconnect, leaves a receipt, and re-reads the tab", async () => {
    mocks.disconnectSlack.mockResolvedValue({ ok: true, value: null });
    renderTab(readOk(CONNECTED), "connected");
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Disconnect" }),
    );
    expect(mocks.disconnectSlack).toHaveBeenCalledWith("acme");
    await waitFor(() => {
      expect(mocks.recordReceipt).toHaveBeenCalledWith(
        "Slack was disconnected, and Oxagen stopped posting there. Recorded in the audit record.",
      );
    });
    expect(mocks.router.replace).toHaveBeenCalledWith("/acme?tab=notifications");
    expect(screen.queryByTestId("slack-disconnect-confirm")).toBeNull();
  });

  it("names a refused disconnect and leaves no receipt (negative)", async () => {
    mocks.disconnectSlack.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    renderTab(readOk(CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Disconnect" }),
    );
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Only an organization owner or admin can change Slack.",
    );
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("names a disconnect that threw before it answered (negative)", async () => {
    mocks.disconnectSlack.mockRejectedValue(new Error("network"));
    renderTab(readOk(CONNECTED));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Disconnect" }),
    );
    expect(await screen.findByTestId("slack-failure")).toHaveTextContent(
      "Slack or Oxagen did not answer: action_failed. Try again.",
    );
  });
});
