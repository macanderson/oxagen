"use client";

// <FormDialog>: a Base UI dialog around a form whose submit is a server action
// run through useActionState. The action returns `{ ok: true }` to close the
// dialog, or `{ ok: false, code, field? }`: a `field` puts the message under
// that <FormField> (aria-invalid + aria-describedby), no field shows it above
// the form. Error codes resolve through `errorMessages`, already translated by
// the page, with a generic sentence as the fallback. The fallback claims no
// outcome: a write can commit before its output parse or a timeout fails, so
// only a page that knows the write was rejected before dispatch (validation,
// denied) may say "nothing was changed", in its own `errorMessages`. Typed
// values survive a failed submit; reopening the dialog starts a fresh form.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  createContext,
  useActionState,
  use,
  useId,
  useState,
} from "react";
import { cx } from "./cx";
import {
  DialogClose,
  DialogPanel,
  DialogRoot,
  DialogTrigger,
} from "./dialog-shell";

export type FormDialogState =
  | { ok: true }
  | { ok: false; code: string; field?: string }
  | null;

export type FormDialogAction = (
  prev: FormDialogState,
  form: FormData,
) => Promise<FormDialogState>;

type FormContextValue = {
  result: FormDialogState;
  values: Readonly<Record<string, string>>;
  messageFor: (code: string) => string;
};

const FormContext = createContext<FormContextValue | null>(null);

const buttonBase =
  "inline-flex h-8 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none";

const TRIGGER_CLASS = {
  primary:
    "border border-button-primary-border bg-button-primary-bg text-button-primary-fg hover:bg-button-primary-hover-bg focus-visible:ring-button-primary-ring",
  outline:
    "border border-button-default-border bg-button-default-bg text-button-default-fg hover:bg-button-default-hover-bg focus-visible:ring-button-default-ring",
} as const;

export type FormDialogProps = {
  /** Already translated. */
  triggerLabel: string;
  triggerVariant?: keyof typeof TRIGGER_CLASS;
  title: string;
  description?: string;
  submitLabel: string;
  action: FormDialogAction;
  /** Error code → translated sentence. */
  errorMessages?: Readonly<Record<string, string>>;
  /** Values the action needs that the person does not type (org, ws, approval id). */
  hiddenFields?: Readonly<Record<string, string>>;
  children: ReactNode;
};

export function FormDialog({
  triggerLabel,
  triggerVariant = "outline",
  title,
  description,
  submitLabel,
  action,
  errorMessages,
  hiddenFields,
  children,
}: FormDialogProps) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (next) setSession((s) => s + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger className={cx(buttonBase, TRIGGER_CLASS[triggerVariant])}>
        {triggerLabel}
      </DialogTrigger>
      <DialogPanel title={title} description={description}>
        <FormBody
          key={session}
          action={action}
          submitLabel={submitLabel}
          errorMessages={errorMessages}
          hiddenFields={hiddenFields}
          onDone={() => {
            setOpen(false);
          }}
        >
          {children}
        </FormBody>
      </DialogPanel>
    </DialogRoot>
  );
}

type Submitted = { result: FormDialogState; values: Record<string, string> };

function FormBody({
  action,
  submitLabel,
  errorMessages,
  hiddenFields,
  onDone,
  children,
}: {
  action: FormDialogAction;
  submitLabel: string;
  errorMessages: Readonly<Record<string, string>> | undefined;
  hiddenFields: Readonly<Record<string, string>> | undefined;
  onDone: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("ui.formDialog");
  const [submitted, formAction, pending] = useActionState<Submitted, FormData>(
    async (prev, form) => {
      const values: Record<string, string> = {};
      for (const [key, value] of form.entries())
        if (typeof value === "string") values[key] = value;
      const result = await action(prev.result, form);
      if (result?.ok) onDone();
      return { result, values };
    },
    { result: null, values: {} },
  );
  const messageFor = (code: string) =>
    errorMessages?.[code] ?? t("error", { code });
  const { result } = submitted;
  const formError =
    result && !result.ok && !result.field ? messageFor(result.code) : null;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}
      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-error/50 bg-error/10 px-3 py-2 text-sm text-foreground"
        >
          {formError}
        </p>
      ) : null}
      <FormContext value={{ result, values: submitted.values, messageFor }}>
        <div className="flex flex-col gap-3">{children}</div>
      </FormContext>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose className={cx(buttonBase, TRIGGER_CLASS.outline)}>
          {t("cancel")}
        </DialogClose>
        <button
          type="submit"
          disabled={pending}
          aria-disabled={pending}
          className={cx(
            buttonBase,
            TRIGGER_CLASS.primary,
            "disabled:border-transparent disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
          )}
        >
          {pending ? t("pending") : submitLabel}
        </button>
      </div>
    </form>
  );
}

export type FormFieldProps = {
  name: string;
  /** Already translated. */
  label: string;
  description?: string;
  multiline?: boolean;
  type?: "text" | "email" | "number" | "url";
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
};

const fieldClass =
  "w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm text-input-fg placeholder:text-input-placeholder hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-ring aria-[invalid=true]:border-input-invalid-border aria-[invalid=true]:ring-input-invalid-ring";

/** One labelled input inside a <FormDialog>, wired to the action's field errors. */
export function FormField({
  name,
  label,
  description,
  multiline = false,
  type = "text",
  required,
  defaultValue,
  placeholder,
  autoComplete,
  maxLength,
}: FormFieldProps) {
  const form = use(FormContext);
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const result = form?.result ?? null;
  const error =
    result && !result.ok && result.field === name && form
      ? form.messageFor(result.code)
      : null;
  const describedBy = [
    description ? descriptionId : null,
    error ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    name,
    required,
    placeholder,
    maxLength,
    defaultValue: form?.values[name] ?? defaultValue,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
    className: fieldClass,
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {multiline ? (
        <textarea {...shared} rows={4} />
      ) : (
        <input {...shared} type={type} autoComplete={autoComplete} />
      )}
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
