"use client";
// Set a budget (mockup `budget`, #2962): one scope's spend ceiling through
// set_spend_budget. The contract carries the organization's ceiling or this
// workspace's own, monthly or over a rolling window of days, enforced or kept
// and not enforced; the mockup's agent and operator scopes, per-run and daily
// periods and soft mode have no contract field and are not offered. The
// handler decides who may set a ceiling, so a refusal renders as the denied
// alert. A saved ceiling lands on the Budgets tab, rendered again on the server.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { setBudgetAction } from "./actions";
import {
  BudgetForm,
  type BudgetFieldErrors,
  type BudgetFormValues,
  budgetFieldErrors,
} from "./forms";
import type { SpendAt } from "./view";

const INITIAL: BudgetFormValues = {
  scope: "workspace",
  period: "monthly",
  windowDays: "",
  limit: "",
  enabled: true,
};

function Select({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <select
        id={id}
        name={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={inputBase}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function BudgetDialog({
  at,
  placement = "header",
}: {
  at: SpendAt;
  /**
   * The header's opener is the screen's one gold action; the Budgets panel's
   * copy of it is a plain button, so the screen keeps exactly one.
   */
  placement?: "header" | "panel";
}) {
  const t = useTranslations("spend");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<BudgetFormValues>(INITIAL);
  const [errors, setErrors] = useState<BudgetFieldErrors>({});
  const [alert, setAlert] = useState<"denied" | "failed" | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    const parsed = BudgetForm.safeParse(values);
    if (!parsed.success) {
      setErrors(budgetFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await setBudgetAction(at, values);
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.spend(at.org, at.ws, { tab: "budgets" }));
        return;
      }
      const fields =
        result.reason === "invalid"
          ? budgetFieldErrors([{ path: (result.field ?? "").split(".") }])
          : {};
      setErrors(fields);
      if (Object.keys(fields).length === 0)
        setAlert(result.reason === "denied" ? "denied" : "failed");
    } catch {
      setAlert("failed");
    } finally {
      setPending(false);
    }
  }

  const message = (field: keyof BudgetFieldErrors) => {
    const key = errors[field];
    return key ? t(`budgetDialog.errors.${key}`) : undefined;
  };

  return (
    <>
      <button
        type="button"
        data-placement={placement}
        className={placement === "header" ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("actions.setBudget")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("budgetDialog.title")}
        testId="spend-budget-dialog"
      >
        <form
          noValidate
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-3"
        >
          {alert ? (
            <FormAlert>{t(`budgetDialog.alert.${alert}`)}</FormAlert>
          ) : null}
          <Select
            id="budget-scope"
            label={t("budgetDialog.scope")}
            value={values.scope}
            options={[
              { value: "workspace", label: t("budgets.scope.workspace") },
              { value: "org", label: t("budgets.scope.org") },
            ]}
            onChange={(scope) => {
              setValues((prev) => ({
                ...prev,
                scope: scope === "org" ? "org" : "workspace",
              }));
            }}
          />
          <Select
            id="budget-period"
            label={t("budgetDialog.period")}
            value={values.period}
            options={[
              { value: "monthly", label: t("budgets.monthly") },
              { value: "rolling", label: t("budgetDialog.rolling") },
            ]}
            onChange={(period) => {
              setValues((prev) => ({
                ...prev,
                period: period === "rolling" ? "rolling" : "monthly",
              }));
            }}
          />
          {values.period === "rolling" ? (
            <Field
              id="budget-window-days"
              name="windowDays"
              label={t("budgetDialog.windowDays")}
              inputMode="numeric"
              value={values.windowDays}
              error={message("windowDays")}
              onChange={(event) => {
                setValues((prev) => ({
                  ...prev,
                  windowDays: event.target.value,
                }));
              }}
            />
          ) : null}
          <Field
            id="budget-limit"
            name="limit"
            label={t("budgetDialog.limit")}
            hint={t("budgetDialog.limitHint")}
            inputMode="decimal"
            value={values.limit}
            error={message("limit")}
            onChange={(event) => {
              setValues((prev) => ({ ...prev, limit: event.target.value }));
            }}
          />
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="enabled"
              className="mt-0.5 size-4"
              checked={values.enabled}
              onChange={(event) => {
                setValues((prev) => ({
                  ...prev,
                  enabled: event.target.checked,
                }));
              }}
            />
            <span>{t("budgetDialog.enabled")}</span>
          </label>
          <SubmitButton
            pending={pending}
            label={t("budgetDialog.submit")}
            pendingLabel={t("budgetDialog.pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
