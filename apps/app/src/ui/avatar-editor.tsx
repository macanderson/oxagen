"use client";
// The avatar editor (mockup `avatarBody`/`avatarDlg`), one component for the
// four records that carry an avatar: a person, an agent, a workspace, and an
// organization. The subject decides the tile's shape (people are round, the
// other three are squircles), the title, and the note under the form. What is
// drawn and what is stored are the same for all four, because every contract
// that writes one of them validates the value with `avatarUrlSchema`
// (packages/oxagen/src/avatar.ts).
//
// The draft is one of three kinds (a Lucide glyph, a monogram of up to six
// letters in one of three typefaces, or a photo by https link) and, for the
// two drawn kinds, one of five tones: solid, soft, and line from the theme,
// and the brand gold in its bright and deep shades. The preview on the left is
// the draft itself at every size the app draws it, and the tone swatches are
// the draft in each tone, so what is picked is what is got.
//
// The editor owns the draft and its validation. The caller owns the write:
// `save` receives the stored form ("" clears the avatar) and answers with the
// outcome, and `onSaved` runs when a save lands with no edit made since it was
// sent. A caller whose writes must outlive the dialog passes its own `gate`.
// Otherwise the dialog serializes saves itself.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import { Avatar, AVATAR_GLYPHS, type AvatarShape } from "./avatar";
import {
  AVATAR_FONTS,
  AVATAR_ICONS,
  AVATAR_TONES,
  type AvatarFont,
  type AvatarIcon,
  type AvatarTone,
  type DesignedAvatar,
  INITIALS_MAX,
  initialsOf,
  monogram,
  parseAvatarValue,
  serializeAvatar,
} from "./avatar-spec";
import {
  buttonPrimary,
  buttonSmall,
  fieldHint,
  fieldLabel,
  inputBase,
} from "./control-styles";
import { FormAlert } from "./form-feedback";
import { SheetDialog } from "./sheet-dialog";

/** The four records that carry an avatar. */
export type AvatarSubject = "user" | "agent" | "workspace" | "organization";

/** What a write answered. The editor shows a refusal, and the caller does the rest. */
export type AvatarSaveResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "denied" | "failed" };

/**
 * Reads a server action's answer as the editor's outcome. A refusal the editor
 * has no words for (not found, conflict, unavailable) reads as a failed save.
 */
export function avatarSaveResult(
  result: { ok: true } | { ok: false; reason: string },
): AvatarSaveResult {
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason:
      result.reason === "invalid" || result.reason === "denied"
        ? result.reason
        : "failed",
  };
}

/**
 * Serializes saves. `begin` answers false while one is in flight, so a second
 * press does not send a second write.
 */
type AvatarSaveGate = {
  pending: boolean;
  begin: () => boolean;
  end: () => void;
};

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

const SHAPE: Record<AvatarSubject, AvatarShape> = {
  user: "person",
  agent: "agent",
  workspace: "agent",
  organization: "agent",
};

const segment =
  "inline-flex max-w-full overflow-hidden rounded-lg border border-input-border bg-input-bg";
const segmentButton =
  "min-h-9 border-r border-input-border px-3 text-sm font-medium text-muted-foreground last:border-r-0 aria-pressed:bg-secondary aria-pressed:font-semibold aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring";

const FONT_FACE: Record<AvatarFont, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

/** The editor opens on what is stored, so the record's avatar is edited rather than started over. */
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
  // the stored emoji stays until someone presses Save on a replacement.
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

/** A gate held by the dialog, so a save survives the editor closing under it. */
function useDialogGate(): AvatarSaveGate {
  const busyRef = useRef(false);
  const [pending, setPending] = useState(false);
  return {
    pending,
    begin: () => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setPending(true);
      return true;
    },
    end: () => {
      busyRef.current = false;
      setPending(false);
    },
  };
}

type AvatarEditorProps = {
  subject: AvatarSubject;
  /** The stored avatar the draft opens on. It is re-read until the first edit. */
  value: string | null;
  /** Whether a stored avatar exists to remove; defaults to whether `value` is set. */
  removable?: boolean;
  /** Writes the stored form. An empty string clears the avatar. */
  save: (value: string) => Promise<AvatarSaveResult>;
  /** Runs after a save lands with no edit made since it was sent. */
  onSaved: () => void;
  gate?: AvatarSaveGate;
};

/**
 * The editor in its dialog. `name` titles the dialog for an agent, a
 * workspace, or an organization, and a person's own dialog reads "Your
 * avatar". Its initials are the letters a new monogram starts from and the
 * fallback tile shows.
 */
