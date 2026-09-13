// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormDialog,
  type FormDialogAction,
  type FormDialogState,
  FormField,
} from "./form-dialog";
import { renderWithIntl } from "./testing/render-with-intl";

afterEach(() => {
  cleanup();
});

function renderDialog(
  action: FormDialogAction,
  errorMessages?: Record<string, string>,
) {
  return renderWithIntl(
    <FormDialog
      triggerLabel="Deny"
      title="Deny this call"
      description="The agent sees the reason."
      submitLabel="Deny call"
      action={action}
      {...(errorMessages ? { errorMessages } : {})}
      hiddenFields={{ approvalId: "apr_01K5RT", decision: "denied" }}
    >
      <FormField
        name="reason"
        label="Reason"
        description="Required to deny."
        multiline
        required
      />
      <FormField name="ticket" label="Ticket" placeholder="LIN-123" />
    </FormDialog>,
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Deny" }));
  return screen.findByRole("dialog", { name: "Deny this call" });
}

describe("<FormDialog>", () => {
  it("submits the typed and hidden fields to the action and closes on success", async () => {
    const user = userEvent.setup();
    const action = vi.fn<FormDialogAction>().mockResolvedValue({ ok: true });
    renderDialog(action);
    const dialog = await open(user);
    expect(dialog).toHaveAccessibleDescription("The agent sees the reason.");

    await user.type(
      screen.getByRole("textbox", { name: "Reason" }),
      "Outside the mandate",
    );
    await user.click(screen.getByRole("button", { name: "Deny call" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(action).toHaveBeenCalledTimes(1);
    const [prev, form] = action.mock.calls[0] ?? [];
    expect(prev).toBeNull();
    expect(Object.fromEntries(form as FormData)).toEqual({
      approvalId: "apr_01K5RT",
      decision: "denied",
      reason: "Outside the mandate",
      ticket: "",
    });
  });

  it("puts a field error under its field, keeps the typed value, and stays open", async () => {
    const user = userEvent.setup();
    const action = vi
      .fn<FormDialogAction>()
      .mockResolvedValue({
        ok: false,
        field: "reason",
        code: "deny_requires_reason",
      });
    renderDialog(action, { deny_requires_reason: "Say why you denied it." });
    await open(user);
    await user.type(screen.getByRole("textbox", { name: "Ticket" }), "LIN-9");
    await user.click(screen.getByRole("button", { name: "Deny call" }));

    const reason = await screen.findByRole("textbox", { name: "Reason" });
    await waitFor(() => {
      expect(reason).toHaveAttribute("aria-invalid", "true");
    });
    expect(reason).toHaveAccessibleDescription(
      "Required to deny. Say why you denied it.",
    );
    expect(screen.getByRole("textbox", { name: "Ticket" })).toHaveValue(
      "LIN-9",
    );
    expect(screen.getByRole("textbox", { name: "Ticket" })).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a form-level error with a generic sentence for an unmapped code", async () => {
    const user = userEvent.setup();
    renderDialog(
      vi
        .fn<FormDialogAction>()
        .mockResolvedValue({ ok: false, code: "approval_expired" }),
    );
    await open(user);
    await user.click(screen.getByRole("button", { name: "Deny call" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not work (approval_expired). Nothing was changed.",
    );
  });

  it("shows the pending label and disables submit while the action runs", async () => {
    const user = userEvent.setup();
    let resolve: (value: FormDialogState) => void = () => undefined;
    const action = vi.fn<FormDialogAction>(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    renderDialog(action);
    await open(user);
    await user.click(screen.getByRole("button", { name: "Deny call" }));
    const pending = await screen.findByRole("button", { name: "Working…" });
    expect(pending).toBeDisabled();
    resolve({ ok: true });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("starts a fresh form when reopened after an error", async () => {
    const user = userEvent.setup();
    renderDialog(
      vi
        .fn<FormDialogAction>()
        .mockResolvedValue({ ok: false, code: "approval_expired" }),
    );
    await open(user);
    await user.click(screen.getByRole("button", { name: "Deny call" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await open(user);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("<FormField>", () => {
  it("renders a plain labelled input outside a dialog", () => {
    renderWithIntl(
      <FormField
        name="name"
        label="Name"
        type="email"
        defaultValue="a@b.co"
        autoComplete="email"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("a@b.co");
    expect(input).toHaveAttribute("type", "email");
    expect(input).not.toHaveAttribute("aria-describedby");
  });
});
