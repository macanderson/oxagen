// @vitest-environment jsdom
// The Account dialog over fake actions and a fake Better Auth client: its four
// tabs (mockup `accountTabs`), what each one reads and writes, and each
// refusal read back. Profile saves a display name through update_profile and
// opens the avatar editor; Preferences reads get_user_preferences and writes
// set_preferences; Security lists sessions, revokes one, and reissues
// recovery codes; Privacy queues export_data. The onboarding demo tab of the
// mockup is not here (negative).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";
import { shellData } from "./shell.builders";
import type { ShellData } from "./shell-data";
import {
  type AccountTab,
  ShellStateProvider,
  useShellState,
} from "./shell-state";

const updateProfile = vi.fn();
const readPreferences = vi.fn();
const savePreferences = vi.fn();
const requestExport = vi.fn();
const readExportStatus = vi.fn();
vi.mock("./account-actions", () => ({
  updateProfile,
  readPreferences,
  savePreferences,
  requestExport,
  readExportStatus,
}));

const liveListSessions = vi.fn();
const liveRevokeSession = vi.fn();
const liveRegenerateBackupCodes = vi.fn();
const liveSignOut = vi.fn();
vi.mock("./session-client", () => ({
  liveListSessions,
  liveRevokeSession,
  liveRegenerateBackupCodes,
  liveSignOut,
}));

// The dialog re-renders the server tree after a save, through useNavigate ---
// the app's one useRouter importer (INV-13).
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { AccountDialog } = await import("./account-dialog");
const { AvatarDialog } = await import("./avatar-dialog");

/** The dialog renders from shell state, so a test needs the way a person opens it. */
function OpenIt() {
  const { openAccount, avatarOpen, accountOpen } = useShellState();
  return (
    <>
      {(["profile", "preferences", "security", "privacy"] as const).map(
        (tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              openAccount(tab);
            }}
          >
            open {tab}
          </button>
        ),
      )}
      <output data-testid="which">
        {avatarOpen ? "avatar" : accountOpen ? "account" : "none"}
      </output>
    </>
  );
}

type Viewer = ShellData["viewer"];

function viewerWith(overrides: Partial<Viewer> = {}): Viewer {
  return { ...shellData().viewer, ...overrides };
}

async function openDialog(
  tab: AccountTab = "profile",
  viewer: Viewer = viewerWith(),
  container?: HTMLElement,
) {
  const user = userEvent.setup();
  const data = shellData({ viewer });
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AccountDialog data={data} />
        <AvatarDialog data={data} />
      </ShellStateProvider>
    </IntlProvider>,
    container ? { container } : undefined,
  );
  await user.click(screen.getByRole("button", { name: `open ${tab}` }));
  return { user, dialog: await screen.findByTestId("account-dialog") };
}

// The zones Preferences offers. The engine's own list runs to about 400, and
// axe walks a node per option, which made this file's accessibility checks the
// slowest in the app — they expired first at 15s and then at 30s on a loaded
// runner. The list is a seam the dialog reads, not the subject of any test
// here, so it is stubbed down to four real zones; that the select renders
// whatever the engine reports is proven directly below.
const ENGINE_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
];

// The dialog renders under ShellStateProvider, which reads the theme from a
// media query jsdom does not implement.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.spyOn(Intl, "supportedValuesOf").mockImplementation((key) =>
    key === "timeZone" ? [...ENGINE_ZONES] : [],
  );
});

