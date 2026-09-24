"use client";
// The switch dialog (mockup `tools.md`: "shows its blast radius before
// confirming"). Two shapes, one component:
//
//   - opened from the page header with no switch, it names the level and the
//     target to deny, so a level with no row yet gets one — except at the two
//     levels whose target is the tenant in view, where it states the target
//     rather than asking for a uuid this page never prints;
//   - opened on a card, it flips that card's switch the other way, with the
//     level and target fixed.
//
// Either way the dialog states the blast radius, that the flip takes effect at
// the next call boundary through the deny generation, and that it is recorded
// as a security event — before the confirming button, never after.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { STARTER_CONSEQUENCE_TAGS } from "@/data/contracts/mandates";
import {
  type KillSwitch,
  type KillSwitchBoard,
  KillSwitchKind,
  KILL_SWITCH_KINDS,
} from "@/data/contracts/tools";
import { chooseSwitchTargets } from "@/features/shell/client";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { type PickerOption, RecordPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { flipKillSwitch } from "./actions";
import {
  SELF_TARGETED_KINDS,
  switchScopeOf,
  type ToolsAt,
  textValue,
} from "./view";

/** The levels whose targets are records `chooseSwitchTargets` reads by public id. */
type LoadedKind = Parameters<typeof chooseSwitchTargets>[2];

function loadsTargets(kind: KillSwitch["target"]["kind"]): kind is LoadedKind {
  return (
    kind === "tool_server" ||
    kind === "tool_version" ||
    kind === "connection" ||
    kind === "agent"
  );
}

/** A class switch names a consequence tag: one of the starter set, or one typed. */
const TAG_OPTIONS: readonly PickerOption[] = STARTER_CONSEQUENCE_TAGS.map(
  (tag) => ({ value: tag, label: tag }),
);

export function FlipControls({
  at,
  denyGeneration,
  existing,
  members,
}: {
  at: ToolsAt;
  denyGeneration: KillSwitchBoard["denyGeneration"];
  /**
   * The card's switch, or null when the section header opened the dialog.
   *
   * This one prop settles everything else: where the control sits (the header
   * or a card), which way the flip goes, and therefore how it is styled — so
   * there is no second prop to disagree with it. The header carries the page's
   * one gold action; gold is identity, never state, so a card's control stays
   * secondary whichever way its switch is pointing.
   */
  existing: KillSwitch | null;
  /**
   * The org's members, to submit an operator switch's target as the `usr_…`
   * public id `set_kill_switch` now resolves (#3147), rather than asking for
   * a uuid this page never prints. Only the header's dialog reads this: a
   * card's target is already fixed to `existing.target.ref`.
   */
  members: readonly { id: string; name: string | null; email: string }[];
}) {
  const t = useTranslations("tools.switches.dialog");
  const kinds = useTranslations("tools.switches.kinds");
  const radius = useTranslations("tools.switches.blastRadius");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The kernel answered `changed: false`: the switch was already that way. */
  const [unchanged, setUnchanged] = useState(false);
  const [kind, setKind] = useState<KillSwitch["target"]["kind"]>(
    existing?.target.kind ?? "class",
  );

  /** A card flips the other way; the header dialog always denies. */
  const turningOn = existing === null ? true : !existing.on;
  /** The header's control, and only the header's, is the page's gold action. */
  const fromHeader = existing === null;
  /**
   * Which counter this flip advances. A card has a record and the record says
   * what scope it was written under; the header has none, so the scope comes
   * from the level chosen — not from the absent record, which would name the
   * organization counter for every level and be wrong for the four written
   * under the workspace.
   */
  const generation = denyGeneration[existing?.scope ?? switchScopeOf(kind)];
  /** At these levels the dialog asks for no target: the viewer supplies it. */
  const selfTargeted = SELF_TARGETED_KINDS.has(kind);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsedKind = KillSwitchKind.safeParse(textValue(form, "kind"));
    // The card carries no level select, so the level is the one its switch was
    // recorded at; the header's select names it.
    const chosen = parsedKind.success ? parsedKind.data : kind;
    setPending(true);
    setFailure(null);
    setUnchanged(false);
    try {
      const result = await flipKillSwitch(at.org, at.ws, {
        kind: chosen,
        // A card always names the target its switch was recorded against —
        // including a workspace switch recorded against another workspace, so
        // clearing it clears that one. Null is the header at a self-targeted
        // level, where the dialog asked for nothing and the viewer answers.
        target:
          existing !== null
            ? existing.target.ref
            : SELF_TARGETED_KINDS.has(chosen)
              ? null
              : textValue(form, "target"),
        on: turningOn,
        reason: textValue(form, "reason"),
      });
      if (result.ok) {
        // A flip onto the state the switch is already in writes nothing and
        // advances no generation: `set_kill_switch` answers `changed: false`.
        // Saying so is the only honest end to a dialog that has just promised
        // a generation would move — the counter is what every gateway
        // re-checks against, so an operator told a deny propagated when
        // nothing propagated is worse off than one told nothing at all.
        if (!result.value.changed) {
          setUnchanged(true);
          return;
        }
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
          fromHeader ? "tools-flip-open" : `tools-flip-${existing.id}`
        }
        className={fromHeader ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {fromHeader
          ? t("openHeader")
          : turningOn
            ? t("openDeny")
            : t("openAllow")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFailure(null);
            setUnchanged(false);
          }
        }}
        title={turningOn ? t("titleDeny") : t("titleAllow")}
        testId="tools-flip-dialog"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {fromHeader ? (
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
              {selfTargeted ? (
                // The organization and the workspace in view are the target,
                // and the contract wants their database uuids, which this page
                // never prints (INV-11). Asking for a target here would ask for
                // something the page refuses to show, so it states it instead.
                <p
                  data-testid="tools-flip-self-target"
                  className="text-sm text-muted-foreground"
                >
                  {t("target")} · {t(`targetHint.${kind}`)}
                </p>
              ) : (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label
                    htmlFor="target"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("target")}
                  </label>
                  {/* Keyed by level, so a target picked at one level is never
                      sent at another, and a loaded list is read again for the
                      level now chosen. */}
                  {kind === "operator" ? (
                    // set_kill_switch resolves the member's `usr_…` public id
                    // within the org (#3147); the picker submits exactly that,
                    // so the dialog never asks for a uuid this page does not
                    // print.
                    <RecordPicker
                      key={kind}
                      id="target"
                      name="target"
                      required
                      placeholder={t("targetOperatorPlaceholder")}
                      aria-describedby="target-hint"
                      options={members.map((member) => ({
                        value: member.id,
                        label: member.name ?? member.email,
                        detail: member.email,
                      }))}
                    />
                  ) : loadsTargets(kind) ? (
                    <RecordPicker
                      key={kind}
                      id="target"
                      name="target"
                      required
                      aria-describedby="target-hint"
                      load={() => chooseSwitchTargets(at.org, at.ws, kind)}
                    />
                  ) : (
                    <RecordPicker
                      key={kind}
                      id="target"
                      name="target"
                      required
                      freeform
                      aria-describedby="target-hint"
                      options={TAG_OPTIONS}
                    />
                  )}
                  {kind === "operator" && members.length === 0 ? (
                    <p id="target-hint" className="text-xs text-destructive">
                      {t("targetOperatorEmpty")}
                    </p>
                  ) : (
                    <p
                      id="target-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t(`targetHint.${kind}`)}
                    </p>
                  )}
                </div>
              )}
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
              {/* A card knows the state of the switch it flips, so the counter
                  moves. The header does not: it names a target and the target
                  may already be denied at that level, in which case the flip
                  writes nothing and the generation stays where it is. The
                  board cannot settle that — past the read's limit it does not
                  know what is already on — so the dialog states the condition
                  rather than promising on a page-scoped answer. */}
              {fromHeader
                ? t("takesEffectValueIfChanged", {
                    from: generation,
                    to: generation + 1,
                  })
                : t("takesEffectValue", {
                    from: generation,
                    to: generation + 1,
                  })}
            </dd>
            <dt className="text-muted-foreground">{t("recordedAs")}</dt>
            <dd className="text-foreground">{t("recordedAsValue")}</dd>
          </dl>
          {unchanged ? (
            <p
              data-testid="tools-flip-unchanged"
              className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
            >
              {t("unchanged")}
            </p>
          ) : null}
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
