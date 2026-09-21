// @vitest-environment jsdom
// The Account dialog over fake actions and a fake Better Auth client: its four
// tabs (mockup `accountTabs`), what each one reads and writes, and each
// refusal read back. Profile saves a display name through update_profile and
// opens the avatar editor; Preferences reads get_user_preferences and writes
// set_preferences; Security lists sessions, revokes one, and reissues
// recovery codes; Privacy queues export_data. The onboarding demo tab of the
// mockup is not here (negative).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { recoveryCodeVault } from "./recovery-code-vault";
import { shellData } from "./shell.builders";
import { accountOperations } from "./account-operations";
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
  const { openAccount, avatarOpen, accountOpen, setTheme } = useShellState();
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
      <button type="button" onClick={() => setTheme("light")}>
        choose light from menu
      </button>
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
  timeZone?: string,
) {
  const user = userEvent.setup();
  const data = shellData({ viewer });
  render(
    <IntlProvider timeZone={timeZone}>
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
// slowest in the app. They expired first at 15s and then at 30s on a loaded
// runner. The list is a seam the dialog reads, not the subject of any test
// here, so it is stubbed down to three real zones; that the select renders
// whatever the engine reports is proven directly below.
//
// UTC is deliberately absent, because the real engine omits it: measured on
// this repo's Node, `Intl.supportedValuesOf("timeZone")` returns 418 zones
// with no "UTC" and no "Etc/UTC", ICU having canonicalized them away. A stub
// that included it would hide the defect the dialog has to handle, since UTC
// is this app's default and every seeded account starts on it.
const ENGINE_ZONES = ["America/Los_Angeles", "Europe/London", "Asia/Tokyo"];

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
  accountOperations.resetForTests();
  // The vault outlives a render, as it outlives a page's transitions.
  recoveryCodeVault.resetForTests();
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

  // `role="tab"` is a promise about the keyboard, and one that has to be kept
  // in code: the role is what tells a screen-reader user to press Left and
  // Right, so a tablist that ignores them describes a widget that does not
  // exist.
  it("moves selection with Left, Right, Home and End", async () => {
    const { user, dialog } = await openDialog();
    const at = (name: string) =>
      within(dialog).getByTestId(`account-tab-${name}`);
    at("profile").focus();

    await user.keyboard("{ArrowRight}");
    expect(at("preferences")).toHaveAttribute("aria-selected", "true");
    expect(at("preferences")).toHaveFocus();

    await user.keyboard("{End}");
    expect(at("privacy")).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(at("profile")).toHaveAttribute("aria-selected", "true");

    // Left from the first wraps to the last, so the strip has no dead end.
    await user.keyboard("{ArrowLeft}");
    expect(at("privacy")).toHaveAttribute("aria-selected", "true");
  });

  // Roving tabIndex: four tabs are one stop in the page's Tab order, not four,
  // so Tab reaches the panel rather than walking the strip.
  it("keeps only the selected tab in the Tab order", async () => {
    const { dialog } = await openDialog("security");
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "-1",
      "-1",
      "0",
      "-1",
    ]);
  });

  it("leaves other keys to the browser (negative)", async () => {
    const { user, dialog } = await openDialog();
    within(dialog).getByTestId("account-tab-profile").focus();
    await user.keyboard("{ArrowDown}");
    expect(within(dialog).getByTestId("account-tab-profile")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("Profile", () => {
  it("keeps one profile save across a tab switch", async () => {
    let finish: ((result: unknown) => void) | undefined;
    updateProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openDialog("profile");
    await user.click(screen.getByTestId("account-save"));
    await user.click(screen.getByRole("tab", { name: "Preferences" }));
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    await user.click(screen.getByTestId("account-save"));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    finish?.({
      ok: true,
      value: { displayName: "Marcus Bell", avatarUrl: null },
    });
    await waitFor(() =>
      expect(screen.getByTestId("account-save")).not.toBeDisabled(),
    );
    await user.click(screen.getByTestId("account-save"));
    expect(updateProfile).toHaveBeenCalledTimes(2);
    finish?.({
      ok: true,
      value: { displayName: "Marcus Bell", avatarUrl: null },
    });
  });

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
    // sending it back would revert an avatar saved since (in the editor, or
    // in another tab), because the handler writes every field it is given.
    expect(updateProfile).toHaveBeenCalledWith("acme", {
      displayName: "Marcus B",
    });
    expect(await screen.findByTestId("account-saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // A save is a round trip and typing does not stop while it is in flight.
  // Adopting the server's echo unconditionally deleted every character entered
  // since the button was pressed, and then said "Saved." about the value it had
  // just put back: the person reads the field, sees the old name under a line
  // claiming it is stored, and has no reason to look again.
  it("keeps a name typed while the save is in flight, and claims nothing about it", async () => {
    let finish: ((result: unknown) => void) | undefined;
    updateProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openDialog("profile");
    const name = screen.getByTestId("account-display-name");
    await user.clear(name);
    await user.type(name, "Marcus B");
    await user.click(screen.getByTestId("account-save"));

    await user.type(name, "ell");
    finish?.({ ok: true, value: { displayName: "Marcus B", avatarUrl: null } });
    await waitFor(() => {
      expect(screen.getByTestId("account-save")).not.toBeDisabled();
    });

    expect(screen.getByTestId("account-display-name")).toHaveValue(
      "Marcus Bell",
    );
    // And no "Saved.", because what is on screen is not what was stored.
    expect(screen.queryByTestId("account-saved")).toBeNull();
  });

  it("shows the person, their verified email, their roles and their user id", async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText("Marcus Bell")).toBeTruthy();
    expect(dialog).toHaveTextContent("marcus.bell@acme.example · verified");
    const roles = within(dialog).getByTestId("account-roles");
    expect(roles).toHaveTextContent("acme");
    expect(roles).toHaveTextContent("org.member");
    expect(roles).toHaveTextContent("usr_01K3F8QB7R");
  });

  // The value is Better Auth's `auth.users.id`. A human IAM principal is its
  // own `iam.principals` row linked by `parent_user_id`, so calling this one
  // "principal · kind human" published the wrong identifier for anyone
  // copying it into IAM or audit work.
  it("does not call the user id a principal (negative)", async () => {
    const { dialog } = await openDialog();
    const roles = within(dialog).getByTestId("account-roles");
    expect(roles).toHaveTextContent("user ID");
    expect(roles).not.toHaveTextContent("principal");
    expect(roles).not.toHaveTextContent("kind human");
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

  it.each(["cancel", "save"] as const)(
    "preserves the name draft through avatar %s",
    async (action) => {
      const { user } = await openDialog();
      await user.clear(screen.getByTestId("account-display-name"));
      await user.type(
        screen.getByTestId("account-display-name"),
        "New draft name",
      );
      await user.click(screen.getByTestId("edit-avatar"));
      await screen.findByTestId("avatar-dialog");
      if (action === "cancel") {
        await user.click(screen.getByRole("button", { name: "Cancel" }));
      } else {
        await user.click(screen.getByTestId("avatar-save"));
        await waitFor(() => {
          expect(updateProfile).toHaveBeenCalledOnce();
        });
        expect(updateProfile.mock.calls[0]?.[1]).not.toHaveProperty(
          "displayName",
        );
      }
      await screen.findByTestId("account-dialog");
      expect(screen.getByTestId("account-display-name")).toHaveValue(
        "New draft name",
      );
    },
  );

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
  it("keeps one preferences save across a tab switch", async () => {
    let finish: ((result: unknown) => void) | undefined;
    savePreferences.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openDialog("preferences");
    await screen.findByTestId("account-timezone");
    await user.click(screen.getByTestId("account-preferences-save"));
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    await user.click(screen.getByRole("tab", { name: "Preferences" }));
    await screen.findByTestId("account-timezone");
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(savePreferences).toHaveBeenCalledTimes(1);
    finish?.({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "system" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("account-preferences-save")).not.toBeDisabled(),
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(savePreferences).toHaveBeenCalledTimes(2);
    finish?.({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "system" },
    });
  });

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

  // The zone the row holds is the one the organization layout reads and hands
  // to <ViewerClock> and the chrome, so a saved zone the page does not re-read
  // in leaves every date on the old clock until a full reload.
  it("re-renders the server tree when the saved zone is not the one the page rendered in", async () => {
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-timezone"),
      "Europe/London",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(await screen.findByTestId("account-preferences-saved")).toBeTruthy();
    expect(savePreferences).toHaveBeenCalledWith("acme", {
      locale: "en",
      timezone: "Europe/London",
      theme: "system",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves the tree alone when the zone did not move (negative)", async () => {
    readPreferences.mockResolvedValue({
      ok: true,
      value: {
        locale: "en",
        timezone: shellData().viewer.timeZone,
        theme: "system",
      },
    });
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "light",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(await screen.findByTestId("account-preferences-saved")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  // The same clobber as the Profile tab's, and it bites harder here: the theme
  // selector commits on change, so the page would already be following the
  // newer theme while the form reverted to the older one and called it saved.
  it("keeps a choice made while the save is in flight, and claims nothing about it", async () => {
    let finish: ((result: unknown) => void) | undefined;
    savePreferences.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openDialog("preferences");
    const zone = await screen.findByTestId("account-timezone");
    await user.selectOptions(zone, "America/Los_Angeles");
    await user.click(screen.getByTestId("account-preferences-save"));

    await user.selectOptions(screen.getByTestId("account-theme"), "dark");
    finish?.({
      ok: true,
      value: { locale: "en", timezone: "America/Los_Angeles", theme: "system" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("account-preferences-save")).not.toBeDisabled();
    });

    expect(screen.getByTestId("account-theme")).toHaveValue("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("theme=system");
    expect(screen.queryByTestId("account-preferences-saved")).toBeNull();
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
    expect(offered).toEqual(["Mars/Olympus", "UTC", ...ENGINE_ZONES]);
    expect(zone).toHaveValue("Mars/Olympus");
  });

  // The engine's list has no UTC, so offering exactly what it reports would
  // let a person move off UTC and never get back: it is the app's default and
  // what every seeded account starts on.
  it("offers UTC even though the engine does not list it", async () => {
    readPreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "Europe/London", theme: "system" },
    });
    const { user } = await openDialog("preferences");
    const zone = await screen.findByTestId("account-timezone");
    expect(
      within(zone)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["UTC", ...ENGINE_ZONES]);

    // And it is choosable, not only drawn.
    await user.selectOptions(zone, "UTC");
    await user.click(screen.getByTestId("account-preferences-save"));
    expect(savePreferences).toHaveBeenCalledWith("acme", {
      locale: "en",
      timezone: "UTC",
      theme: "system",
    });
  });

  // `useTheme` seeds from the theme cookie, which is per browser, so a new
  // browser or a cleared cookie left a stored "dark" selected in the form
  // while the page rendered the system theme. The tab contradicted the page,
  // and the saved preference was honoured only if the person toggled the
  // control that already showed the value they wanted.
  it("applies a stored theme the page is not already on", async () => {
    // jsdom's document is shared by every case in this file, so an earlier
    // one leaves both the theme cookie and the root element on dark. Both are
    // cleared, which is also the state this test is about: a browser that has
    // never been told a theme. Without clearing the cookie, `useTheme` seeds
    // itself dark and the assertion passes whether or not the read applies
    // anything.
    document.cookie = "theme=; Path=/; Max-Age=0";
    delete document.documentElement.dataset.theme;
    readPreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "dark" },
    });
    await openDialog("preferences");
    expect(await screen.findByTestId("account-theme")).toHaveValue("dark");
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
  });

  it("applies the theme to the page the moment it is chosen", async () => {
    const { user } = await openDialog("preferences");
    const theme = await screen.findByTestId("account-theme");
    await user.selectOptions(theme, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.selectOptions(theme, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("discards a theme preview on a tab change without persisting it", async () => {
    readPreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "light" },
    });
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "dark",
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("theme=light");
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.cookie).toContain("theme=light");
  });

  it("restores the saved theme when the preference write is refused", async () => {
    readPreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "light" },
    });
    savePreferences.mockResolvedValue({ ok: false, reason: "denied" });
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "dark",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("light");
    });
    expect(document.cookie).toContain("theme=light");
    expect(screen.getByTestId("account-theme")).toHaveValue("dark");
  });

  it("keeps a successfully saved theme after the preview panel closes", async () => {
    savePreferences.mockResolvedValue({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "dark" },
    });
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "dark",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    await waitFor(() => {
      expect(document.cookie).toContain("theme=dark");
    });
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("theme=dark");
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
  // Preferences promises every date and time follows the zone chosen there,
  // and this list used to answer in UTC regardless: `toISOString()` sliced and
  // suffixed with a Z. "Was that me?" is a question about the clock the person
  // was actually looking at, so a device list in the wrong zone is the one
  // place that promise matters most.
  it("shows device activity in the viewer's zone, not UTC", async () => {
    await openDialog(
      "security",
      viewerWith(),
      undefined,
      "America/Los_Angeles",
    );
    const sessions = await screen.findByTestId("account-sessions");
    // 2026-09-11T08:12:00Z is 01:12 in Los Angeles, on the same date.
    expect(sessions).toHaveTextContent("1:12");
    expect(sessions).not.toHaveTextContent("08:12");
    expect(sessions).not.toHaveTextContent(/\dZ\b/);
  });

  it("lists every session, names this device, and revokes another", async () => {
    const { user } = await openDialog("security");
    const sessions = await screen.findByTestId("account-sessions");
    expect(sessions).toHaveTextContent("Mac · Chrome 141");
    expect(sessions).toHaveTextContent("this device");
    expect(sessions).toHaveTextContent("iPhone · Safari 26");
    // The house vocabulary reserves "session" for an agent's run, so a human
    // authentication record is a signed-in device. A customer who saw both
    // words in one product could not tell which one this list was about.
    expect(sessions).not.toHaveTextContent(/session/i);
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

  it.each(["refused", "thrown"] as const)(
    "keeps devices and retries a %s revoke",
    async (failure) => {
      if (failure === "refused") liveRevokeSession.mockResolvedValueOnce(false);
      else liveRevokeSession.mockRejectedValueOnce(new Error("offline"));
      const { user } = await openDialog("security");
      const sessions = await screen.findByTestId("account-sessions");
      await user.click(within(sessions).getByTestId("account-session-revoke"));
      expect(
        await screen.findByTestId("account-session-revoke-failed"),
      ).toHaveTextContent("Try again");
      expect(sessions).toHaveTextContent("iPhone");
      expect(screen.queryByTestId("account-sessions-failed")).toBeNull();
      liveRevokeSession.mockResolvedValueOnce(true);
      await user.click(within(sessions).getByTestId("account-session-revoke"));
      await waitFor(() => expect(sessions).not.toHaveTextContent("iPhone"));
      expect(liveRevokeSession).toHaveBeenCalledTimes(2);
    },
  );

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

  // A failure that says nothing about what the server did is not a refusal,
  // and calling it one is the answer that gets somebody locked out. Better
  // Auth voids the old codes the moment it commits, so a lost response may be
  // a committed rotation: the old set already dead and the new one gone. Told
  // "that password was not accepted", the person carries on with codes that no
  // longer work and finds out when the authenticator is gone.
  it("says the outcome is unknown when the server answers with a failure", async () => {
    // Resolved, not thrown. A 5xx comes back through the client as an error
    // reply rather than an exception, so the lost-answer case above does not
    // cover it, and reading it as a refusal is the claim that misleads: the
    // rotation may have committed before the failure, leaving the old set void
    // and the new one nowhere.
    liveRegenerateBackupCodes.mockResolvedValueOnce({
      ok: false,
      refused: false,
    });
    const { user } = await openDialog("security");
    const asked = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));

    expect(await screen.findByTestId("account-codes-uncertain")).toBeTruthy();
    expect(screen.queryByTestId("account-codes-refused")).toBeNull();
    // Nothing is shown as if it were the stored set, and the page stays
    // guarded, because the codes may already have changed.
    expect(screen.queryByTestId("account-codes")).toBeNull();
    expect(asked()).toBe(true);
  });

  it("reads a refused password back and shows no set at all (negative)", async () => {
    liveRegenerateBackupCodes.mockResolvedValue({ ok: false, refused: true });
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "wrong");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(await screen.findByTestId("account-codes-refused")).toBeTruthy();
    expect(screen.queryByTestId("account-codes")).toBeNull();
  });

  // A rotation voids the previous codes on the server the moment it lands, so
  // two of them in flight settle in either order and the loser's set can be
  // written over the winner's. The person then reads a set the server has
  // already invalidated, with nothing on screen to say so, and finds out only
  // once the authenticator is gone and the codes are the only way back in.
  //
  // What allowed two: the pending flag lived in the tab's own state, and
  // Cancel, a tab switch and a close each throw that state away while the
  // request carries on. Both bypasses are driven here.
  it("runs one rotation at a time, through Cancel and through leaving the tab", async () => {
    const settle: ((result: unknown) => void)[] = [];
    liveRegenerateBackupCodes.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve);
        }),
    );
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(settle).toHaveLength(1);

    // Cancel, which used to close the form and drop the pending flag with it.
    await user.click(screen.getByTestId("account-codes-cancel"));
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(settle).toHaveLength(1);

    // Leaving the tab, which unmounts every state the tab holds.
    await user.click(screen.getByTestId("account-tab-profile"));
    await user.click(screen.getByTestId("account-tab-security"));
    expect(screen.queryByTestId("account-codes-open")).toBeNull();
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(settle).toHaveLength(1);

    // One rotation ran, so there is one stored set, and it is the one shown, to
    // the mount that returned as well as to the one that asked.
    settle[0]?.({ ok: true, codes: ["kept-1111", "kept-2222"] });
    const shown = await screen.findByTestId("account-codes");
    expect(shown).toHaveTextContent("kept-1111");
    expect(shown).toHaveTextContent("kept-2222");
    expect(liveRegenerateBackupCodes).toHaveBeenCalledTimes(1);
  });

  // A refusal says nothing about whether the server wrote before it answered,
  // so a set left on screen would be claiming to be the stored set without
  // knowing it. Nothing is shown, nothing is vaulted, and the affordance is
  // released rather than held shut by the rotation that failed.
  it("leaves no set on screen or in the vault when a rotation fails (negative)", async () => {
    liveRegenerateBackupCodes.mockResolvedValue({ ok: false, refused: true });
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "wrong");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(await screen.findByTestId("account-codes-refused")).toBeTruthy();
    expect(screen.queryByTestId("account-codes")).toBeNull();

    await user.click(screen.getByTestId("account-tab-profile"));
    await user.click(screen.getByTestId("account-tab-security"));
    expect(screen.queryByTestId("account-codes")).toBeNull();

    // And a second attempt is still possible: the gate is released, not stuck.
    liveRegenerateBackupCodes.mockResolvedValue({
      ok: true,
      codes: ["next-1111", "next-2222"],
    });
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(await screen.findByTestId("account-codes")).toHaveTextContent(
      "next-1111",
    );
  });

  // Better Auth rotates the codes server-side the moment the call lands, so
  // the old set is void whether or not anyone is still looking. The tab is
  // keyed on the tab name and unmounted when the dialog closes, so if it held
  // the only copy, a switch or a close mid-flight voided one set and dropped
  // the next. That is a locked-out account on the next lost authenticator.
  it("holds the Security tab and dismissal until issued codes are acknowledged", async () => {
    let issue: ((result: unknown) => void) | undefined;
    liveRegenerateBackupCodes.mockImplementation(
      () =>
        new Promise((resolve) => {
          issue = resolve;
        }),
    );
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));

    expect(screen.getByTestId("account-tab-profile")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("account-dialog")).toBeTruthy();
    await user.click(screen.getByTestId("account-tab-profile"));
    expect(screen.queryByTestId("account-codes")).toBeNull();
    issue?.({ ok: true, codes: ["zzzz-1111", "zzzz-2222"] });

    await user.click(screen.getByTestId("account-tab-security"));
    const shown = await screen.findByTestId("account-codes");
    expect(shown).toHaveTextContent("zzzz-1111");
    expect(shown).toHaveTextContent("zzzz-2222");
    expect(screen.getByTestId("account-codes-held")).toBeTruthy();
    expect(screen.getByTestId("account-tab-profile")).toBeDisabled();
    await user.click(screen.getByTestId("account-codes-saved"));
    expect(screen.getByTestId("account-tab-profile")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("keeps the dialog open while issued codes await acknowledgement", async () => {
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes");

    await user.keyboard("{Escape}");
    expect(screen.getByTestId("account-dialog")).toBeTruthy();
    expect(await screen.findByTestId("account-codes")).toHaveTextContent(
      "aaaa-bbbb",
    );
  });

  // Acknowledgement is the only signal that the single showing landed, so it
  // is what clears them rather than a close or a tab switch.
  it("lets them go once the person says they are saved", async () => {
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes");

    await user.click(screen.getByTestId("account-codes-saved"));
    expect(screen.queryByTestId("account-codes")).toBeNull();

    await user.click(screen.getByTestId("account-tab-profile"));
    await user.click(screen.getByTestId("account-tab-security"));
    expect(screen.queryByTestId("account-codes")).toBeNull();
    expect(await screen.findByTestId("account-codes-open")).toBeTruthy();
  });

  // A reload is the one exit the vault cannot survive: the component is gone,
  // Better Auth voided the old set when it issued this one, and it keeps only
  // hashes of the new one, so nothing can show it again. Holding the plaintext
  // codes server-side until acknowledgement would fix the reload by putting a
  // second-factor bypass in the database in recoverable form; losing an unsaved
  // set costs one more rotation by someone who is signed in and still holds the
  // authenticator. So the loss is made deliberate instead of silent.
  it("asks before unloading the page while a set is unsaved", async () => {
    const { user } = await openDialog("security");
    // `dispatchEvent` answers false when a listener cancelled the event, which
    // is what the browser reads as "ask before leaving".
    const asked = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    // Nothing outstanding, nothing asked.
    expect(asked()).toBe(false);

    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes");
    expect(asked()).toBe(true);

    // And it stops once the showing has landed, so an acknowledged rotation
    // does not leave the browser nagging about a page with nothing at stake.
    await user.click(screen.getByTestId("account-codes-saved"));
    expect(asked()).toBe(false);
  });

  // Better Auth voids the old set the moment the rotation lands, before the
  // response arrives. A reload in that gap loses the only copy of the new set,
  // so the guard has to be up while the rotation is in flight, not only once
  // a set is on screen.
  // Any client-side transition out of the organization, Back and Forward
  // included, unmounts the shell and this dialog with it, and none of them
  // runs `beforeunload`. The set is held in a module that outlives the shell,
  // so a rotation that answers while no shell is mounted is still there, and
  // the next shell to mount puts it back in front of the person.
  it("keeps a set across the shell unmounting, and shows it on arrival", async () => {
    let issue: ((result: unknown) => void) | undefined;
    liveRegenerateBackupCodes.mockImplementation(
      () =>
        new Promise((resolve) => {
          issue = resolve;
        }),
    );
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));

    // Leave: the whole tree goes, as it does on Back into another organization.
    cleanup();
    issue?.({ ok: true, codes: ["back-1111", "back-2222"] });
    await Promise.resolve();

    // Arrive in a fresh shell. The Security tab opens on its own, with the set.
    render(
      <IntlProvider>
        <ShellStateProvider>
          <OpenIt />
          <AccountDialog data={shellData({ viewer: viewerWith() })} />
        </ShellStateProvider>
      </IntlProvider>,
    );
    const shown = await screen.findByTestId("account-codes");
    expect(shown).toHaveTextContent("back-1111");
    expect(screen.getByTestId("account-tab-security")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // The vault is keyed to the person the set was issued to. A different
  // person in the same page is never shown it.
  it("never shows a held set to a different person (negative)", async () => {
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes");
    cleanup();

    await openDialog(
      "security",
      viewerWith({ id: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(screen.queryByTestId("account-codes")).toBeNull();
  });

  it("asks before unloading the page while a rotation is in flight", async () => {
    let issue: ((result: unknown) => void) | undefined;
    liveRegenerateBackupCodes.mockImplementation(
      () =>
        new Promise((resolve) => {
          issue = resolve;
        }),
    );
    const { user } = await openDialog("security");
    const asked = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(screen.queryByTestId("account-codes")).toBeNull();
    expect(asked()).toBe(true);

    issue?.({ ok: true, codes: ["pend-1111", "pend-2222"] });
    await screen.findByTestId("account-codes");
    expect(asked()).toBe(true);

    await user.click(screen.getByTestId("account-codes-saved"));
    expect(asked()).toBe(false);
  });

  // A refused rotation leaves nothing at stake, so the guard must release: the
  // old codes still work and there is no new set to lose.
  it("stops asking when a rotation is refused (negative)", async () => {
    liveRegenerateBackupCodes.mockResolvedValue({ ok: false, refused: true });
    const { user } = await openDialog("security");
    const asked = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "wrong");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes-refused");
    expect(asked()).toBe(false);
  });

  // Two tabs of one browser rotating for one account void each other's sets,
  // and neither tab can see the other's rotation in its own memory. When
  // another tab holds the cross-tab claim, this one sends nothing and says
  // why.
  it("sends nothing while another tab holds the rotation (negative)", async () => {
    Object.defineProperty(navigator, "locks", {
      value: {
        request: (
          _name: string,
          _options: unknown,
          callback: (lock: null) => unknown,
        ) => Promise.resolve(callback(null)),
      },
      configurable: true,
    });
    try {
      const { user } = await openDialog("security");
      await user.click(screen.getByTestId("account-codes-open"));
      await user.type(screen.getByTestId("account-codes-password"), "hunter2");
      await user.click(screen.getByTestId("account-codes-confirm"));
      expect(await screen.findByTestId("account-codes-elsewhere")).toBeTruthy();
      expect(liveRegenerateBackupCodes).not.toHaveBeenCalled();
      const asked = () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      expect(asked()).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  // A thrown call is a lost answer, not a refusal. The server may have
  // committed the rotation before the connection went, which voids the old set
  // and leaves the new one nowhere. Saying "password not accepted" would let
  // the person leave thinking nothing changed, so the page stays guarded, the
  // form says the codes may have changed, and only a set that does arrive
  // releases it.
  it("keeps the page guarded when a rotation's answer is lost", async () => {
    liveRegenerateBackupCodes.mockRejectedValueOnce(new Error("offline"));
    const { user } = await openDialog("security");
    const asked = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    expect(await screen.findByTestId("account-codes-uncertain")).toBeTruthy();
    expect(screen.queryByTestId("account-codes-refused")).toBeNull();
    expect(asked()).toBe(true);

    // A refusal now does not settle the earlier doubt.
    liveRegenerateBackupCodes.mockResolvedValueOnce({
      ok: false,
      refused: true,
    });
    await user.type(screen.getByTestId("account-codes-password"), "wrong");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes-refused");
    expect(screen.getByTestId("account-codes-uncertain")).toBeTruthy();
    expect(asked()).toBe(true);

    // A set that arrives does, once it is saved.
    liveRegenerateBackupCodes.mockResolvedValueOnce({
      ok: true,
      codes: ["safe-1111", "safe-2222"],
    });
    await user.clear(screen.getByTestId("account-codes-password"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes");
    await user.click(screen.getByTestId("account-codes-saved"));
    expect(asked()).toBe(false);
  });

  // Cancel closes the password form, and a rotation nobody heard back from is
  // not cancelled by it. While the notice lived inside that form, Cancel took
  // the only line on screen saying the codes may already be void away and left
  // an ordinary Regenerate button, so the notice sits on the two-factor row
  // instead and outlasts the form, a tab switch and a closed dialog.
  it("keeps the notice up through Cancel, a tab switch and a close", async () => {
    liveRegenerateBackupCodes.mockRejectedValue(new Error("offline"));
    const { user } = await openDialog("security");
    await user.click(screen.getByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await screen.findByTestId("account-codes-uncertain");

    await user.click(screen.getByTestId("account-codes-cancel"));
    expect(screen.queryByTestId("account-codes-password")).toBeNull();
    expect(screen.getByTestId("account-codes-uncertain")).toBeTruthy();

    await user.click(screen.getByTestId("account-tab-profile"));
    await user.click(screen.getByTestId("account-tab-security"));
    expect(await screen.findByTestId("account-codes-uncertain")).toBeTruthy();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "open security" }));
    expect(await screen.findByTestId("account-codes-uncertain")).toBeTruthy();
  });

  // The second rotation is never started, so no late first response can exist
  // to be sorted out: "runs one rotation at a time" above is what closes this,
  // and it also closes the tab-switch bypass, which a ticket held inside the
  // tab cannot, since the switch destroys the ticket along with everything else
  // the tab owns.

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
  it("keeps the queued export when Privacy unmounts and refuses another request", async () => {
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    await screen.findByTestId("account-export-queued");
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    await user.click(screen.getByRole("tab", { name: "Privacy" }));
    await screen.findByTestId("account-export-queued");
    await user.click(screen.getByTestId("account-export-org"));
    expect(requestExport).toHaveBeenCalledTimes(1);
    expect(readExportStatus).toHaveBeenCalledWith(
      "acme",
      "7a000000-0000-4000-8000-0000000000e1",
    );
  });

  it("queues an export of the person's own data and names the export", async () => {
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    expect(requestExport).toHaveBeenCalledWith("acme", "user");
    const queued = await screen.findByTestId("account-export-queued");
    expect(queued).toHaveTextContent("7a000000-0000-4000-8000-0000000000e1");
  });

  // export_data answers the moment it queues; the bundle is written later. If
  // the tab stopped at the id, a person could start a bundle they could never
  // receive, which is the whole point of the export.
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

  it("keeps the queued state when a poll is unavailable", async () => {
    readExportStatus.mockResolvedValue({ ok: false, reason: "unavailable" });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-user"));
    expect(await screen.findByTestId("account-export-queued")).toBeTruthy();
    expect(screen.queryByTestId("account-export-expired")).toBeNull();
  });

  // Not a blip: `get_export_status` re-checks Owner or Admin on an
  // organization export at read time, so an Owner demoted while the bundle is
  // being written starts being refused mid-poll. Retrying that every three
  // seconds until the tab closes asks a question already answered, under a
  // line still promising an update.
  it("stops polling and says so when a poll is denied (negative)", async () => {
    readExportStatus.mockResolvedValue({ ok: false, reason: "denied" });
    const { user } = await openDialog("privacy");
    await user.click(screen.getByTestId("account-export-org"));
    expect(await screen.findByTestId("account-export-denied")).toBeTruthy();
    expect(screen.queryByTestId("account-export-queued")).toBeNull();

    // Terminal: leaving the queued state clears the interval, so no further
    // read is issued however long the tab stays open.
    const asked = readExportStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readExportStatus.mock.calls.length).toBe(asked);
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

// 60s, not the 30s default. The zone stub above takes the bulk of the cost
// out, but these are still the four slowest assertions in the app: axe-core
// runs five WCAG rule sets over a whole dialog under jsdom, four times. They
// have already expired twice on a loaded runner — at 15s, then at 30s, which
// failed the entire `test` job with no violation to show for it (run
// 35398598488). A budget the honest work does not fit in reports a slow
// assertion as an accessibility failure, which is the one thing this check
// must never do, so the headroom stays even now the work is smaller.
it.each(["profile", "preferences", "security", "privacy"] as const)(
  "has no axe violations on the %s tab",
  async (tab) => {
    const { dialog } = await openDialog(tab);
    if (tab === "security") await screen.findByTestId("account-sessions");
    if (tab === "preferences") await screen.findByTestId("account-timezone");
    await expectNoAxe(dialog);
  },
  60_000,
);

it.each(["denied", "throw"])(
  "keeps a newer preview when an earlier save fails: %s",
  async (failure) => {
    let finish: ((result: unknown) => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    savePreferences.mockImplementation(
      () =>
        new Promise((resolve, refuse) => {
          finish = resolve;
          reject = refuse;
        }),
    );
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "light",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    await user.selectOptions(screen.getByTestId("account-theme"), "dark");
    if (failure === "throw") reject?.(new Error("offline"));
    else finish?.({ ok: false, reason: "denied" });
    await screen.findByTestId(
      `account-preferences-${failure === "throw" ? "failed" : "denied"}`,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("account-theme")).toHaveValue("dark");
  },
);

it.each([true, false])(
  "retains the submitted draft and settlement across a tab remount, success=%s",
  async (success) => {
    let finish: ((result: unknown) => void) | undefined;
    savePreferences.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openDialog("preferences");
    await user.selectOptions(
      await screen.findByTestId("account-theme"),
      "dark",
    );
    await user.click(screen.getByTestId("account-preferences-save"));
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    await user.click(screen.getByRole("tab", { name: "Preferences" }));
    expect(await screen.findByTestId("account-theme")).toHaveValue("dark");
    expect(screen.getByTestId("account-preferences-save")).toBeDisabled();
    finish?.(
      success
        ? { ok: true, value: { locale: "en", timezone: "UTC", theme: "dark" } }
        : { ok: false, reason: "denied" },
    );
    await screen.findByTestId(
      `account-preferences-${success ? "saved" : "denied"}`,
    );
    expect(screen.getByTestId("account-theme")).toHaveValue("dark");
    expect(readPreferences).toHaveBeenCalledTimes(1);
  },
);

it("keeps a menu theme chosen after the pending preferences panel closes", async () => {
  let finish: ((result: unknown) => void) | undefined;
  savePreferences.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { user } = await openDialog("preferences");
  await user.selectOptions(await screen.findByTestId("account-theme"), "dark");
  await user.click(screen.getByTestId("account-preferences-save"));
  await user.click(screen.getByRole("tab", { name: "Profile" }));
  await user.click(
    screen.getByRole("button", { name: "choose light from menu" }),
  );
  finish?.({
    ok: true,
    value: { locale: "en", timezone: "UTC", theme: "dark" },
  });
  await waitFor(() =>
    expect(
      accountOperations.isPending(shellData().viewer.id, "preferences"),
    ).toBe(false),
  );
  expect(document.cookie).toContain("theme=light");
  expect(document.documentElement.dataset.theme).toBe("light");
});
