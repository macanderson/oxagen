"use client";
// Export report (mockup `spendexport`, #2962): one calendar month's statement
// through export_statement, saved as the CSV the call answers. The statement
// covers this workspace at every level with each line's basis. The mockup's
// signed PDF and emailed delivery wait on the audit-exports lane and a signing
// key (ADR-060 §6), so the dialog offers the CSV alone and says so.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { exportStatementAction } from "./actions";
import { isStatementMonth } from "./forms";
import type { SpendAt } from "./view";

function saveFile({
  filename,
  content,
}: {
  filename: string;
  content: string;
}) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportDialog({ at, month }: { at: SpendAt; month: string }) {
  const t = useTranslations("spend");
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(month);
  const [invalid, setInvalid] = useState(false);
  const [alert, setAlert] = useState<"denied" | "failed" | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    const trimmed = value.trim();
    if (!isStatementMonth(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setPending(true);
    try {
      const result = await exportStatementAction(at, trimmed);
      if (result.ok) {
        saveFile(result.value);
        setOpen(false);
        return;
      }
      if (result.reason === "invalid") setInvalid(true);
      else setAlert(result.reason === "denied" ? "denied" : "failed");
    } catch {
      setAlert("failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("actions.exportReport")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("exportDialog.title")}
        testId="spend-export-dialog"
      >
        <form
          noValidate
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-3"
        >
          {alert ? (
            <FormAlert>{t(`exportDialog.alert.${alert}`)}</FormAlert>
          ) : null}
          <Field
            id="spend-export-month"
            name="month"
            type="month"
            label={t("exportDialog.month")}
            hint={t("exportDialog.monthHint")}
            value={value}
            error={invalid ? t("exportDialog.errors.monthInvalid") : undefined}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          <SubmitButton
            pending={pending}
            label={t("exportDialog.submit")}
            pendingLabel={t("exportDialog.pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
