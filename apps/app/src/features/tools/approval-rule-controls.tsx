"use client";
// The auto-approval writes (MC spec §6.9 part 2, ADR-070; mockup `tools.md`:
// Create rule, Edit, Delete, and the On column). Three controls:
//
//   - `RuleEditor` creates a rule or edits one. The contract replaces the
//     whole set, and the server action splices this rule into the set as it
//     stands at the moment of the write (see `saveApprovalRule`). A rule whose
//     text fields would not write it back as stored is shown but not saved
//     here (`notCarried`).
//   - `RuleToggle` switches one rule on or off. Switching on re-runs the
//     checks the rule was saved under, so it can be refused.
//   - `RuleDelete` removes one, and offers to switch it off instead: an off
//     rule keeps its id, so its counters and every receipt citing it stay
//     readable.
//
// Each one reloads the tab on success and names a refusal where the person
// acted.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useRef, useState } from "react";
import type { ApprovalRule } from "@/data/contracts/tools";
import { chooseToolPatterns } from "@/features/shell/client";
import type { ActionResult } from "@/server/kernel";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { RecordMultiPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  type ApprovalRuleDraft,
  deleteApprovalRule,
  saveApprovalRule,
  setApprovalRuleEnabled,
} from "./actions";
import {
  carriedBy,
  parseMeasureLines,
  splitCommas,
  splitLines,
  textValue,
  type ToolsAt,
  toolsLink,
  weekdayKey,
} from "./view";

/** ISO weekdays, Monday first, as the contract numbers them. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const MINUTE_MS = 60_000;

/** The tab every one of these writes reloads. */
const tab = (at: ToolsAt) => toolsLink(at, { tab: "autoapprovals" });

/** A rule's ceilings as the lines the dialog edits, one `measure = value` each. */
function ceilingLines(rule: ApprovalRule | null): string {
  if (rule === null) return "";
  return Object.entries(rule.maxMeasures)
    .map(([measure, value]) => `${measure} = ${value}`)
    .join("\n");
}

/** A rule's allow lists as lines, one `measure = glob, glob` each. */
function allowLines(rule: ApprovalRule | null): string {
  if (rule === null) return "";
  return Object.entries(rule.allowTargets)
    .map(([measure, globs]) => `${measure} = ${globs.join(", ")}`)
    .join("\n");
}

/**
 * True when saving this rule from the editor would write back something other
 * than what is stored. The tools field is one pattern per line and each allow
 * list is comma-separated, and both a pattern and a glob are free text of up to
 * 256 characters, so a stored value that contains its field's delimiter comes
 * back split: `vendor:*,prod` becomes `vendor:*` and `prod`, and the first
 * admits every vendor target the author never wrote. Such a rule was written
 * over the API or MCP; the dialog shows it and offers no Save, so saving any
 * other field cannot widen it. Measure names and ceilings are bounded to a
 * pattern that has no delimiter in it, so they always round-trip.
 */