export function AvatarEditorDialog({
  open,
  onOpenChange,
  name,
  subtitle,
  testId = "avatar-dialog",
  gate,
  ...editor
}: AvatarEditorProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** The record the dialog is about: an email, a key, or a slug. */
  subtitle?: string;
  testId?: string;
}) {
  const t = useTranslations("ui.avatarEditor");
  const formId = useId();
  const dialogGate = useDialogGate();
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(`titles.${editor.subject}`, { name })}
      subtitle={subtitle}
      closeLabel={t("cancel")}
      wide
      testId={testId}
      footer={
        <button
          type="submit"
          form={formId}
          data-touch-target=""
          data-testid="avatar-save"
          className={buttonPrimary}
        >
          {t("save")}
        </button>
      }
    >
      {open ? (
        <AvatarEditor
          {...editor}
          letters={initialsOf(name)}
          formId={formId}
          gate={gate ?? dialogGate}
        />
      ) : null}
    </SheetDialog>
  );
}

function AvatarEditor({
  subject,
  value,
  letters,
  removable = Boolean(value),
  save,
  onSaved,
  gate,
  formId,
}: AvatarEditorProps & {
  letters: string;
  gate: AvatarSaveGate;
  formId: string;
}) {
  const t = useTranslations("ui.avatarEditor");
  const lettersId = useId();
  const urlId = useId();
  const shape = SHAPE[subject];
  const editsRef = useRef(0);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value, letters));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { pending } = gate;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (editsRef.current === 0) {
      setDraft(draftFrom(value, letters));
    }
  }, [value, letters]);

  function edit(patch: Partial<Draft>) {
    editsRef.current += 1;
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
    await write(stored(draft));
  }

  async function write(next: string) {
    if (!gate.begin()) return;
    setOutcome(null);
    const sentAt = editsRef.current;
    try {
      const result = await save(next);
      if (result.ok) {
        if (mountedRef.current && editsRef.current === sentAt) onSaved();
      } else setOutcome(result.reason);
    } catch {
      setOutcome("failed");
    } finally {
      gate.end();
    }
  }

  const preview =
    draft.kind === "photo" ? draft.url.trim() : serializeAvatar(drawn(draft));
  const describe =
    draft.kind === "photo"
      ? draft.url.trim() === ""
        ? t("describePhotoNone")
        : t("describePhoto")
      : draft.kind === "icon"
        ? t("describeIcon", { icon: draft.icon, tone: draft.tone })
        : t("describeInitials", { font: draft.font, tone: draft.tone });

  return (
    <form id={formId} noValidate onSubmit={(e) => void onSubmit(e)}>
      <div className="grid gap-4 md:grid-cols-[150px_1fr] md:items-start">
        <div
          data-testid="avatar-preview"
          data-shape={shape}
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-input-bg px-2.5 pb-3.5 pt-4"
        >
          <Avatar value={preview} initials={letters} size={72} shape={shape} />
          <div className="flex items-center gap-2">
            <Avatar
              value={preview}
              initials={letters}
              size={36}
              shape={shape}
            />
            <Avatar
              value={preview}
              initials={letters}
              size={24}
              shape={shape}
            />
            <Avatar
              value={preview}
              initials={letters}
              size={18}
              shape={shape}
            />
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
                {AVATAR_ICONS.map((icon) => {
                  const Glyph = AVATAR_GLYPHS[icon];
                  return (
                    <button
                      key={icon}
                      type="button"
                      aria-pressed={draft.icon === icon}
                      aria-label={icon}
                      title={icon}
                      data-testid={`avatar-icon-${icon}`}
                      className="grid h-9 place-items-center rounded-lg border border-transparent bg-input-bg text-muted-foreground hover:border-input-border hover:text-foreground aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                      onClick={() => {
                        edit({ icon });
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
              <p className={fieldHint}>{t("iconHint")}</p>
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
                <p className={fieldHint}>
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
              <p className={fieldHint}>{t("photoHint")}</p>
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
                      initials={letters}
                      size={32}
                      shape={shape}
                    />
                  </button>
                ))}
              </div>
              <p className={fieldHint}>{t("toneHint")}</p>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-4 border-l-2 border-brand pl-3 text-xs leading-relaxed text-muted-foreground">
        {t.rich(`notes.${subject}`, {
          code: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </p>

      {removable ? (
        <div className="mt-4">
          <button
            type="button"
            className={buttonSmall}
            disabled={pending}
            data-testid="avatar-remove"
            onClick={() => void write("")}
          >
            {t("remove")}
          </button>
          <p className={fieldHint}>{t(`removeHints.${subject}`)}</p>
        </div>
      ) : null}

      {outcome !== null ? (
        <div className="mt-4">
          <FormAlert testId={`avatar-${outcome}`}>
            {outcome === "denied" ? t(`denied.${subject}`) : t(outcome)}
          </FormAlert>
        </div>
      ) : null}
      <p role="status" className="sr-only">
        {pending ? t("saving") : ""}
      </p>
    </form>
  );
}
