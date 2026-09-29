"use client";
// Files on the assistant's composer (#4690, ADR-222): the state that holds
// them between the pick and the send, the paperclip that picks them, and the
// chips that show them.
//
// A file is uploaded the moment it is attached, so a failed upload shows on
// its own chip before the person sends anything, and the message itself only
// names the stored files. Send waits while a file is uploading and stays
// blocked while a chip shows a problem, so a message never goes out missing a
// file the person can see on the composer.
//
// Each chip shows the file's kind and its size as two separate elements with
// a gap between them, never joined by punctuation. A chip under a sent
// question links its name to the stored file, so the person can open what
// they sent.
import {
  FileCsvIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  PaperclipIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/ui/attachment";
import { formatByteSize } from "@/ui/money-format";
import { FileTabLink } from "@/ui/navigation";
import {
  ASSISTANT_ATTACHMENT_ACCEPT,
  type AttachmentFile,
  type AttachmentProblem,
  planAttachments,
  readBase64,
  type SentAttachment,
  uploadAssistantAttachment,
} from "./assistant-attachment-files";

/** What the composer does with its files. */
export type AssistantAttachments = {
  files: readonly AttachmentFile[];
  /** Attach files: each is checked, and each that passes starts uploading. */
  add: (files: readonly File[]) => void;
  remove: (key: string) => void;
  /**
   * The stored files, handed to the message with the link that opens each
   * one, and the composer cleared.
   */
  take: () => SentAttachment[];
  /** A file is still uploading, so Send waits. */
  uploading: boolean;
  /** A chip shows a problem, so Send is blocked until it is removed. */
  failed: boolean;
};

/**
 * The composer's files for one workspace. Moving to another workspace clears
 * them: a file is stored in the workspace it was uploaded to, and a turn in
 * another workspace cannot read it.
 */
export function useAssistantAttachments(
  org: string,
  ws: string,
): AssistantAttachments {
  const workspace = `${org}/${ws}`;
  const [files, setFiles] = useState<readonly AttachmentFile[]>([]);
  const [shownFor, setShownFor] = useState(workspace);
  // Adjusted during render rather than in an effect, so the old workspace's
  // chips never paint in the new one.
  if (shownFor !== workspace) {
    setShownFor(workspace);
    setFiles([]);
  }
  const lastKeyRef = useRef(0);

  const settle = useCallback(
    (key: string, patch: Partial<AttachmentFile>) => {
      // A chip removed, or cleared by a workspace move, while its upload ran
      // has no key to match, so a late answer changes nothing.
      setFiles((current) =>
        current.map((f) => (f.key === key ? { ...f, ...patch } : f)),
      );
    },
    [],
  );

  const add = useCallback(
    (picked: readonly File[]) => {
      if (picked.length === 0) return;
      const planned = planAttachments(files, picked, () => {
        lastKeyRef.current += 1;
        return `file-${String(lastKeyRef.current)}`;
      });
      setFiles((current) => [...current, ...planned]);
      planned.forEach((chip, index) => {
        const file = picked[index];
        if (chip.state !== "uploading" || file === undefined) return;
        void readBase64(file)
          .then((data) =>
            uploadAssistantAttachment(org, ws, {
              name: chip.name,
              mediaType: chip.mediaType,
              data,
            }),
          )
          .catch(() => ({ ok: false as const, problem: "upload" as const }))
          .then((result) => {
            settle(
              chip.key,
              result.ok
                ? {
                    state: "done",
                    publicId: result.publicId,
                    mediaType: result.mediaType,
                  }
                : { state: "error", problem: result.problem },
            );
          });
      });
    },
    [files, org, ws, settle],
  );

  const remove = useCallback((key: string) => {
    setFiles((current) => current.filter((f) => f.key !== key));
  }, []);

  const take = useCallback((): SentAttachment[] => {
    const sent = files.flatMap((f) =>
      f.state === "done" && f.publicId !== null
        ? [
            {
              key: f.key,
              name: f.name,
              mediaType: f.mediaType,
              size: f.size,
              publicId: f.publicId,
            },
          ]
        : [],
    );
    setFiles([]);
    return sent;
  }, [files]);

  return {
    files,
    add,
    remove,
    take,
    uploading: files.some((f) => f.state === "uploading"),
    failed: files.some((f) => f.state === "error"),
  };
}

/** The paperclip, and the hidden file input it opens. */
export function AssistantAttachmentPicker({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: readonly File[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("shell.assistant.attachments");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        accept={ASSISTANT_ATTACHMENT_ACCEPT}
        data-testid="assistant-attach-input"
        onChange={(e) => {
          const picked = Array.from(e.currentTarget.files ?? []);
          // Cleared so picking the same file again after removing it fires
          // another change.
          e.currentTarget.value = "";
          onFiles(picked);
        }}
      />
      <button
        type="button"
        data-testid="assistant-attach"
        aria-label={t("add")}
        title={t("add")}
        disabled={disabled}
        onClick={() => {
          inputRef.current?.click();
        }}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-app-link-fg outline-none hover:bg-app-link-hover-bg hover:text-app-link-hover-fg focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        <PaperclipIcon aria-hidden="true" className="size-4" />
      </button>
    </>
  );
}

type Kind = "image" | "pdf" | "csv" | "json" | "markdown" | "text" | "file";

function kindOf(mediaType: string): Kind {
  if (mediaType.startsWith("image/")) return "image";
  switch (mediaType) {
    case "application/pdf":
      return "pdf";
    case "text/csv":
      return "csv";
    case "application/json":
      return "json";
    case "text/markdown":
      return "markdown";
    case "text/plain":
      return "text";
    default:
      return "file";
  }
}

function KindIcon({ kind }: { kind: Kind }) {
  switch (kind) {
    case "image":
      return <FileImageIcon aria-hidden="true" />;
    case "csv":
      return <FileCsvIcon aria-hidden="true" />;
    case "pdf":
    case "markdown":
    case "text":
    case "json":
      return <FileTextIcon aria-hidden="true" />;
    default:
      return <FileIcon aria-hidden="true" />;
  }
}

/** The file's kind, as a word. The keys are static so the catalogue checker sees each one (INV-12). */
function KindLabel({ kind }: { kind: Kind }) {
  const t = useTranslations("shell.assistant.attachments.kinds");
  switch (kind) {
    case "image":
      return <span>{t("image")}</span>;
    case "pdf":
      return <span>{t("pdf")}</span>;
    case "csv":
      return <span>{t("csv")}</span>;
    case "json":
      return <span>{t("json")}</span>;
    case "markdown":
      return <span>{t("markdown")}</span>;
    case "text":
      return <span>{t("text")}</span>;
    default:
      return <span>{t("file")}</span>;
  }
}

function ProblemLabel({ problem }: { problem: AttachmentProblem }) {
  const t = useTranslations("shell.assistant.attachments.problem");
  switch (problem) {
    case "type":
      return <span>{t("type")}</span>;
    case "size":
      return <span>{t("size")}</span>;
    case "empty":
      return <span>{t("empty")}</span>;
    case "count":
      return <span>{t("count")}</span>;
    case "total":
      return <span>{t("total")}</span>;
    case "bytes":
      return <span>{t("bytes")}</span>;
    case "upload":
      return <span>{t("upload")}</span>;
  }
}

/** The file's size in the viewer's locale, as the rest of the app prints one. */
function SizeLabel({ bytes }: { bytes: number }) {
  const locale = useLocale();
  return <span>{formatByteSize(bytes, locale)}</span>;
}

/**
 * The files on the composer, or the files a sent message carried. Without
 * `onRemove` the chips have no Remove button, as under a sent question. A
 * file with an `href` links its name there, in a new tab: the read route
 * serves an image, a PDF, or a text file inline.
 */
export function AssistantAttachmentChips({
  files,
  onRemove,
  testId,
}: {
  files: readonly (Pick<
    AttachmentFile,
    "key" | "name" | "mediaType" | "size" | "state" | "problem"
  > & { href?: SafePath })[];
  onRemove?: (key: string) => void;
  testId?: string;
}) {
  const t = useTranslations("shell.assistant.attachments");
  if (files.length === 0) return null;
  return (
    <AttachmentGroup
      role="list"
      aria-label={t("list")}
      aria-live={onRemove === undefined ? undefined : "polite"}
      data-testid={testId}
    >
      {files.map((file) => {
        const kind = kindOf(file.mediaType);
        return (
          <Attachment
            key={file.key}
            role="listitem"
            size="sm"
            state={file.state}
            data-testid="assistant-attachment"
          >
            <AttachmentMedia>
              {file.state === "error" ? (
                <WarningCircleIcon aria-hidden="true" />
              ) : (
                <KindIcon kind={kind} />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={file.name}>
                {file.href === undefined ? (
                  file.name
                ) : (
                  <FileTabLink
                    to={file.href}
                    aria-label={t("open", { name: file.name })}
                    data-testid="assistant-attachment-link"
                    className="text-app-link-fg underline-offset-2 outline-none hover:text-app-link-hover-fg hover:underline focus-visible:underline"
                  >
                    {file.name}
                  </FileTabLink>
                )}
              </AttachmentTitle>
              <AttachmentDescription>
                <KindLabel kind={kind} />
                {file.state === "uploading" ? (
                  <span>{t("uploading")}</span>
                ) : file.state === "error" && file.problem !== null ? (
                  <ProblemLabel problem={file.problem} />
                ) : (
                  <SizeLabel bytes={file.size} />
                )}
              </AttachmentDescription>
            </AttachmentContent>
            {onRemove === undefined ? null : (
              <AttachmentActions>
                <AttachmentAction
                  aria-label={t("remove", { name: file.name })}
                  onClick={() => {
                    onRemove(file.key);
                  }}
                >
                  <XIcon aria-hidden="true" />
                </AttachmentAction>
              </AttachmentActions>
            )}
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}
