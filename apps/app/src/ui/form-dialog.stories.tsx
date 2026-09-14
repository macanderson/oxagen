import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { FormDialog, type FormDialogAction, FormField } from "./form-dialog";

// Storybook has no server; these actions stand in for a server action.
const succeed: FormDialogAction = async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { ok: true };
};

const requireReason: FormDialogAction = async (_prev, form) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reason = form.get("reason");
  return typeof reason === "string" && reason.trim()
    ? { ok: true }
    : { ok: false, field: "reason", code: "deny_requires_reason" };
};

const fail: FormDialogAction = () =>
  Promise.resolve({ ok: false, code: "approval_expired" });

const meta = {
  title: "Mission Control/FormDialog",
  component: FormDialog,
  tags: ["autodocs"],
  args: {
    triggerLabel: "Deny",
    title: "Deny this call",
    description: "The agent sees your reason on its next step.",
    submitLabel: "Deny call",
    action: succeed,
    errorMessages: { deny_requires_reason: "Say why you denied it." },
    hiddenFields: { approvalId: "apr_01K5RT" },
    children: (
      <>
        <FormField
          name="reason"
          label="Reason"
          description="Required to deny."
          multiline
        />
        <FormField name="ticket" label="Ticket" placeholder="LIN-123" />
      </>
    ),
  },
} satisfies Meta<typeof FormDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Submits: Story = {};

export const FieldError: Story = { args: { action: requireReason } };

export const FormError: Story = {
  args: { action: fail, triggerVariant: "primary" },
};
