// @vitest-environment jsdom
// The Account dialog over a fake save action: that it saves a display name and
// an avatar, re-renders from the values the server stored rather than the ones
// typed, refreshes the shell so the chrome stops showing the old identity,
// previews a designed avatar as the avatar it is, presents as a bottom sheet on
// a phone, reads each refusal, and keeps email out of reach. The dialog WL-06
// deleted could not save at all, so the assertion that matters most here is the
// first one — a control that calls updateProfile and shows what came back.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { ShellStateProvider, useShellState } from "./shell-state";

const updateProfile = vi.fn();
vi.mock("./account-actions", () => ({ updateProfile }));

// The dialog re-renders the server tree after a save, through useNavigate ---
// the app's one useRouter importer (INV-13).
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const { AccountDialog } = await import("./account-dialog");

/** The dialog renders from shell state, so a test needs the way a person opens it. */
function OpenIt() {
  const { setAccountOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAccountOpen(true);
      }}
    >
      open account
    </button>
  );
}

async function openDialog(
  viewer: { name: string | null; email: string; avatarUrl: string | null } = {
    name: "Marcus Bell",
    email: "marcus.bell@acme.example",
    avatarUrl: null,
  },
  container?: HTMLElement,
) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AccountDialog data={shellData({ viewer })} />
      </ShellStateProvider>
    </IntlProvider>,
    container ? { container } : undefined,
  );
  await user.click(screen.getByRole("button", { name: "open account" }));
  return { user, dialog: await screen.findByTestId("account-dialog") };
}

// The dialog renders under ShellStateProvider, which reads the theme from a
// media query jsdom does not implement.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  refresh.mockReset();
  updateProfile.mockReset();
  updateProfile.mockResolvedValue({
    ok: true,
    value: { displayName: "Marcus Bell", avatarUrl: null },
  });
});
afterEach(cleanup);

describe("AccountDialog", () => {
  it("saves a new display name through update_profile for the viewer's organization", async () => {
    const { user } = await openDialog();
    const name = screen.getByTestId("account-display-name");
    await user.clear(name);
    await user.type(name, "Marcus B");
    updateProfile.mockResolvedValue({
      ok: true,
      value: { displayName: "Marcus B", avatarUrl: null },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateProfile).toHaveBeenCalledWith("acme", {
      displayName: "Marcus B",
      avatarUrl: "",
    });
    expect(await screen.findByTestId("account-saved")).toBeTruthy();
  });

  it("saves an avatar URL and shows the image the server stored, not the one typed", async () => {
    const { user } = await openDialog();
    await user.type(
      screen.getByTestId("account-avatar-url"),
      "https://cdn.example/a.png",
    );
    updateProfile.mockResolvedValue({
      ok: true,
      value: {
        displayName: "Marcus Bell",
        avatarUrl: "https://cdn.example/stored.png",
      },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-avatar-url")).toHaveValue(
      "https://cdn.example/stored.png",
    );
  });

  it("renders the initials, never a broken image, when the person has no avatar", async () => {
    await openDialog();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reads a refusal rather than pretending the save landed (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-denied")).toBeTruthy();
    expect(screen.queryByTestId("account-saved")).toBeNull();
  });

  it("reads an invalid display name back as invalid (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "displayName",
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-invalid")).toBeTruthy();
  });

  it("survives a thrown action without claiming a save (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockRejectedValue(new Error("network"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-failed")).toBeTruthy();
    expect(screen.queryByTestId("account-saved")).toBeNull();
  });

  it("keeps email out of reach: it is shown, disabled, and never sent", async () => {
    const { user } = await openDialog();
    const email = screen.getByLabelText("Email");
    expect(email).toBeDisabled();
    expect(email).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const draft: unknown = updateProfile.mock.calls[0]?.[1];
    expect(Object.keys(draft ?? {})).toEqual(["displayName", "avatarUrl"]);
  });

  it("names a person with no recorded name by their email", async () => {
    await openDialog({
      name: null,
      email: "dana@acme.example",
      avatarUrl: null,
    });
    expect(screen.getAllByText("dana@acme.example").length).toBeGreaterThan(0);
  });

  // The top bar's user menu renders `data.viewer` off the server. Without a
  // refresh the chrome keeps the old name and avatar on this page and across
  // client-side navigation, because the shell lives in the org layout.
  it("refreshes the shell so the top bar stops showing the old identity", async () => {
    const { user } = await openDialog();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the shell when the save was refused (negative)", async () => {
    const { user } = await openDialog();
    updateProfile.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("account-denied")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  // `avatarUrlSchema` accepts a designed avatar everywhere an avatar is
  // written, so a preview that tests for `https://` alone tells a person with a
  // valid one that they have no avatar at all.
  it("previews a designed avatar as the avatar it is, not as initials", async () => {
    await openDialog({
      name: "Marcus Bell",
      email: "marcus.bell@acme.example",
      avatarUrl: 'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}',
    });
    const preview = await screen.findByTestId("account-avatar-preview");
    expect(preview.dataset.avatar).toBe("designed");
    expect(preview.textContent).toBe("🦊");
  });

  it("previews a designed avatar the moment it is typed", async () => {
    const { user } = await openDialog();
    expect(screen.getByTestId("account-avatar-preview").dataset.avatar).toBe(
      "initials",
    );
    await user.type(
      screen.getByTestId("account-avatar-url"),
      'avatar:v1:{{"emoji":"🦊","bg":"#f59e0b","mode":"full"}',
    );
    expect(screen.getByTestId("account-avatar-preview").dataset.avatar).toBe(
      "designed",
    );
  });

  // ARCHITECTURE.md §1.2, the phone shell: a dialog on a phone is a sheet from
  // the bottom edge with a drag handle and a full-width footer button, not a
  // centred desktop modal with viewport margins.
  it("presents as a bottom sheet on a phone", async () => {
    const phone = phoneWidth();
    try {
      const { dialog } = await openDialog(undefined, phone.container);
      const style = getComputedStyle(dialog);
      expect(dialog.dataset.sheet).toBe("");
      expect(style.width).toBe("100%");
      expect(style.borderRadius).toBe("18px 18px 0 0");
      expect(style.paddingBottom).toBe(
        "calc(0px + env(safe-area-inset-bottom))",
      );
      expect(dialog.querySelector("[data-sheet-handle]")).not.toBeNull();
      expect(dialog.querySelector("[data-sheet-footer]")).not.toBeNull();
    } finally {
      phone.restore();
    }
  });

  it("has no axe violations", async () => {
    const { dialog } = await openDialog();
    await expectNoAxe(dialog);
  });
});
