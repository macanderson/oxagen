// @vitest-environment jsdom
// The avatar editor (mockup `avatarBody`) over a fake save: three kinds, the
// twenty-four Lucide glyphs, a monogram of up to six letters in three
// typefaces, three tones as live swatches, a preview at every size the shell
// draws, and a save that writes the spec string through update_profile and
// returns to the Account dialog. Nothing here is an emoji or a free colour.
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
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
import { AVATAR_ICONS } from "@/ui/avatar-spec";
import { shellData } from "./shell.builders";
import { accountOperations } from "./account-operations";
import type { ShellData } from "./shell-data";
import { ShellStateProvider, useShellState } from "./shell-state";

const updateProfile = vi.fn();
vi.mock("./account-actions", () => ({ updateProfile }));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const { AvatarDialog } = await import("./avatar-dialog");

function OpenIt() {
  const { setAvatarOpen, avatarOpen, accountOpen } = useShellState();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setAvatarOpen(true);
        }}
      >
        open avatar
      </button>
      <output data-testid="which">
        {avatarOpen ? "avatar" : accountOpen ? "account" : "none"}
      </output>
    </>
  );
}

async function openEditor(viewer: Partial<ShellData["viewer"]> = {}) {
  const user = userEvent.setup();
  const data = shellData({ viewer: { ...shellData().viewer, ...viewer } });
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AvatarDialog data={data} />
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open avatar" }));
  const dialog = await screen.findByTestId("avatar-dialog");
  return {
    user,
    dialog,
    preview: within(dialog).getByTestId("avatar-preview"),
  };
}

function tiles(preview: HTMLElement): HTMLElement[] {
  return Array.from(preview.querySelectorAll<HTMLElement>("[data-avatar]"));
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  accountOperations.resetForTests();
  refresh.mockReset();
  updateProfile.mockReset();
  updateProfile.mockResolvedValue({
    ok: true,
    value: { displayName: "Marcus Bell", avatarUrl: "avatar:v1:{}" },
  });
});
afterEach(cleanup);

