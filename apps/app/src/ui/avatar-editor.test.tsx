// @vitest-environment jsdom
// The one avatar editor over each of the four records that carry an avatar: a
// person, an agent, a workspace, and an organization. The subject sets the
// tile's shape, the title, the note, and the refusal's words; the draft, the
// five tones, and the stored form are the same for all four. The gold tones
// are the brand gold and its deep shade, offered beside solid, soft, and line.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
import {
  AvatarEditorDialog,
  type AvatarSaveResult,
  type AvatarSubject,
  avatarSaveResult,
} from "./avatar-editor";

const SUBJECTS: readonly AvatarSubject[] = [
  "user",
  "agent",
  "workspace",
  "organization",
];

const save = vi.fn<(value: string) => Promise<AvatarSaveResult>>();
const onSaved = vi.fn();

const TITLE: Record<AvatarSubject, string> = {
  user: "Your avatar",
  agent: "Avatar for Perf watch",
  workspace: "Avatar for Perf watch",
  organization: "Avatar for Perf watch",
};

const NOTE: Record<AvatarSubject, string> = {
  user: "Saved with update_profile, like any change to your account.",
  agent: "Part of the agent's definition, so a change rides a pull request.",
  workspace:
    "Saved with update_workspace_settings on the workspace's record.",
  organization:
    "Saved with update_org_settings on the organization's record.",
};

const DENIED: Record<AvatarSubject, string> = {
  user: "You do not have permission to change this profile.",
  agent: "You do not have permission to change this agent.",
  workspace: "You do not have permission to change this workspace.",
  organization: "You do not have permission to change this organization.",
};

function Harness({
  subject,
  value = null,
}: {
  subject: AvatarSubject;
  value?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        open editor
      </button>
      <AvatarEditorDialog
        subject={subject}
        open={open}
        onOpenChange={setOpen}
        name="Perf watch"
        subtitle="perf-watch"
        value={value}
        save={save}
        onSaved={() => {
          onSaved();
          setOpen(false);
        }}
      />
    </>
  );
}

async function openEditor(subject: AvatarSubject, value?: string | null) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <Harness subject={subject} value={value} />
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open editor" }));
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
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  onSaved.mockReset();
});
afterEach(cleanup);

describe.each(SUBJECTS)("for a %s", (subject) => {
  it("titles the dialog, notes the write, and draws the subject's shape", async () => {
    const { dialog, preview } = await openEditor(subject);
    expect(dialog).toHaveTextContent(TITLE[subject]);
    expect(dialog).toHaveTextContent(NOTE[subject]);
    const shape = subject === "user" ? "person" : "agent";
    expect(preview.dataset.shape).toBe(shape);
    const [big] = tiles(preview);
    expect(big?.className).toContain(
      subject === "user" ? "rounded-full" : "rounded-[27%]",
    );
  });

  it("opens on the initials of the name when nothing is stored", async () => {
    const { dialog, preview } = await openEditor(subject);
    expect(within(dialog).getByTestId("avatar-letters")).toHaveValue("PW");
    expect(tiles(preview)[0]?.textContent).toBe("PW");
  });

  it("saves a gold icon as the spec string and closes", async () => {
    const { user, dialog } = await openEditor(subject);
    await user.click(within(dialog).getByTestId("avatar-kind-icon"));
    await user.click(within(dialog).getByTestId("avatar-icon-radio-tower"));
    await user.click(within(dialog).getByTestId("avatar-tone-gold"));
    await user.click(screen.getByTestId("avatar-save"));
    expect(save).toHaveBeenCalledWith(
      'avatar:v1:{"kind":"icon","icon":"radio-tower","tone":"gold"}',
    );
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("avatar-dialog")).toBeNull();
  });

  it("names the subject when the write is refused, and stays open (negative)", async () => {
    save.mockResolvedValue({ ok: false, reason: "denied" });
    const { user } = await openEditor(subject);
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-denied")).toHaveTextContent(
      DENIED[subject],
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId("avatar-dialog")).toBeTruthy();
  });
});

