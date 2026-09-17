// @vitest-environment jsdom
// The Account dialog over a fake save action: that it saves a display name and
// an avatar, re-renders from the values the server stored rather than the ones
// typed, reads each refusal, and keeps email out of reach. The dialog WL-06
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
import { shellData } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

const updateProfile = vi.fn();
vi.mock("./account-actions", () => ({ updateProfile }));

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
) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AccountDialog data={shellData({ viewer })} />
      </ShellStateProvider>
    </IntlProvider>,
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

    const field = await screen.findByTestId("account-avatar-url");
    expect((field as HTMLInputElement).value).toBe(
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
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.readOnly).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(Object.keys(updateProfile.mock.calls[0]?.[1] ?? {})).toEqual([
      "displayName",
      "avatarUrl",
    ]);
  });

  it("names a person with no recorded name by their email", async () => {
    await openDialog({
      name: null,
      email: "dana@acme.example",
      avatarUrl: null,
    });
    expect(screen.getAllByText("dana@acme.example").length).toBeGreaterThan(0);
  });

  it("has no axe violations", async () => {
    const { dialog } = await openDialog();
    await expectNoAxe(dialog);
  });
});
