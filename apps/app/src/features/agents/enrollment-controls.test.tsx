// @vitest-environment jsdom
// The two Enrollment writes: Revoke names the host it is about, sends the
// reason, re-reads the tab, and names a refusal without navigating; Enroll a
// host mints the token, shows it once with the command, copies each, and says
// so when the browser refuses the clipboard.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";

const { router, issueAgentEnrollmentToken, revokeHostEnrollment } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    issueAgentEnrollmentToken: vi.fn(),
    revokeHostEnrollment: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  issueAgentEnrollmentToken,
  revokeHostEnrollment,
}));

const { EnrollHost, RevokeHost } = await import("./enrollment-controls");

const HOST = "tch_0123456789abcdefghijkl";
const HERE = routes.agent("acme", "core-platform", "release-bot", {
  tab: "enrollment",
});
const TOKEN = {
  token: "oxe_1time_23456789abcdefghjkmnpqrstv",
  expiresAt: "2026-09-20T18:00:00.000Z",
  enrollCommand: "oxagen agent enroll --token oxe_1time_23456789abcdefghjkmnp",
};
const DENIED = { ok: false, reason: "denied", code: "org_role_required" };

/** A clipboard that records what it was asked to copy, or refuses. */
function stubClipboard(writeText: () => Promise<void>) {
  // The spy is returned directly rather than read back off `navigator`, which
  // would be an unbound method reference.
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: spy },
    configurable: true,
  });
  return spy;
}

function renderRevoke() {
  render(
    <IntlProvider>
      <RevokeHost
        org="acme"
        ws="core-platform"
        hostEnrollmentId={HOST}
        hostname="build-01"
        here={HERE}
      />
    </IntlProvider>,
  );
}

function renderEnroll() {
  render(
    <IntlProvider>
      <EnrollHost
        org="acme"
        ws="core-platform"
        agentId="agt_releasebot"
        agentName="Release bot"
      />
    </IntlProvider>,
  );
}

async function open(name: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByTestId(testId);
}

beforeEach(() => {
  router.replace.mockReset();
  issueAgentEnrollmentToken.mockReset();
  revokeHostEnrollment.mockReset();
  stubClipboard(() => Promise.resolve());
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("RevokeHost", () => {
  it("names the host in the button and the dialog, sends the reason, and re-reads the tab", async () => {
    revokeHostEnrollment.mockResolvedValue({
      ok: true,
      value: { revokedAt: "2026-09-20T09:00:00.000Z" },
    });
    renderRevoke();
    // A table of identical "Unenroll" buttons is only usable if each one names
    // the row it acts on.
    const dialog = await open("Unenroll build-01", "revoke-host-dialog");
    expect(dialog).toHaveTextContent("Unenroll build-01");
    await userEvent.type(
      within(dialog).getByLabelText("Reason"),
      "laptop returned",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll" }),
    );
    expect(revokeHostEnrollment).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      HOST,
      "laptop returned",
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("sends an empty reason when the box is untouched", async () => {
    revokeHostEnrollment.mockResolvedValue({
      ok: true,
      value: { revokedAt: "2026-09-20T09:00:00.000Z" },
    });
    renderRevoke();
    const dialog = await open("Unenroll build-01", "revoke-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll" }),
    );
    expect(revokeHostEnrollment).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      HOST,
      "",
    );
  });

  it("names a refusal in the dialog and navigates nowhere (negative)", async () => {
    revokeHostEnrollment.mockResolvedValue(DENIED);
    renderRevoke();
    const dialog = await open("Unenroll build-01", "revoke-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll" }),
    );
    expect(await screen.findByTestId("revoke-host-failure")).toHaveTextContent(
      "Your organization role does not allow this change",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered (negative)", async () => {
    revokeHostEnrollment.mockRejectedValue(new Error("socket closed"));
    renderRevoke();
    const dialog = await open("Unenroll build-01", "revoke-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unenroll" }),
    );
    expect(
      await screen.findByTestId("revoke-host-failure"),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("EnrollHost", () => {
  it("mints the token and shows it once, with its expiry and the command", async () => {
    issueAgentEnrollmentToken.mockResolvedValue({ ok: true, value: TOKEN });
    renderEnroll();
    const dialog = await open("Show the CLI path", "enroll-host-dialog");
    expect(dialog).toHaveTextContent("Enroll a host under Release bot");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint a token" }),
    );
    expect(issueAgentEnrollmentToken).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
    );
    expect(
      await screen.findByTestId("enrollment-token-value"),
    ).toHaveTextContent(TOKEN.token);
    expect(screen.getByTestId("enrollment-command")).toHaveTextContent(
      TOKEN.enrollCommand,
    );
    expect(dialog).toHaveTextContent("Expires Sep 20, 2026");
    expect(dialog).toHaveTextContent("Shown once");
    // The dialog stays open: the token is the answer, and closing it would
    // throw the one copy away.
    expect(
      within(dialog).getByRole("button", { name: "Mint another" }),
    ).toBeInTheDocument();
  });

  it("copies the token and the command", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    issueAgentEnrollmentToken.mockResolvedValue({ ok: true, value: TOKEN });
    renderEnroll();
    const dialog = await open("Show the CLI path", "enroll-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint a token" }),
    );
    await screen.findByTestId("enrollment-token-value");
    const copies = within(dialog).getAllByRole("button", { name: "Copy" });
    await userEvent.click(nth(copies, 0, "the token's copy button"));
    expect(writeText).toHaveBeenCalledWith(TOKEN.token);
    await userEvent.click(nth(copies, 1, "the command's copy button"));
    expect(writeText).toHaveBeenCalledWith(TOKEN.enrollCommand);
  });

  it("says so when the browser refuses the clipboard, and leaves the value readable (negative)", async () => {
    stubClipboard(() => Promise.reject(new Error("not allowed")));
    issueAgentEnrollmentToken.mockResolvedValue({ ok: true, value: TOKEN });
    renderEnroll();
    const dialog = await open("Show the CLI path", "enroll-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint a token" }),
    );
    await screen.findByTestId("enrollment-token-value");
    await userEvent.click(
      nth(
        within(dialog).getAllByRole("button", { name: "Copy" }),
        0,
        "the token's copy button",
      ),
    );
    expect(dialog).toHaveTextContent("Copying is blocked in this browser");
    expect(screen.getByTestId("enrollment-token-value")).toHaveTextContent(
      TOKEN.token,
    );
  });

  it("names a refusal and mints nothing (negative)", async () => {
    issueAgentEnrollmentToken.mockResolvedValue(DENIED);
    renderEnroll();
    const dialog = await open("Show the CLI path", "enroll-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint a token" }),
    );
    expect(await screen.findByTestId("enroll-host-failure")).toHaveTextContent(
      "Your organization role does not allow this change",
    );
    expect(screen.queryByTestId("enrollment-token")).not.toBeInTheDocument();
  });

  it("forgets the token when the dialog closes (negative)", async () => {
    issueAgentEnrollmentToken.mockResolvedValue({ ok: true, value: TOKEN });
    renderEnroll();
    const dialog = await open("Show the CLI path", "enroll-host-dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint a token" }),
    );
    await screen.findByTestId("enrollment-token-value");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    await open("Show the CLI path", "enroll-host-dialog");
    expect(screen.queryByTestId("enrollment-token")).not.toBeInTheDocument();
  });
});