beforeEach(() => {
  refresh.mockReset();
  updateProfile.mockReset();
  updateProfile.mockResolvedValue({
    ok: true,
    value: { displayName: "Marcus Bell", avatarUrl: null },
  });
  readPreferences.mockReset();
  readPreferences.mockResolvedValue({
    ok: true,
    value: { locale: "en", timezone: "UTC", theme: "system" },
  });
  savePreferences.mockReset();
  savePreferences.mockImplementation((_org: string, draft: unknown) =>
    Promise.resolve({ ok: true, value: draft }),
  );
  readExportStatus.mockReset();
  readExportStatus.mockResolvedValue({
    ok: true,
    value: {
      exportId: "7a000000-0000-4000-8000-0000000000e1",
      status: "queued",
      ready: false,
      storageKey: null,
    },
  });
  requestExport.mockReset();
  requestExport.mockResolvedValue({
    ok: true,
    value: {
      exportId: "7a000000-0000-4000-8000-0000000000e1",
      status: "queued",
    },
  });
  liveListSessions.mockReset();
  liveListSessions.mockResolvedValue({
    ok: true,
    sessions: [
      {
        token: "tok-here",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        ipAddress: "73.15.240.8",
        updatedAt: new Date("2026-09-18T15:47:00Z"),
        current: true,
      },
      {
        token: "tok-phone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
        ipAddress: "73.15.240.8",
        updatedAt: new Date("2026-09-11T08:12:00Z"),
        current: false,
      },
    ],
  });
  liveRevokeSession.mockReset();
  liveRevokeSession.mockResolvedValue(true);
  liveRegenerateBackupCodes.mockReset();
  liveRegenerateBackupCodes.mockResolvedValue({
    ok: true,
    codes: ["aaaa-bbbb", "cccc-dddd"],
  });
});
afterEach(cleanup);

describe("the tabs", () => {
  it("offers Profile, Preferences, Security and Privacy, and no onboarding demo (negative)", async () => {
    const { dialog } = await openDialog();
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Profile",
      "Preferences",
      "Security",
      "Privacy",
    ]);
    expect(within(dialog).queryByText(/onboarding/i)).toBeNull();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("opens on the tab the user menu asked for", async () => {
    const { dialog } = await openDialog("security");
    expect(within(dialog).getByTestId("account-tab-security")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(dialog).findByTestId("account-sessions")).toBeTruthy();
  });

  it("moves between tabs in place", async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByTestId("account-tab-privacy"));
    expect(within(dialog).getByTestId("account-export-user")).toBeTruthy();
    expect(within(dialog).queryByTestId("account-display-name")).toBeNull();
  });
});

