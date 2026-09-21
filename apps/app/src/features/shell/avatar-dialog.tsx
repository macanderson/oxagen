"use client";
// The avatar editor (mockup `avatarBody`/`avatarDlg`): the person's own avatar,
// opened from the Account dialog's Profile tab in place of it and returning to
// it on save or cancel.
//
// The draft is one of three kinds (a Lucide glyph, a monogram of up to six
// letters in one of three typefaces, or a photo by https link) and, for the
// two drawn kinds, one of three tones from the house scale. The preview on the
// left is the draft itself at every size the shell draws it, and the tone
// swatches are the draft in each tone, so what is picked is what is got.
//
// Save writes through `update_profile` (account-actions.ts) like the Profile
// tab, carrying the display name as it stands, because the contract writes
// name and avatar as one record.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import { Avatar, AVATAR_GLYPHS } from "@/ui/avatar";
import {
  AVATAR_FONTS,
  AVATAR_ICONS,
  AVATAR_TONES,
  type AvatarFont,
  type AvatarIcon,
  type AvatarTone,
  type DesignedAvatar,
  INITIALS_MAX,
  monogram,
  parseAvatarValue,
  serializeAvatar,
} from "@/ui/avatar-spec";
import { buttonPrimary, inputBase } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { updateProfile } from "./account-actions";
import { useAccountOperation } from "./account-operations";
import { fieldLabel, hint } from "./account-styles";
import { initials as initialsOf } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

type Kind = "icon" | "initials" | "photo";

type Draft = {
  kind: Kind;
  icon: AvatarIcon;
  text: string;
  font: AvatarFont;
  tone: AvatarTone;
  url: string;
};

type Outcome = "invalid" | "denied" | "failed" | "noPhoto" | "noLetters";

const segment =
  "inline-flex max-w-full overflow-hidden rounded-lg border border-input-border bg-input-bg";
const segmentButton =
  "min-h-9 border-r border-input-border px-3 text-sm font-medium text-muted-foreground last:border-r-0 aria-pressed:bg-secondary aria-pressed:font-semibold aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring";

const FONT_FACE: Record<AvatarFont, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

/** The editor opens on what is stored, so a person edits their avatar rather than starting over. */
function draftFrom(value: string | null, fallbackLetters: string): Draft {
  const stored = parseAvatarValue(value);
  const base: Draft = {
    kind: "initials",
    icon: "bot",
    text: fallbackLetters,
    font: "sans",
    tone: "solid",
    url: "",
  };
  if (stored.kind === "icon")
    return { ...base, kind: "icon", icon: stored.icon, tone: stored.tone };
  if (stored.kind === "initials")
    return {
      ...base,
      text: stored.text,
      font: stored.font,
      tone: stored.tone,
    };
  if (stored.kind === "image")
    return { ...base, kind: "photo", url: stored.url };
  // A legacy emoji avatar lands here with the rest. The editor offers no emoji
  // kind by design, so there is nothing to open on; the draft is a monogram and
  // the stored emoji stays until the person presses Save on a replacement.
  return base;
}

function drawn(draft: Draft): DesignedAvatar {
  return draft.kind === "icon"
    ? { kind: "icon", icon: draft.icon, tone: draft.tone }
    : {
        kind: "initials",
        text: monogram(draft.text) || "?",
        font: draft.font,
        tone: draft.tone,
      };
}

/** What Save will store: the bare URL for a photo, the spec string otherwise. */
function stored(draft: Draft): string {
  return draft.kind === "photo"
    ? draft.url.trim()
    : serializeAvatar(drawn(draft));
}

export function AvatarDialog({ data }: { data: ShellData }) {
  const t = useTranslations("shell.avatar");
  const { avatarOpen, setAvatarOpen } = useShellState();
  return (
    <SheetDialog
      open={avatarOpen}
      onOpenChange={setAvatarOpen}
      title={t("title")}
      subtitle={data.viewer.email}
      closeLabel={t("cancel")}
      wide
      testId="avatar-dialog"
      footer={
        <button
          type="submit"
          form="avatar-form"
          data-touch-target=""
          data-testid="avatar-save"
          className={buttonPrimary}
        >
          {t("save")}
        </button>
      }
    >
      {avatarOpen ? <AvatarEditor data={data} /> : null}
    </SheetDialog>
  );
}