function notCarried(rule: ApprovalRule): boolean {
  return (
    !carriedBy(rule.tools, "\n", splitLines) ||
    Object.values(rule.allowTargets).some(
      (globs) => !carriedBy(globs, ", ", splitCommas),
    )
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * The draft the form describes, or the one message that says which part of it
 * could not be read. Values the contract checks (the id's shape, an integer
 * ceiling, a known time zone) are left to it: the kernel refuses them as
 * `invalid` and nothing is written.
 */
function draftOf(
  form: FormData,
  existing: ApprovalRule | null,
  hoursOn: boolean,
):
  | { ok: true; draft: ApprovalRuleDraft }
  | { ok: false; field: "maxMeasures" | "allowTargets" } {
  const ceilings = parseMeasureLines(textValue(form, "maxMeasures"));
  if (ceilings === null) return { ok: false, field: "maxMeasures" };
  const allows = parseMeasureLines(textValue(form, "allowTargets"));
  if (allows === null) return { ok: false, field: "allowTargets" };
  const minutes = textValue(form, "standingMinutes").trim();
  return {
    ok: true,
    draft: {
      id: existing?.slug ?? textValue(form, "id"),
      name: textValue(form, "name"),
      tools: splitLines(textValue(form, "tools")),
      enabled: form.get("enabled") === "on",
      maxMeasures: Object.fromEntries(ceilings),
      allowTargets: Object.fromEntries(
        allows.map(([measure, globs]) => [measure, splitCommas(globs)]),
      ),
      standingWindowMs:
        minutes === "" ? null : Math.round(Number(minutes) * MINUTE_MS),
      businessHours: hoursOn
        ? {
            timezone: textValue(form, "timezone").trim(),
            days: form
              .getAll("days")
              .map(Number)
              .filter((day) => Number.isInteger(day)),
            start: textValue(form, "start"),
            end: textValue(form, "end"),
          }
        : null,
    },
  };
}

/**
 * The rule as the editor received it, in the shape `saveApprovalRule` compares
 * with the set it reads at the moment of the write. The dialog opens on a
 * rendered rule and submits later, so this is the baseline that says whether
 * anyone changed the rule in between; `replaces` cannot say it, because the
 * action builds that from its own read, not from what the author saw.
 */
function renderedDraft(rule: ApprovalRule): ApprovalRuleDraft {
  return {
    id: rule.slug,
    name: rule.name,
    tools: rule.tools,
    enabled: rule.enabled,
    maxMeasures: rule.maxMeasures,
    allowTargets: rule.allowTargets,
    standingWindowMs: rule.standingWindowMs,
    businessHours: rule.businessHours,
  };
}

export function RuleEditor({
  at,
  existing,
}: {
  at: ToolsAt;
  /** The rule to edit, or null when the section header creates one. */
  existing: ApprovalRule | null;
}) {
  const t = useTranslations("tools.autoApprovals.editor");
  const days = useTranslations("tools.autoApprovals.days");
  const failureText = useActionFailure("rules");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hoursOn, setHoursOn] = useState(
    existing !== null && existing.businessHours !== null,
  );
  const renderedRef = useRef<ApprovalRuleDraft | null>(null);
  const creating = existing === null;
  const hours = existing?.businessHours ?? null;
  /** A rule the fields cannot write back as stored: shown, never saved here. */
  const refused = existing !== null && notCarried(existing);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || refused) return;
    const parsed = draftOf(
      new FormData(event.currentTarget),
      existing,
      hoursOn,
    );
    if (!parsed.ok) {
      setFailure(t(`unreadable.${parsed.field}`));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await saveApprovalRule(
        at.org,
        at.ws,
        creating ? "create" : "edit",
        parsed.draft,
        renderedRef.current,
      );
      if (result.ok) {
        setOpen(false);
        navigate.replace(tab(at));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={
          creating ? "rule-create-open" : `rule-edit-${existing.slug}`
        }
        className={creating ? buttonPrimary : buttonSecondary}
        onClick={() => {
          renderedRef.current =
            existing === null ? null : renderedDraft(existing);
          setOpen(true);
        }}
      >
        {creating ? t("openCreate") : t("openEdit")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={creating ? t("titleCreate") : t("titleEdit")}
        testId="rule-editor"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {creating ? (
            <Field id="rule-id" label={t("id")} hint={t("idHint")}>
              <input
                id="rule-id"
                name="id"
                required
                maxLength={128}
                className={`${inputBase} ${mono}`}
              />
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("id")} · <span className={mono}>{existing.slug}</span>
            </p>
          )}
          {refused ? (
            <p data-state="not-carried" className="text-sm text-foreground">
              {t("notCarried")}
            </p>
          ) : null}
          <Field id="rule-name" label={t("name")}>
            <input
              id="rule-name"
              name="name"
              required
              maxLength={200}
              defaultValue={existing?.name ?? ""}
              className={inputBase}
            />
          </Field>
          <Field id="rule-tools" label={t("tools")} hint={t("toolsHint")}>
            {/* One chip per pattern, sent one per line as the textarea it
                replaced sent them, so `splitLines` and `notCarried` still
                read the same field. */}
            <RecordMultiPicker
              id="rule-tools"
              name="tools"
              required
              freeform
              joiner={"\n"}
              load={() => chooseToolPatterns(at.org, at.ws)}
              defaultValue={existing?.tools ?? []}
            />
          </Field>
          <Field
            id="rule-ceilings"
            label={t("maxMeasures")}
            hint={t("maxMeasuresHint")}
          >
            <textarea
              id="rule-ceilings"
              name="maxMeasures"
              rows={2}
              defaultValue={ceilingLines(existing)}
              className={`${inputBase} ${mono}`}
            />
          </Field>
          <Field
            id="rule-allow"
            label={t("allowTargets")}
            hint={t("allowTargetsHint")}
          >
            <textarea
              id="rule-allow"
              name="allowTargets"
              rows={2}
              defaultValue={allowLines(existing)}
              className={`${inputBase} ${mono}`}
            />
          </Field>
          <Field
            id="rule-standing"
            label={t("standingMinutes")}
            hint={t("standingMinutesHint")}
          >
            <input
              id="rule-standing"
              name="standingMinutes"
              type="number"
              min={1}
              max={43_200}
              step={1}
              defaultValue={
                existing === null || existing.standingWindowMs === null
                  ? ""
                  : String(existing.standingWindowMs / MINUTE_MS)
              }
              className={inputBase}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="hoursOn"
              checked={hoursOn}
              onChange={(event) => {
                setHoursOn(event.currentTarget.checked);
              }}
            />
            {t("hoursOn")}
          </label>
          {hoursOn ? (
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium text-foreground">
                {t("hours")}
              </legend>
              <Field
                id="rule-timezone"
                label={t("timezone")}
                hint={t("timezoneHint")}
              >
                <input
                  id="rule-timezone"
                  name="timezone"
                  required
                  maxLength={64}
                  defaultValue={hours?.timezone ?? "UTC"}
                  className={`${inputBase} ${mono}`}
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((day) => (
                  <label
                    key={day}
                    className="flex items-center gap-1.5 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      name="days"
                      value={String(day)}
                      defaultChecked={
                        hours === null ? day <= 5 : hours.days.includes(day)
                      }
                    />
                    {days(weekdayKey(day))}
                  </label>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="rule-start" label={t("start")}>
                  <input
                    id="rule-start"
                    name="start"
                    type="time"
                    required
                    defaultValue={hours?.start ?? "09:00"}
                    className={inputBase}
                  />
                </Field>
                <Field id="rule-end" label={t("end")}>
                  <input
                    id="rule-end"
                    name="end"
                    type="time"
                    required
                    defaultValue={hours?.end ?? "17:00"}
                    className={inputBase}
                  />
                </Field>
              </div>
            </fieldset>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={existing?.enabled ?? true}
            />
            {t("enabled")}
          </label>
          <p className="text-xs text-muted-foreground">{t("checks")}</p>
          {failure === null ? null : (
            <FormAlert testId="rule-editor-failure">{failure}</FormAlert>
          )}
          {refused ? null : (
            <SubmitButton
              pending={pending}
              label={creating ? t("confirmCreate") : t("confirmEdit")}
              pendingLabel={t("pending")}
            />
          )}
        </form>
      </SheetDialog>
    </>
  );
}

export function RuleToggle({ at, rule }: { at: ToolsAt; rule: ApprovalRule }) {
  const t = useTranslations("tools.autoApprovals.toggle");
  // Switching on re-runs the consequence check; switching off asks only for
  // an org Owner or Admin, so a refusal there names that pair.
  const failureOn = useActionFailure("rules");
  const failureOff = useActionFailure();
  const failureText = rule.enabled ? failureOff : failureOn;
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function flip() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await setApprovalRuleEnabled(
        at.org,
        at.ws,
        rule.slug,
        !rule.enabled,
      );
      if (result.ok) {
        navigate.replace(tab(at));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col gap-1.5">
      <button
        type="button"
        data-testid={`rule-toggle-${rule.slug}`}
        aria-busy={pending}
        disabled={pending}
        className={buttonSecondary}
        onClick={() => void flip()}
      >
        {rule.enabled ? t("off") : t("on")}
      </button>
      {failure === null ? null : (
        <FormAlert testId={`rule-toggle-failure-${rule.slug}`}>
          {failure}
        </FormAlert>
      )}
    </span>
  );
}

export function RuleDelete({ at, rule }: { at: ToolsAt; rule: ApprovalRule }) {
  const t = useTranslations("tools.autoApprovals.delete");
  // Neither deleting nor switching off runs the consequence check (either can
  // only send more calls to a person), so a role refusal is the Owner-or-Admin one.
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(write: () => Promise<ActionResult<unknown>>) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) {
        setOpen(false);
        navigate.replace(tab(at));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={`rule-delete-${rule.slug}`}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        testId="rule-delete-dialog"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => deleteApprovalRule(at.org, at.ws, rule.slug));
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-foreground">
            {t("body", { name: rule.name })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("keep", { citation: `policy:${rule.slug}` })}
          </p>
          {rule.enabled ? (
            <button
              type="button"
              data-testid="rule-delete-switch-off"
              disabled={pending}
              className={buttonSecondary}
              onClick={() =>
                void act(() =>
                  setApprovalRuleEnabled(at.org, at.ws, rule.slug, false),
                )
              }
            >
              {t("switchOff")}
            </button>
          ) : null}
          {failure === null ? null : (
            <FormAlert testId="rule-delete-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