describe("Tone", () => {
  it("offers solid, soft, line, gold, and dark gold as the draft in each tone", async () => {
    const { dialog } = await openEditor("organization");
    const tones = within(dialog).getByRole("group", { name: "Tone" });
    const swatches = within(tones).getAllByRole("button");
    expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Solid",
      "Soft",
      "Line",
      "Gold",
      "Dark gold",
    ]);
    expect(
      swatches.map(
        (s) => s.querySelector<HTMLElement>("[data-avatar]")?.dataset.tone,
      ),
    ).toEqual(["solid", "soft", "line", "gold", "gold-deep"]);
  });

  it("draws the gold swatches in the brand gold and its deep shade", async () => {
    const { dialog } = await openEditor("workspace");
    const gold = within(dialog)
      .getByTestId("avatar-tone-gold")
      .querySelector<HTMLElement>("[data-avatar]");
    const deep = within(dialog)
      .getByTestId("avatar-tone-gold-deep")
      .querySelector<HTMLElement>("[data-avatar]");
    expect(gold?.className).toContain("bg-gold ");
    expect(gold?.className).toContain("text-on-gold ");
    expect(deep?.className).toContain("bg-gold-deep");
    expect(deep?.className).toContain("text-on-gold-deep");
  });

  it("stores a dark gold monogram", async () => {
    const { user, dialog, preview } = await openEditor("organization");
    await user.click(within(dialog).getByTestId("avatar-tone-gold-deep"));
    expect(tiles(preview)[0]?.dataset.tone).toBe("gold-deep");
    expect(dialog).toHaveTextContent("initials · sans · gold-deep tone");
    await user.click(screen.getByTestId("avatar-save"));
    expect(save).toHaveBeenCalledWith(
      'avatar:v1:{"kind":"initials","text":"PW","font":"sans","tone":"gold-deep"}',
    );
  });

  it("opens on a stored gold avatar", async () => {
    const { dialog } = await openEditor(
      "agent",
      'avatar:v1:{"kind":"icon","icon":"bot","tone":"gold"}',
    );
    expect(within(dialog).getByTestId("avatar-tone-gold")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-icon-bot")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("Save", () => {
  it("sends one write while one is in flight, even across a reopen", async () => {
    let finish: ((result: AvatarSaveResult) => void) | undefined;
    save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await openEditor("workspace");
    await user.click(screen.getByTestId("avatar-save"));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("avatar-dialog")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "open editor" }));
    await screen.findByTestId("avatar-dialog");
    await user.click(screen.getByTestId("avatar-save"));
    expect(save).toHaveBeenCalledTimes(1);
    const status = () =>
      within(screen.getByTestId("avatar-dialog")).getByRole("status");
    expect(status()).toHaveTextContent("Saving");
    finish?.({ ok: true });
    // The first save's editor is gone, so it closes nothing. The reopened one
    // stays, and its Save sends once the first write has landed.
    await waitFor(() => {
      expect(status()).toHaveTextContent("");
    });
    save.mockResolvedValue({ ok: true });
    await user.click(screen.getByTestId("avatar-save"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("clears a stored avatar with an empty string", async () => {
    const { user } = await openEditor(
      "organization",
      "https://cdn.example/acme.png",
    );
    expect(screen.getByTestId("avatar-dialog")).toHaveTextContent(
      "Use the organization's default initials instead.",
    );
    await user.click(screen.getByTestId("avatar-remove"));
    expect(save).toHaveBeenCalledWith("");
  });

  it("offers no remove control when nothing is stored (negative)", async () => {
    await openEditor("workspace");
    expect(screen.queryByTestId("avatar-remove")).toBeNull();
  });

  it("reads a thrown write as a failed save (negative)", async () => {
    save.mockRejectedValue(new Error("network"));
    const { user } = await openEditor("agent");
    await user.click(screen.getByTestId("avatar-save"));
    expect(await screen.findByTestId("avatar-failed")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { dialog } = await openEditor("organization");
    await expectNoAxe(dialog);
  });
});

describe("avatarSaveResult", () => {
  it("keeps invalid and denied, and reads every other refusal as failed", () => {
    expect(avatarSaveResult({ ok: true })).toEqual({ ok: true });
    expect(avatarSaveResult({ ok: false, reason: "invalid" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(avatarSaveResult({ ok: false, reason: "denied" })).toEqual({
      ok: false,
      reason: "denied",
    });
    for (const reason of ["not_found", "conflict", "unavailable", "exhausted"])
      expect(avatarSaveResult({ ok: false, reason })).toEqual({
        ok: false,
        reason: "failed",
      });
  });
});
