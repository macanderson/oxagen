"use client";
// Statements (ADR-158): download the organization's billing statement for a
// week, month, quarter, year or custom period, as CSV (every billed governed
// action, with the summary above it) or as a printable HTML document.
//
// The download is built by export_billing_statement. A CSV longer than one
// page arrives in pages the browser asks for in turn with the cursor each
// page returns, and joins in order; past MAX_PAGES the file is saved as far
// as it got and the section says how to get the rest. Who may download is
// the handler's decision (org Owner, Admin or Billing); a viewer whose role
// the page already knows cannot pass it is told so instead of being handed a
// form that would be refused.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert } from "@/ui/form-feedback";
import { exportBillingStatementAction } from "./statement-actions";
import {
  STATEMENT_KINDS,
  type StatementFieldError,
  type StatementForm,
  type StatementKind,
  statementPeriodInput,
} from "./statement-period";
import { Section } from "./section";

/** CSV pages the browser joins before it stops: 200,000 rows at 10,000 a page. */
export const MAX_PAGES = 20;

type Format = "csv" | "html";

type Outcome =
  | { kind: "idle" }
  | { kind: "pending"; format: Format; rows: number }
  | { kind: "saved"; filename: string }
  | { kind: "partial"; filename: string; rows: number }
  | { kind: "failed"; code: "denied" | "invalid" | "unavailable" };

const MEDIA: Record<Format, string> = { csv: "text/csv", html: "text/html" };

function save(filename: string, parts: string[], format: Format) {
  const url = URL.createObjectURL(
    new Blob(parts, { type: `${MEDIA[format]};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function Statements({
  org,
  today,
  allowed,
}: {
  org: string;
  /** Today in UTC, YYYY-MM-DD: the default day and the latest allowed. */
  today: string;
  /** The viewer's organization role is Owner, Admin or Billing. */
  allowed: boolean;
}) {
  const t = useTranslations("billing.statements");
  const id = useId();
  const [form, setForm] = useState<StatementForm>({
    kind: "month",
    anchor: today,
    firstDay: "",
    lastDay: today,
  });
  const [fieldError, setFieldError] = useState<StatementFieldError | null>(
    null,
  );
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const pending = outcome.kind === "pending";

  if (!allowed) {
    return (
      <Section id="billing-statements" title={t("title")}>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <p className="text-sm text-foreground" data-testid="statements-denied">
          {t("roleRequired")}
        </p>
      </Section>
    );
  }

  const errorFor = (field: StatementFieldError["field"]) =>
    fieldError?.field === field ? t(`errors.${fieldError.code}`) : undefined;

  async function download(format: Format) {
    if (pending) return;
    const checked = statementPeriodInput(form, today);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    setOutcome({ kind: "pending", format, rows: 0 });
    const parts: string[] = [];
    let cursor: string | null = null;
    let rows = 0;
    let filename = "";
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await exportBillingStatementAction(
          org,
          form,
          today,
          format,
          cursor,
        );
        if (!result.ok) {
          if (
            result.reason === "invalid" &&
            (result.field === "anchor" ||
              result.field === "firstDay" ||
              result.field === "lastDay")
          ) {
            setFieldError({
              field: result.field,
              code: result.code as StatementFieldError["code"],
            });
            setOutcome({ kind: "idle" });
            return;
          }
          setOutcome({
            kind: "failed",
            code:
              result.reason === "denied"
                ? "denied"
                : result.reason === "invalid"
                  ? "invalid"
                  : "unavailable",
          });
          return;
        }
        filename = result.value.filename;
        parts.push(result.value.content);
        rows += result.value.lines;
        cursor = result.value.nextCursor;
        if (cursor === null) break;
        setOutcome({ kind: "pending", format, rows });
      }
    } catch {
      setOutcome({ kind: "failed", code: "unavailable" });
      return;
    }
    save(filename, parts, format);
    setOutcome(
      cursor === null
        ? { kind: "saved", filename }
        : { kind: "partial", filename, rows },
    );
  }

  const set = (patch: Partial<StatementForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setFieldError(null);
  };

  return (
    <Section id="billing-statements" title={t("title")}>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {outcome.kind === "failed" ? (
        <FormAlert testId="statements-failed">
          {t(`failure.${outcome.code}`)}
        </FormAlert>
      ) : null}
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void download("csv");
        }}
      >
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium text-foreground">
            {t("period")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {STATEMENT_KINDS.map((kind: StatementKind) => (
              <label
                key={kind}
                data-touch-target=""
                className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
              >
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={kind}
                  checked={form.kind === kind}
                  disabled={pending}
                  onChange={() => {
                    set({ kind });
                  }}
                />
                {t(`kinds.${kind}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {form.kind === "custom" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${id}-first`}
              name="firstDay"
              type="date"
              max={today}
              label={t("firstDay")}
              value={form.firstDay}
              disabled={pending}
              error={errorFor("firstDay")}
              onChange={(event) => {
                set({ firstDay: event.target.value });
              }}
            />
            <Field
              id={`${id}-last`}
              name="lastDay"
              type="date"
              label={t("lastDay")}
              hint={t("customHint")}
              value={form.lastDay}
              disabled={pending}
              error={errorFor("lastDay")}
              onChange={(event) => {
                set({ lastDay: event.target.value });
              }}
            />
          </div>
        ) : (
          <Field
            id={`${id}-anchor`}
            name="anchor"
            type="date"
            max={today}
            label={t("anchor")}
            hint={t(`anchorHint.${form.kind}`)}
            value={form.anchor}
            disabled={pending}
            error={errorFor("anchor")}
            onChange={(event) => {
              set({ anchor: event.target.value });
            }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={buttonSecondary}
            disabled={pending}
            aria-disabled={pending}
          >
            {pending && outcome.format === "csv"
              ? t("preparing.csv")
              : t("download.csv")}
          </button>
          <button
            type="button"
            className={buttonSecondary}
            disabled={pending}
            aria-disabled={pending}
            onClick={() => {
              void download("html");
            }}
          >
            {pending && outcome.format === "html"
              ? t("preparing.html")
              : t("download.html")}
          </button>
        </div>
      </form>
      {/* A live region, present before anything is written into it so the
          change is announced; not role="status", which the page's checkout
          banner owns. */}
      <p
        aria-live="polite"
        data-testid="statements-progress"
        className="text-sm text-foreground"
      >
        {outcome.kind === "pending" && outcome.rows > 0
          ? t("progress", { rows: outcome.rows })
          : null}
        {outcome.kind === "saved" ? (
          <>
            {t("saved")} <span className={mono}>{outcome.filename}</span>
          </>
        ) : null}
        {outcome.kind === "partial"
          ? t("partial", { rows: outcome.rows })
          : null}
      </p>
    </Section>
  );
}
