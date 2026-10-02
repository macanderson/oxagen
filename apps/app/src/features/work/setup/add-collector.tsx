"use client";
// Add collector (roadmap mockups/src/work-setup.js `DIALOGS.addcollector`):
// a GitHub collector's name and the repositories whose issues become work
// items. Saving a name the workspace already has changes what that collector
// reads (set_work_collector). A new or widened collector reads its
// repositories right away, and the page says so once the dialog closes.
//
// The repositories are a checklist of the ones linked to the workspace, the
// only ones a collector may read; nobody types an owner/name. The collector
// reads through the GitHub connection they were linked through, so the
// dialog asks for no connection. Typing an existing collector's name ticks
// the linked repositories it reads. With no linked repository the dialog
// says where to link one and saves nothing, and when the linked repositories
// could not be read it says so and saves nothing.
//
// The button stays on the page for a person whose role cannot change
// collectors. It is disabled and says why, and the server refuses the write
// either way.
import { PlusIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useId,
  useState,
} from "react";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  fieldHint,
  fieldLabel,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { setCollector } from "../actions";
import { UNANSWERED, useListActionFailure } from "../list-action-failure";

/** A collector already in the workspace: its name and what it reads. */
type ExistingCollector = { readonly name: string; readonly repos: readonly string[] };

/** set_work_collector's name rule: lowercase words joined by single hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The name the dialog suggests when the workspace has no collector by it. */
const SUGGESTED_NAME = "issues";

function FieldRow({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className={fieldHint}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The linked repositories an existing collector reads, matched without regard to case. */
function readsOf(
  collectors: readonly ExistingCollector[],
  name: string,
  linked: readonly string[],
): Set<string> {
  const found = collectors.find((collector) => collector.name === name);
  if (found === undefined) return new Set();
  const wanted = new Set(found.repos.map((repo) => repo.toLowerCase()));
  return new Set(linked.filter((repo) => wanted.has(repo.toLowerCase())));
}

export function AddCollector({
  org,
  ws,
  canControl,
  collectors,
  linked,
}: {
  org: string;
  ws: string;
  /** Whether the viewer may change collectors; unknown reads as allowed and the server decides. */
  canControl: boolean;
  /** The workspace's collectors, by name, with the repositories each reads. */
  collectors: readonly ExistingCollector[];
  /** The GitHub repositories linked to the workspace, or null when they could not be read. */
  linked: readonly string[] | null;
}) {
  const t = useTranslations("work.setup.addCollector");
  const c = useTranslations("work.setup.collectors");
  const failureText = useListActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const suggested = collectors.some((collector) => collector.name === SUGGESTED_NAME)
    ? ""
    : SUGGESTED_NAME;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggested);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const repos = linked ?? [];
  const existing = collectors.some((collector) => collector.name === name.trim());
  const cannotSave = linked === null || repos.length === 0;

  function rename(next: string) {
    setName(next);
    // An existing collector's name ticks what it reads, so a save changes it in place.
    if (collectors.some((collector) => collector.name === next.trim())) {
      setSelected(readsOf(collectors, next.trim(), repos));
    }
  }

  function toggle(repo: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(repo);
      else next.delete(repo);
      return next;
    });
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || cannotSave) return;
    const trimmed = name.trim();
    if (!NAME.test(trimmed)) {
      setFailure(t("nameInvalid"));
      return;
    }
    const chosen = repos.filter((repo) => selected.has(repo));
    if (chosen.length === 0) {
      setFailure(t("reposRequired"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await setCollector(org, ws, { name: trimmed, repos: chosen });
      if (result.ok) {
        setOpen(false);
        setNotice(
          result.value.reconcileQueued
            ? t("reading", { name: trimmed, count: chosen.length })
            : t("saved", { name: trimmed }),
        );
        navigate.refresh();
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        data-testid="work-add-collector"
        disabled={!canControl}
        aria-describedby={canControl ? undefined : reasonId}
        title={canControl ? undefined : c("noRole")}
        className={buttonPrimary}
        onClick={() => {
          setName(suggested);
          setSelected(new Set());
          setNotice(null);
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {c("add")}
      </button>
      {canControl ? null : (
        <span id={reasonId} className="sr-only">
          {c("noRole")}
        </span>
      )}
      <p
        role="status"
        data-testid="work-add-collector-status"
        className="max-w-[48ch] text-right text-sm text-muted-foreground"
      >
        {notice}
      </p>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        testId="work-add-collector-dialog"
      >
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <FieldRow id="work-collector-name" label={t("name")} hint={t("nameHint")}>
            <input
              id="work-collector-name"
              name="name"
              value={name}
              onChange={(event) => {
                rename(event.currentTarget.value);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-required="true"
              aria-describedby="work-collector-name-hint"
              className={`${inputBase} font-mono`}
            />
          </FieldRow>
          <fieldset
            data-testid="work-collector-repos"
            aria-describedby="work-collector-repos-hint"
            className="flex min-w-0 flex-col gap-1"
          >
            <legend className={fieldLabel}>{t("repos")}</legend>
            {repos.map((repo) => (
              <label
                key={repo}
                className="flex min-h-11 items-center gap-2.5 text-sm"
              >
                <input
                  type="checkbox"
                  name="repos"
                  value={repo}
                  checked={selected.has(repo)}
                  onChange={(event) => {
                    toggle(repo, event.currentTarget.checked);
                  }}
                />
                <span className={`${mono} [overflow-wrap:anywhere]`}>{repo}</span>
              </label>
            ))}
            <p id="work-collector-repos-hint" className={fieldHint}>
              {linked === null
                ? t("linkedFailed")
                : repos.length === 0
                  ? t.rich("noLinked", {
                      link: (chunks) => (
                        <SafeLink to={routes.repositories(org, ws)} className={linkText}>
                          {chunks}
                        </SafeLink>
                      ),
                    })
                  : t.rich("reposHint", {
                      link: (chunks) => (
                        <SafeLink to={routes.repositories(org, ws)} className={linkText}>
                          {chunks}
                        </SafeLink>
                      ),
                    })}
            </p>
          </fieldset>
          {existing ? (
            <p className="text-sm text-muted-foreground">{t("existing")}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t("writeBack")}</p>
          {failure === null ? null : (
            <FormAlert testId="work-action-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
            disabled={cannotSave}
            testId="work-add-collector-submit"
          />
        </form>
      </SheetDialog>
    </div>
  );
}