describe("the draft", () => {
  it("opens on the person's initials in the solid tone when nothing is stored", async () => {
    const { dialog, preview } = await openEditor();
    expect(within(dialog).getByTestId("avatar-kind-initials")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-letters")).toHaveValue("MB");
    const [big] = tiles(preview);
    expect(big?.dataset.avatar).toBe("initials");
    expect(big?.dataset.tone).toBe("solid");
    expect(big?.textContent).toBe("MB");
  });

  it("opens on what is stored, so a person edits rather than starts over", async () => {
    const { dialog } = await openEditor({
      avatarUrl: 'avatar:v1:{"kind":"icon","icon":"compass","tone":"line"}',
    });
    expect(within(dialog).getByTestId("avatar-kind-icon")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-icon-compass")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-tone-line")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("previews the draft at 72, 36, 24 and 18 pixels", async () => {
    const { preview } = await openEditor();
    expect(tiles(preview).map((t) => t.style.width)).toEqual([
      "72px",
      "36px",
      "24px",
      "18px",
    ]);
  });
});

describe("Icon", () => {
  it("offers the twenty-four Lucide glyphs as line icons, never emoji", async () => {
    const { user, dialog, preview } = await openEditor();
    await user.click(within(dialog).getByTestId("avatar-kind-icon"));
    const grid = within(dialog).getByRole("group", { name: "Icon" });
    const buttons = within(grid).getAllByRole("button");
    expect(buttons).toHaveLength(AVATAR_ICONS.length);
    for (const b of buttons) {
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.textContent).toBe("");
    }
    await user.click(within(dialog).getByTestId("avatar-icon-rocket"));
    expect(tiles(preview)[0]?.dataset.icon).toBe("rocket");
    expect(dialog).toHaveTextContent("icon · rocket · solid tone");
  });
});

describe("Initials", () => {
  it("keeps the monogram to six letters, upper-cased in the preview", async () => {
    const { user, dialog, preview } = await openEditor();
    const letters = within(dialog).getByTestId("avatar-letters");
    expect(letters).toHaveAttribute("maxlength", "6");
    await user.clear(letters);
    await user.type(letters, "marcusbell");
    expect(letters).toHaveValue("marcus");
    expect(tiles(preview)[0]?.textContent).toBe("MARCUS");
    expect(dialog).toHaveTextContent("Up to 6.");
  });

  it("offers sans, serif and mono, each drawn in its own face", async () => {
    const { user, dialog, preview } = await openEditor();
    const faces = within(dialog).getByRole("group", { name: "Typeface" });
    expect(
      within(faces)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Sans", "Serif", "Mono"]);
    expect(within(dialog).getByTestId("avatar-font-serif").className).toContain(
      "font-serif",
    );
    await user.click(within(dialog).getByTestId("avatar-font-mono"));
    expect(tiles(preview)[0]?.dataset.font).toBe("mono");
    expect(dialog).toHaveTextContent("initials · mono · solid tone");
  });

  it("refuses to save an empty monogram (negative)", async () => {
    const { user, dialog } = await openEditor();
    await user.clear(within(dialog).getByTestId("avatar-letters"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-noLetters")).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

describe("Tone", () => {
  it("offers solid, soft and line as the draft itself in each tone", async () => {
    const { user, dialog, preview } = await openEditor();
    const tones = within(dialog).getByRole("group", { name: "Tone" });
    const swatches = within(tones).getAllByRole("button");
    expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Solid",
      "Soft",
      "Line",
    ]);
    expect(
      swatches.map(
        (s) => s.querySelector<HTMLElement>("[data-avatar]")?.dataset.tone,
      ),
    ).toEqual(["solid", "soft", "line"]);
    for (const s of swatches)
      expect(s.querySelector<HTMLElement>("[data-avatar]")?.textContent).toBe(
        "MB",
      );

    await user.click(within(dialog).getByTestId("avatar-tone-soft"));
    expect(tiles(preview)[0]?.dataset.tone).toBe("soft");
  });

  it("is not offered for a photo, which carries its own colour (negative)", async () => {
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByTestId("avatar-kind-photo"));
    expect(within(dialog).queryByRole("group", { name: "Tone" })).toBeNull();
  });
});

describe("Photo", () => {
  it("takes an https link and previews it as the image", async () => {
    const { user, dialog, preview } = await openEditor();
    await user.click(within(dialog).getByTestId("avatar-kind-photo"));
    await user.type(
      within(dialog).getByTestId("avatar-url"),
      "https://cdn.example/marcus.png",
    );
    expect(tiles(preview)[0]?.dataset.avatar).toBe("image");
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledWith("acme", {
      avatarUrl: "https://cdn.example/marcus.png",
    });
  });

  it("refuses to save without a link, or with one that is not https (negative)", async () => {
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByTestId("avatar-kind-photo"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-noPhoto")).toBeTruthy();
    await user.type(
      within(dialog).getByTestId("avatar-url"),
      "http://x.example/a.png",
    );
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-noPhoto")).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

describe("Save", () => {
  it("keeps an in-flight save across reopen without closing the new editor", async () => {
    let finish: ((result: unknown) => void) | undefined;
    updateProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openEditor();
    await user.click(screen.getByTestId("avatar-save"));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("avatar-dialog")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "open avatar" }));
    await screen.findByTestId("avatar-dialog");
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    finish?.({
      ok: true,
      value: { displayName: "Marcus Bell", avatarUrl: "avatar:v1:{}" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("avatar-save")).not.toBeDisabled(),
    );
    expect(screen.getByTestId("avatar-dialog")).toBeTruthy();
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledTimes(2);
    finish?.({
      ok: true,
      value: { displayName: "Marcus Bell", avatarUrl: "avatar:v1:{}" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("avatar-dialog")).toBeNull();
    });
  });

  it("writes the spec string alone, refreshes the shell and returns to Account", async () => {
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByTestId("avatar-kind-icon"));
    await user.click(within(dialog).getByTestId("avatar-icon-satellite"));
    await user.click(within(dialog).getByTestId("avatar-tone-soft"));
    await user.click(screen.getByTestId("avatar-save"));

    expect(updateProfile).toHaveBeenCalledWith("acme", {
      avatarUrl: 'avatar:v1:{"kind":"icon","icon":"satellite","tone":"soft"}',
    });
    expect(await screen.findByTestId("which")).toHaveTextContent("account");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("avatar-dialog")).toBeNull();
  });

  // auth.users.display_name is nullable and the editor has no name field, so
  // it used to send "" for a person who has never set one, which
  // update_profile's schema refuses, so their avatar could never be saved at
  // all. The save carries the avatar alone now.
  it("saves for a person who has no display name", async () => {
    const { user, dialog } = await openEditor({ name: null });
    await user.click(within(dialog).getByTestId("avatar-kind-icon"));
    await user.click(within(dialog).getByTestId("avatar-icon-satellite"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile.mock.calls[0]?.[1]).not.toHaveProperty("displayName");
    expect(await screen.findByTestId("which")).toHaveTextContent("account");
  });

  it("stores a monogram upper-cased, in its typeface and tone", async () => {
    const { user, dialog } = await openEditor();
    const letters = within(dialog).getByTestId("avatar-letters");
    await user.clear(letters);
    await user.type(letters, "mb");
    await user.click(within(dialog).getByTestId("avatar-font-serif"));
    await user.click(within(dialog).getByTestId("avatar-tone-line"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledWith("acme", {
      avatarUrl:
        'avatar:v1:{"kind":"initials","text":"MB","font":"serif","tone":"line"}',
    });
  });

  it("reads a refusal back and stays open (negative)", async () => {
    updateProfile.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const { user } = await openEditor();
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-denied")).toBeTruthy();
    expect(screen.getByTestId("avatar-dialog")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { dialog } = await openEditor();
    await expectNoAxe(dialog);
  });
});

describe("removing an avatar", () => {
  it("clears a saved avatar even when the replacement draft is invalid", async () => {
    const { user } = await openEditor({
      avatarUrl: "https://example.com/avatar.png",
    });
    await user.clear(screen.getByTestId("avatar-url"));
    await user.click(screen.getByTestId("avatar-remove"));
    expect(updateProfile).toHaveBeenCalledWith(shellData().org.slug, {
      avatarUrl: "",
    });
    await waitFor(() => {
      expect(screen.getByTestId("which")).toHaveTextContent("account");
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("serializes removal with other avatar saves", async () => {
    let finish: ((value: unknown) => void) | undefined;
    updateProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openEditor({
      avatarUrl: "https://example.com/avatar.png",
    });
    await user.click(screen.getByTestId("avatar-remove"));
    expect(screen.getByTestId("avatar-remove")).toBeDisabled();
    await user.click(screen.getByTestId("avatar-save"));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    finish?.({ ok: false, reason: "denied" });
    await waitFor(() => {
      expect(screen.getByTestId("avatar-remove")).toBeEnabled();
    });
  });

  it("keeps a refused removal available for retry", async () => {
    updateProfile.mockResolvedValue({ ok: false, reason: "denied" });
    const { user } = await openEditor({
      avatarUrl: "https://example.com/avatar.png",
    });
    await user.click(screen.getByTestId("avatar-remove"));
    expect(await screen.findByTestId("avatar-denied")).toBeVisible();
    expect(screen.getByTestId("avatar-remove")).toBeEnabled();
    expect(screen.getByTestId("which")).toHaveTextContent("avatar");
  });

  it("has no remove control when the account already uses default initials", async () => {
    await openEditor({ avatarUrl: null });
    expect(screen.queryByTestId("avatar-remove")).not.toBeInTheDocument();
  });
});

it.each([false, true])(
  "reconciles a reopened avatar editor after the pending save, newer edit=%s",
  async (newerEdit) => {
    let finish: ((result: unknown) => void) | undefined;
    updateProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openEditor();
    await user.click(screen.getByTestId("avatar-kind-photo"));
    await user.type(
      screen.getByTestId("avatar-url"),
      "https://cdn.example/saved.png",
    );
    await user.click(screen.getByTestId("avatar-save"));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "open avatar" }));
    if (newerEdit) {
      await user.clear(screen.getByTestId("avatar-letters"));
      await user.type(screen.getByTestId("avatar-letters"), "NEW");
    }
    finish?.({
      ok: true,
      value: {
        displayName: "Marcus Bell",
        avatarUrl: "https://cdn.example/saved.png",
      },
    });
    await waitFor(() => {
      expect(accountOperations.isPending(shellData().viewer.id, "avatar")).toBe(
        false,
      );
    });
    if (newerEdit)
      expect(screen.getByTestId("avatar-letters")).toHaveValue("NEW");
    else
      expect(await screen.findByTestId("avatar-url")).toHaveValue(
        "https://cdn.example/saved.png",
      );
    expect(screen.getByTestId("which")).toHaveTextContent("avatar");
  },
);