function AvatarEditor({ data }: { data: ShellData }) {
  const t = useTranslations("shell.avatar");
  const navigate = useNavigate();
  const { setAvatarOpen } = useShellState();
  const { viewer, org } = data;
  const lettersId = useId();
  const urlId = useId();
  const shown = viewer.name ?? viewer.email;
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(viewer.avatarUrl, initialsOf(shown)),
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operation = useAccountOperation(viewer.id, "avatar");
  const { pending } = operation;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function edit(patch: Partial<Draft>) {
    setOutcome(null);
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (draft.kind === "photo" && !draft.url.trim().startsWith("https://")) {
      setOutcome("noPhoto");
      return;
    }
    if (draft.kind === "initials" && monogram(draft.text) === "") {
      setOutcome("noLetters");
      return;
    }
    if (!operation.begin()) return;
    setOutcome(null);
    try {
      const result = await updateProfile(org.slug, {
        avatarUrl: stored(draft),
      });
      if (result.ok) {
        navigate.refresh();
        if (mounted.current) setAvatarOpen(false);
      } else if (result.reason === "invalid") setOutcome("invalid");
      else if (result.reason === "denied") setOutcome("denied");
      else setOutcome("failed");
    } catch {
      setOutcome("failed");
    } finally {
      operation.end();
    }
  }

  const preview =
    draft.kind === "photo" ? draft.url.trim() : serializeAvatar(drawn(draft));
  const previewLetters = initialsOf(shown);
  const describe =
    draft.kind === "photo"
      ? draft.url.trim() === ""
        ? t("describePhotoNone")
        : t("describePhoto")
      : draft.kind === "icon"
        ? t("describeIcon", { icon: draft.icon, tone: draft.tone })
        : t("describeInitials", { font: draft.font, tone: draft.tone });

  return (
    <form id="avatar-form" noValidate onSubmit={(e) => void onSubmit(e)}>
      <div className="grid gap-4 md:grid-cols-[150px_1fr] md:items-start">
        <div
          data-testid="avatar-preview"
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-input-bg px-2.5 pb-3.5 pt-4"
        >
          <Avatar value={preview} initials={previewLetters} size={72} />
          <div className="flex items-center gap-2">
            <Avatar value={preview} initials={previewLetters} size={36} />
            <Avatar value={preview} initials={previewLetters} size={24} />
            <Avatar value={preview} initials={previewLetters} size={18} />
          </div>
          <p className="break-words text-center font-mono text-[10.5px] leading-snug text-muted-foreground">
            {describe}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <span className={fieldLabel}>{t("kind")}</span>
            <div className={segment} role="group" aria-label={t("kind")}>
              {(["icon", "initials", "photo"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  data-testid={`avatar-kind-${kind}`}
                  aria-pressed={draft.kind === kind}
                  className={segmentButton}
                  onClick={() => {
                    edit({ kind });
                  }}
                >
                  {t(`kinds.${kind}`)}
                </button>
              ))}
            </div>
          </div>

          {draft.kind === "icon" ? (
            <div>
              <span className={fieldLabel}>{t("icon")}</span>
              <div
                role="group"
                aria-label={t("icon")}
                className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1"
              >
                {AVATAR_ICONS.map((name) => {
                  const Glyph = AVATAR_GLYPHS[name];
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={draft.icon === name}
                      aria-label={name}
                      title={name}
                      data-testid={`avatar-icon-${name}`}
                      className="grid h-9 place-items-center rounded-lg border border-transparent bg-input-bg text-muted-foreground hover:border-input-border hover:text-foreground aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                      onClick={() => {
                        edit({ icon: name });
                      }}
                    >
                      <Glyph
                        className="size-[18px]"
                        strokeWidth={1.8}
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
              <p className={hint}>{t("iconHint")}</p>
            </div>
          ) : null}

          {draft.kind === "initials" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={lettersId} className={fieldLabel}>
                  {t("letters")}
                </label>
                <input
                  id={lettersId}
                  data-testid="avatar-letters"
                  className={`${inputBase} w-[120px] text-base tracking-[0.08em] ${FONT_FACE[draft.font]}`}
                  value={draft.text}
                  maxLength={INITIALS_MAX}
                  autoCapitalize="characters"
                  onChange={(e) => {
                    edit({ text: e.target.value.slice(0, INITIALS_MAX) });
                  }}
                />
                <p className={hint}>
                  {t("lettersHint", { max: INITIALS_MAX })}
                </p>
              </div>
              <div>
                <span className={fieldLabel}>{t("typeface")}</span>
                <div
                  className={segment}
                  role="group"
                  aria-label={t("typeface")}
                >
                  {AVATAR_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      data-testid={`avatar-font-${font}`}
                      aria-pressed={draft.font === font}
                      className={`${segmentButton} ${FONT_FACE[font]}`}
                      onClick={() => {
                        edit({ font });
                      }}
                    >
                      {t(`fonts.${font}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {draft.kind === "photo" ? (
            <div>
              <label htmlFor={urlId} className={fieldLabel}>
                {t("photo")}
              </label>
              <input
                id={urlId}
                type="url"
                inputMode="url"
                data-testid="avatar-url"
                className={inputBase}
                value={draft.url}
                placeholder={t("photoPlaceholder")}
                onChange={(e) => {
                  edit({ url: e.target.value });
                }}
              />
              <p className={hint}>{t("photoHint")}</p>
            </div>
          ) : null}

          {draft.kind !== "photo" ? (
            <div>
              <span className={fieldLabel}>{t("tone")}</span>
              <div
                role="group"
                aria-label={t("tone")}
                className="flex flex-wrap items-center gap-2"
              >
                {AVATAR_TONES.map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    data-testid={`avatar-tone-${tone}`}
                    aria-pressed={draft.tone === tone}
                    aria-label={t(`tones.${tone}`)}
                    title={t(`tones.${tone}`)}
                    className="grid place-items-center rounded-[11px] border border-transparent p-[3px] hover:border-input-border aria-pressed:border-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    onClick={() => {
                      edit({ tone });
                    }}
                  >
                    <Avatar
                      value={serializeAvatar({ ...drawn(draft), tone })}
                      initials={previewLetters}
                      size={32}
                    />
                  </button>
                ))}
              </div>
              <p className={hint}>{t("toneHint")}</p>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-4 border-l-2 border-brand pl-3 text-xs leading-relaxed text-muted-foreground">
        {t.rich("note", {
          code: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </p>

      {outcome !== null ? (
        <div className="mt-4">
          <FormAlert testId={`avatar-${outcome}`}>{t(outcome)}</FormAlert>
        </div>
      ) : null}
      <p role="status" className="sr-only">
        {pending ? t("saving") : ""}
      </p>
    </form>
  );
}