describe("Profile", () => {
  it("saves a new display name through update_profile, and sends nothing else", async () => {
    const { user } = await openDialog(
      "profile",
      viewerWith({ avatarUrl: "https://cdn.example/a.png" }),
    );
    const name = screen.getByTestId("account-display-name");
    await user.clear(name);
    await user.type(name, "Marcus B");
    updateProfile.mockResolvedValue({
      ok: true,
      value: {
        displayName: "Marcus B",
        avatarUrl: "https://cdn.example/a.png",
      },
    });
    await user.click(screen.getByTestId("account-save"));

    // The name alone. `viewer.avatarUrl` is what the server rendered with, so
    // sending it back would revert an avatar saved since — in the editor, or
    // in another tab — because the handler writes every field it is given.
    expect(updateProfile).toHaveBeenCalledWith("acme", {
      displayName: "Marcus B",
    });
    expect(await screen.findByTestId("account-saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the person, their verified email, their roles and their principal", async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText("Marcus Bell")).toBeTruthy();
    expect(dialog).toHaveTextContent("marcus.bell@acme.example · verified");
    const roles = within(dialog).getByTestId("account-roles");
    expect(roles).toHaveTextContent("acme");
    expect(roles).toHaveTextContent("org.member");
    expect(roles).toHaveTextContent("usr_01K3F8QB7R · kind human");
  });

  it("says when the email is not verified", async () => {
    const { dialog } = await openDialog(
      "profile",
      viewerWith({ emailVerified: false }),
    );
    expect(dialog).toHaveTextContent("· not verified");
  });

  it("opens the avatar editor in place of itself, and comes back on cancel", async () => {
    const { user } = await openDialog();
    await user.click(screen.getByTestId("edit-avatar"));
    expect(await screen.findByTestId("avatar-dialog")).toBeTruthy();
    expect(screen.getByTestId("which").textContent).toBe("avatar");
    expect(screen.queryByTestId("account-dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("account-dialog")).toBeTruthy();
    expect(screen.getByTestId("which").textContent).toBe("account");
    expect(screen.getByTestId("account-tab-profile")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("previews a designed avatar as the avatar it is, not as initials", async () => {
    await openDialog(
      "profile",
      viewerWith({
        avatarUrl: 'avatar:v1:{"kind":"icon","icon":"rocket","tone":"solid"}',
      }),
    );
    const preview = await screen.findByTestId("account-avatar-preview");
    expect(preview.dataset.avatar).toBe("icon");
    expect(preview.dataset.icon).toBe("rocket");
  });

  it("reads a refusal rather than pretending the save landed (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    await user.click(screen.getByTestId("account-save"));
    expect(await screen.findByTestId("account-denied")).toBeTruthy();
    expect(screen.queryByTestId("account-saved")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("survives a thrown action without claiming a save (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockRejectedValue(new Error("network"));
    await user.click(screen.getByTestId("account-save"));
    expect(await screen.findByTestId("account-failed")).toBeTruthy();
  });

  it("keeps email out of reach: it is shown, disabled, and never sent", async () => {
    const { user } = await openDialog();
    const email = screen.getByLabelText("Email");
    expect(email).toBeDisabled();
    expect(email).toHaveAttribute("readonly");
    await user.click(screen.getByTestId("account-save"));
    // The form sends one field, so the guard is tighter than it was: email
    // cannot ride along, and neither can the stale avatar it used to carry.
    const draft: unknown = updateProfile.mock.calls[0]?.[1];
    expect(Object.keys(draft ?? {})).toEqual(["displayName"]);
  });

  // "Saved." describes the draft that was submitted. The first keystroke after
  // a save makes it false.
  it("drops the saved line the moment the draft moves away from what was persisted", async () => {
    const { user } = await openDialog();
    await user.click(screen.getByTestId("account-save"));
    expect(await screen.findByTestId("account-saved")).toBeTruthy();
    await user.type(screen.getByTestId("account-display-name"), "!");
    expect(screen.queryByTestId("account-saved")).toBeNull();
  });

  it("announces a successful save, and has the region there before the text arrives", async () => {
    const { user } = await openDialog();
    const status = screen.getByTestId("account-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status.textContent).toBe("");
    await user.click(screen.getByTestId("account-save"));
    expect(await screen.findByTestId("account-saved")).toBeTruthy();
    expect(screen.getByTestId("account-status").textContent).toBe("Saved.");
  });
});

describe("Preferences", () => {
  it("reads the stored preferences on open and writes the three fields on save", async () => {
    const { user } = await openDialog("preferences");
    expect(readPreferences).toHaveBeenCalledWith("acme");
    const zone = await screen.findByTestId("account-timezone");
    expect(zone).toHaveValue("UTC");
    expect(screen.getByTestId("account-locale")).toHaveValue("en");
    expect(screen.getByTestId("account-theme")).toHaveValue("system");

    await user.selectOptions(zone, "America/Los_Angeles");
    await user.selectOptions(screen.getByTestId("account-theme"), "dark");
    await user.click(screen.getByTestId("account-preferences-save"));

    expect(savePreferences).toHaveBeenCalledWith("acme", {
      locale: "en",
      timezone: "America/Los_Angeles",
      theme: "dark",
    });
    expect(await screen.findByTestId("account-preferences-saved")).toBeTruthy();
  });

  it("lists the zones the engine reports, and keeps a stored zone it does not", async () => {
    readPreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "Mars/Olympus", theme: "system" },
    });
    await openDialog("preferences");
    const zone = await screen.findByTestId("account-timezone");
    const offered = within(zone)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(offered).toEqual(["Mars/Olympus", ...ENGINE_ZONES]);
    expect(zone).toHaveValue("Mars/Olympus");
  });

  it("applies the theme to the page the moment it is chosen", async () => {
    const { user } = await openDialog("preferences");
    const theme = await screen.findByTestId("account-theme");
    await user.selectOptions(theme, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.selectOptions(theme, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("previews a date, a number and money under the chosen locale and zone", async () => {
    await openDialog("preferences");
    const preview = await screen.findByTestId("account-preview");
    expect(preview).toHaveTextContent("18,472");
    expect(preview).toHaveTextContent("$18,472.36");
  });

  it("reads a refused read back, with nothing to save (negative)", async () => {
    readPreferences.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "user.preferences.read",
    });
    await openDialog("preferences");
    expect(
      await screen.findByTestId("account-preferences-denied"),
    ).toBeTruthy();
    expect(screen.queryByTestId("account-preferences-save")).toBeNull();
  });

  it("reads a refused write back (negative)", async () => {
    const { user } = await openDialog("preferences");
    await screen.findByTestId("account-timezone");
    savePreferences.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "timezone",
    });
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(
      await screen.findByTestId("account-preferences-invalid"),
    ).toBeTruthy();
  });
});

describe("Security", () => {
  it("lists every session, names this device, and revokes another", async () => {
    const { user } = await openDialog("security");
    const sessions = await screen.findByTestId("account-sessions");
    expect(sessions).toHaveTextContent("Mac · Chrome 141");
    expect(sessions).toHaveTextContent("this device");
    expect(sessions).toHaveTextContent("iPhone · Safari 26");
    expect(
      within(sessions).getAllByTestId("account-session-revoke"),
    ).toHaveLength(1);

    await user.click(within(sessions).getByTestId("account-session-revoke"));
    expect(liveRevokeSession).toHaveBeenCalledWith("tok-phone");
    expect(
      within(await screen.findByTestId("account-sessions")).queryByText(
        "iPhone · Safari 26",
      ),
    ).toBeNull();
  });

  it("reissues recovery codes after the password, and shows them once", async () => {
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter22");
    await user.click(screen.getByTestId("account-codes-confirm"));

    expect(liveRegenerateBackupCodes).toHaveBeenCalledWith("hunter22");
    const codes = await screen.findByTestId("account-codes");
    expect(codes).toHaveTextContent("aaaa-bbbb");
    expect(codes).toHaveTextContent("cccc-dddd");
  });

  it("reads a refused password back and keeps the old codes (negative)", async () => {
    liveRegenerateBackupCodes.mockResolvedValue({ ok: false });
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "wrong");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(await screen.findByTestId("account-codes-refused")).toBeTruthy();
    expect(screen.queryByTestId("account-codes")).toBeNull();
  });

  it("offers enrolment, not codes, to a person without two-factor", async () => {
    await openDialog("security", viewerWith({ twoFactorEnabled: false }));
    expect(screen.getByTestId("account-two-factor-enroll")).toHaveAttribute(
      "href",
      "/two-factor?enroll=required",
    );
    expect(screen.queryByTestId("account-codes-open")).toBeNull();
  });

  it("says when the session list could not be read (negative)", async () => {
    liveListSessions.mockResolvedValue({ ok: false });
    await openDialog("security");
    expect(await screen.findByTestId("account-sessions-failed")).toBeTruthy();
  });
});

describe("Privacy", () => {
  it("queues an export of the person's own data and names the export", async () => {
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    expect(requestExport).toHaveBeenCalledWith("acme", "user");
    const queued = await screen.findByTestId("account-export-queued");
    expect(queued).toHaveTextContent("7a000000-0000-4000-8000-0000000000e1");
  });

  // export_data answers the moment it queues; the bundle is written later. If
  // the tab stopped at the id, a person could start a bundle they could never
  // receive — which is the whole point of the export.
  it("polls a queued export and offers the bundle once it is ready", async () => {
    readExportStatus.mockResolvedValueOnce({
      ok: true,
      value: {
        exportId: "7a000000-0000-4000-8000-0000000000e1",
        status: "ready",
        ready: true,
        storageKey: "privacy-exports/org/exp.zip",
      },
    });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    // The first look happens at once rather than one interval later, so a
    // bundle that is already written is offered immediately.
    const link = await screen.findByTestId("account-export-download");
    expect(readExportStatus).toHaveBeenCalledWith(
      "acme",
      "7a000000-0000-4000-8000-0000000000e1",
    );
    // The archive is a private object, so the tab links at the app's own
    // authenticated route, never at storage. A plain download anchor, not a
    // prefetching Link: fetching the archive stays an explicit act.
    expect(link.tagName).toBe("A");
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("href")).toBe(
      "/acme/account/export/7a000000-0000-4000-8000-0000000000e1",
    );
  });

  it("says so when the bundle could not be prepared (negative)", async () => {
    readExportStatus.mockResolvedValueOnce({
      ok: true,
      value: {
        exportId: "7a000000-0000-4000-8000-0000000000e1",
        status: "failed",
        ready: false,
        storageKey: null,
      },
    });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    expect(await screen.findByTestId("account-export-expired")).toBeTruthy();
    expect(screen.queryByTestId("account-export-download")).toBeNull();
  });

  // A refused or thrown poll is a blip, not a failed export: the id stays and
  // the next tick asks again.
  // A rejection, not a refusal: a server action whose request loses its
  // connection throws. Uncaught, it would repeat every three seconds for as
  // long as the tab is open.
  it("keeps the queued state when a poll throws, without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      readExportStatus.mockRejectedValue(new Error("connection lost"));
      const { user } = await openDialog("privacy");
      await user.click(screen.getByTestId("account-export-user"));
      expect(await screen.findByTestId("account-export-queued")).toBeTruthy();
      expect(screen.queryByTestId("account-export-expired")).toBeNull();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps the queued state when a poll refuses", async () => {
    readExportStatus.mockResolvedValue({ ok: false, reason: "unavailable" });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    expect(await screen.findByTestId("account-export-queued")).toBeTruthy();
    expect(screen.queryByTestId("account-export-expired")).toBeNull();
  });

  it("asks for the organization export as such, and reads a refusal back (negative)", async () => {
    requestExport.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "privacy.export",
    });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-org"));
    expect(requestExport).toHaveBeenCalledWith("acme", "org");
    expect(
      await screen.findByTestId("account-export-denied"),
    ).toHaveTextContent("owner or admin");
  });

  it("offers no erasure button, only the way it is done (negative)", async () => {
    const { dialog } = await openDialog("privacy");
    expect(dialog).toHaveTextContent("erase_data");
    expect(within(dialog).queryByRole("button", { name: /erase/i })).toBeNull();
  });
});

// ARCHITECTURE.md §1.2, the phone shell: a dialog on a phone is a sheet from
// the bottom edge with a drag handle and a full-width footer button, not a
// centred desktop modal with viewport margins.
it("presents as a bottom sheet on a phone", async () => {
  const phone = phoneWidth();
  try {
    const { dialog } = await openDialog(
      "profile",
      viewerWith(),
      phone.container,
    );
    const style = getComputedStyle(dialog);
    expect(dialog.dataset.sheet).toBe("");
    expect(style.width).toBe("100%");
    expect(style.borderRadius).toBe("18px 18px 0 0");
    expect(dialog.querySelector("[data-sheet-handle]")).not.toBeNull();
    expect(dialog.querySelector("[data-sheet-footer]")).not.toBeNull();
  } finally {
    phone.restore();
  }
});

it.each(["profile", "preferences", "security", "privacy"] as const)(
  "has no axe violations on the %s tab",
  async (tab) => {
    const { dialog } = await openDialog(tab);
    if (tab === "security") await screen.findByTestId("account-sessions");
    if (tab === "preferences") await screen.findByTestId("account-timezone");
    await expectNoAxe(dialog);
  },
);
