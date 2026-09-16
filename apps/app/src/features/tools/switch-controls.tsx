"use client";
// The switch dialog (mockup `tools.md`: "shows its blast radius before
// confirming"). Two shapes, one component:
//
//   - opened from the page header with no switch, it names the level and the
//     target to deny, so a level with no row yet gets one;
//   - opened on a card, it flips that card's switch the other way, with the
//     level and target fixed.
//
// Either way the dialog states the blast radius, that the flip takes effect at
// the next call boundary through the deny generation, and that it is recorded
// as a security event — before the confirming button, never after.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import {
  type KillSwitch,
  type KillSwitchBoard,
  KillSwitchKind,
  KILL_SWITCH_KINDS,
} from "@/data/contracts/tools";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { flipKillSwitch } from "./actions";
import { type ToolsAt, textValue } from "./view";

export function FlipControls({
  at,
  denyGeneration,
  existing,
  tone,
}: {
  at: ToolsAt;
  denyGeneration: KillSwitchBoard["denyGeneration"];
  /** The card's switch, or null when the header opened the dialog. */
  existing: KillSwitch | null;
  tone: "flip" | "clear";
}) {
  const t = useTranslations("tools.switches.dialog");
  const kinds = useTranslations("tools.switches.kinds");
  const radius = useTranslations("tools.switches.blastRadius");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [kind, setKind] = useState<KillSwitch["target"]["kind"]>(
    existing?.target.kind ?? "class",
  );

  /** A card flips the other way; the header dialog always denies. */
  const turningOn = existing === null ? true : !existing.on;
  const generation =
    existing?.scope === "workspace"
      ? denyGeneration.workspace
      : denyGeneration.org;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const rawKind = textValue(form, "kind");
    const parsedKind = KillSwitchKind.safeParse(rawKind);
    setPending(true);
    setFailure(null);
    try {
      const result = await flipKillSwitch(at.org, at.ws, {
        kind: parsedKind.success ? parsedKind.data : kind,
        target: existing?.target.ref ?? textValue(form, "target"),
        on: turningOn,
        reason: textValue(form, "reason"),
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.tools(at.org, at.ws, { tab: "switches" }));
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
          existing === null ? "tools-flip-open" : `tools-flip-${existing.id}`
        }
        className={tone === "flip" ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {existing === null
          ? t("openHeader")
          : turningOn
            ? t("openDeny")
            : t("openAllow")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={turningOn ? t("titleDeny") : t("titleAllow")}
        testId="tools-flip-dialog"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {existing === null ? (
            <>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor="kind"
                  className="text-sm font-medium text-foreground"
                >
                  {t("kind")}
                </label>
                <select
                  id="kind"
                  name="kind"
                  value={kind}
                  onChange={(event) => {
                    const parsed = KillSwitchKind.safeParse(
                      event.currentTarget.value,
                    );
                    if (parsed.success) setKind(parsed.data);
                  }}
                  className={inputBase}
                >
                  {KILL_SWITCH_KINDS.map((option) => (
                    <option key={option} value={option}>
                      {kinds(option)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor="target"
                  className="text-sm font-medium text-foreground"
                >
                  {t("target")}
                </label>
                <input
                  id="target"
                  name="target"
                  required
                  className={`${inputBase} ${mono}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t(`targetHint.${kind}`)}
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {kinds(existing.target.kind)} ·{" "}
              <span className={`${mono} break-all`}>{existing.target.ref}</span>
            </p>
          )}

          <div
            data-testid="tools-flip-blast-radius"
            className={`rounded-lg border px-3 py-2.5 text-sm ${
              turningOn
                ? "border-destructive/45 bg-destructive/10"
                : "border-border bg-muted"
            }`}
          >
            <p className="font-medium text-foreground">
              {turningOn ? t("blastTitle") : t("restoreTitle")}
            </p>
            <p className="mt-1 text-muted-foreground">{radius(kind)}</p>
            <p className="mt-1 text-muted-foreground">
              {turningOn ? t("blastBody") : t("restoreBody")}
            </p>
          </div>
          {turningOn && kind === "class" ? (
            <p className="text-xs text-muted-foreground">{t("classNote")}</p>
          ) : null}
          {turningOn && kind === "connection" ? (
            <p className="text-xs text-muted-foreground">
              {t("connectionNote")}
            </p>
          ) : null}

          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="reason"
              className="text-sm font-medium text-foreground"
            >
              {t("reason")}
            </label>
            <textarea
              id="reason"
              name="reason"
              rows={2}
              required
              maxLength={500}
              className={inputBase}
            />
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t("takesEffect")}</dt>
            <dd className="text-foreground">
              {t("takesEffectValue", {
                from: generation,
                to: generation + 1,
              })}
            </dd>
            <dt className="text-muted-foreground">{t("recordedAs")}</dt>
            <dd className="text-foreground">{t("recordedAsValue")}</dd>
          </dl>
          {failure === null ? null : (
            <FormAlert testId="tools-flip-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={turningOn ? t("confirmDeny") : t("confirmAllow")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
