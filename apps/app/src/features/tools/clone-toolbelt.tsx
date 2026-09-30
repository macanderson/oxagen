"use client";
// Clone a toolbelt (ADR-198): the dialog that copies a belt into a new custom
// belt through `clone_toolbelt`. The new belt starts with every tool the
// source holds, each on or off as it is there, and opens below the list.
//
// The slug fills from the name by the one rule every name-made slug follows
// (`slugFromName`: spaces become hyphens, every other special character is
// dropped) until the person types one of their own.
import { slugFromName } from "@oxagen/oxagen/contracts/runtime.shared";
import { TOOLBELT_SLUG_MAX } from "@oxagen/oxagen/contracts/toolbelt.shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { unanswered } from "@/ui/action-failure";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cloneToolbelt } from "./actions";
import { useActionFailure } from "./action-failure";
import { type ToolsAt, toolsLink } from "./view";

/** Lowercase letters and digits in groups joined by single hyphens, a toolbelt slug's one spelling. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function CloneToolbelt({
  at,
  source,
  label,
  gold = false,
  testId,
}: {
  at: ToolsAt;
  /** The belt the clone copies. */
  source: { id: string; name: string };
  /** The button's text: "New toolbelt" in the panel header, "Clone" on a row. */
  label: string;
  /** Gold for the tab's one primary action. */
  gold?: boolean;
  testId: string;
}) {
  const t = useTranslations("tools.toolbelts.clone");
  const failureOf = useActionFailure();
  const navigate = useNavigate();
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // The slug follows the name until the person edits the slug by hand.
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
    setNameError(null);
    setSlugError(null);
    setFailure(null);
  }

  async function submit() {
    if (pending) return;
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    const badName = trimmedName === "" ? t("errors.nameRequired") : null;
    const badSlug =
      trimmedSlug === "" || !SLUG_PATTERN.test(trimmedSlug)
        ? t("errors.slugInvalid")
        : null;
    setNameError(badName);
    setSlugError(badSlug);
    setFailure(null);
    if (badName !== null || badSlug !== null) return;
    setPending(true);
    try {
      const result = await cloneToolbelt(at.org, at.ws, {
        toolbeltId: source.id,
        name: trimmedName,
        slug: trimmedSlug,
        description,
      });
      if (result.ok) {
        setOpen(false);
        reset();
        navigate.push(
          toolsLink(at, { tab: "toolbelts", belt: result.value.id }),
        );
        return;
      }
      if (
        result.reason === "conflict" &&
        result.code === "toolbelt_slug_taken"
      ) {
        setSlugError(t("errors.slugTaken"));
        return;
      }
      if (result.reason === "invalid" && result.field === "slug") {
        setSlugError(t("errors.slugInvalid"));
        return;
      }
      setFailure(failureOf(result));
    } catch {
      setFailure(failureOf(unanswered("action_failed")));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-touch-target=""
        aria-haspopup="dialog"
        aria-label={gold ? undefined : t("openLabel", { name: source.name })}
        className={gold ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={t("title", { name: source.name })}
        testId={`${testId}-dialog`}
      >
        <form
          noValidate
          aria-label={t("title", { name: source.name })}
          className="flex flex-col gap-4 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-muted-foreground">
            {t("lead", { name: source.name })}
          </p>
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
          )}
          <Field
            id={`${baseId}-name`}
            name="name"
            label={t("name")}
            hint={t("nameHint")}
            error={nameError ?? undefined}
            autoComplete="off"
            maxLength={128}
            value={name}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!slugEdited) setSlug(slugFromName(next, TOOLBELT_SLUG_MAX));
            }}
          />
          <Field
            id={`${baseId}-slug`}
            name="slug"
            label={t("slug")}
            hint={t("slugHint")}
            error={slugError ?? undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={TOOLBELT_SLUG_MAX}
            className={mono}
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
          <Field
            id={`${baseId}-description`}
            name="description"
            label={t("description")}
            autoComplete="off"
            maxLength={1024}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <button
            type="submit"
            data-testid={`${testId}-submit`}
            data-touch-target=""
            aria-disabled={pending || undefined}
            className={`${buttonPrimary} w-full`}
          >
            {pending ? t("pending") : t("submit")}
          </button>
        </form>
      </SheetDialog>
    </>
  );
}
