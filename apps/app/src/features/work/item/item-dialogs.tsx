"use client";
// Closing and reopening an item (roadmap mockups/src/work.js `wrk-close`,
// `wrk-reopen`). Close takes a resolution and the person's reason, and keeps
// the item and its history. oxagen writes nothing back to GitHub, so an issue
// stays open there, and the dialog says so. Reopen keeps every earlier send,
// review and result in the history and sends the brief back to a draft, so a
// person approves it again before the next send.
import { useTranslations } from "next-intl";
import type { CloseResolution } from "@/data/contracts/work";
import { fieldLabel } from "@/ui/control-styles";
import { closeItem, reopenItem } from "../actions";
import { useActionFailure } from "./action-failure";
import { ReasonField } from "./fields";
import type { ItemData } from "./view";
import {
  type DialogControl,
  formText,
  type SubmitOutcome,
  WorkDialog,
} from "./work-dialog";

const RESOLUTIONS: readonly CloseResolution[] = ["cancelled", "declined", "duplicate"];

type Place = { org: string; ws: string; detail: ItemData };

export function CloseDialog({
  org,
  ws,
  detail,
  preset,
  ...control
}: Place &
  DialogControl & {
    /** The resolution the dialog opens on: Duplicate from Confirm duplicate. */
    preset: CloseResolution | null;
  }) {
  const t = useTranslations("workItem.close");
  const failureText = useActionFailure();
  const number = detail.item.number;
  const wait = detail.item.wait;
  const duplicateOf = wait.kind === "possible_duplicate" ? wait.of : null;
  const opensOn = preset ?? "cancelled";

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const picked = formText(form, "resolution");
    const resolution = RESOLUTIONS.find((r) => r === picked) ?? opensOn;
    const result = await closeItem(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      resolution,
      reason: formText(form, "reason"),
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  return (
    <WorkDialog
      name="close"
      {...control}
      title={t("title", { number })}
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-base text-muted-foreground">
        {t("body")}
        {detail.item.origin === "provider" ? ` ${t("github")}` : null}
      </p>
      <fieldset className="flex flex-col">
        <legend className={fieldLabel}>{t("resolution")}</legend>
        <div className="flex flex-wrap gap-2">
          {RESOLUTIONS.map((resolution) => (
            <label
              key={resolution}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-4xl border border-border px-3 text-base text-foreground has-checked:border-gold has-checked:bg-hl"
            >
              <input
                type="radio"
                name="resolution"
                value={resolution}
                defaultChecked={resolution === opensOn}
                data-testid={`work-close-${resolution}`}
                className="size-4 accent-gold"
              />
              {t(`resolutions.${resolution}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <ReasonField
        id="work-close-reason"
        label={t("reason")}
        hint={t("reasonHint")}
        defaultValue={
          opensOn === "duplicate" && duplicateOf !== null
            ? t("duplicateReason", { number: duplicateOf.number })
            : undefined
        }
      />
    </WorkDialog>
  );
}

export function ReopenDialog({ org, ws, detail, ...control }: Place & DialogControl) {
  const t = useTranslations("workItem.reopen");
  const failureText = useActionFailure();

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const result = await reopenItem(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      reason: formText(form, "reason"),
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  return (
    <WorkDialog
      name="reopen"
      {...control}
      title={t("title", { number: detail.item.number })}
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-base text-muted-foreground">{t("body")}</p>
      <ReasonField id="work-reopen-reason" label={t("reason")} hint={t("reasonHint")} />
    </WorkDialog>
  );
}
