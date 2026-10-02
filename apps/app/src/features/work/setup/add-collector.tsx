"use client";
// Add collector (roadmap mockups/src/work-setup.js `DIALOGS.addcollector`):
// a GitHub collector's name, the GitHub connection it reads through, and the
// repositories whose issues become work items. Saving a name the workspace
// already has changes what that collector reads (set_work_collector). A new
// or widened collector reads its repositories right away.
//
// A new collector needs a connection, so the dialog offers the workspace's
// connected GitHub accounts. An existing collector may keep its own. With no
// connected GitHub account the dialog says where to connect one and saves
// nothing. When the connections could not be read, the picker is disabled
// with the reason, and an existing collector can still change its
// repositories.
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
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { setCollector } from "../actions";
import { UNANSWERED, useListActionFailure } from "../list-action-failure";

/** A connected GitHub account the collector can read through. */
type ConnectionChoice = { readonly id: string; readonly name: string };

/** set_work_collector's name rule: lowercase words joined by single hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A repository as owner/name. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

export function AddCollector({
  org,
  ws,
  canControl,
  collectors,
  connections,
}: {
  org: string;
  ws: string;
  /** Whether the viewer may change collectors; unknown reads as allowed and the server decides. */
  canControl: boolean;
  /** The names the workspace's collectors already carry. */
  collectors: readonly string[];
  /** The connected GitHub accounts, or null when they could not be read. */
  connections: readonly ConnectionChoice[] | null;
}) {
  const t = useTranslations("work.setup.addCollector");
  const c = useTranslations("work.setup.collectors");
  const failureText = useListActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const existing = collectors.includes(name.trim());
  const noConnection = connections !== null && connections.length === 0;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || noConnection) return;
    const form = new FormData(event.currentTarget);
    const raw = form.get("repos");
    const repos = (typeof raw === "string" ? raw : "")
      .split(/\r?\n/)
      .map((repo) => repo.trim())
      .filter((repo) => repo !== "");
    const trimmed = name.trim();
    if (!NAME.test(trimmed)) {
      setFailure(t("nameInvalid"));
      return;
    }
    if (repos.length === 0) {
      setFailure(t("reposRequired"));
      return;
    }
    if (repos.some((repo) => !REPOSITORY.test(repo))) {
      setFailure(t("reposInvalid"));
      return;
    }
    if (!existing && connection === "") {
      setFailure(t("connectionRequired"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await setCollector(org, ws, {
        name: trimmed,
        repos,
        connectionId: connection === "" ? null : connection,
      });
      if (result.ok) {
        setOpen(false);
        setName("");
        setConnection("");
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

  const connectionHint =
    connections === null
      ? t("connectionsFailed")
      : noConnection
        ? undefined
        : t("connectionHint");

  return (
    <>
      <button
        type="button"
        data-testid="work-add-collector"
        disabled={!canControl}
        aria-describedby={canControl ? undefined : reasonId}
        title={canControl ? undefined : c("noRole")}
        className={buttonPrimary}
        onClick={() => {
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
                setName(event.currentTarget.value);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-required="true"
              aria-describedby="work-collector-name-hint"
              className={`${inputBase} font-mono`}
            />
          </FieldRow>
          <FieldRow
            id="work-collector-connection"
            label={t("connection")}
            hint={connectionHint}
          >
            <select
              id="work-collector-connection"
              name="connection"
              value={connection}
              onChange={(event) => {
                setConnection(event.currentTarget.value);
              }}
              disabled={connections === null || noConnection}
              aria-describedby={
                connectionHint === undefined
                  ? undefined
                  : "work-collector-connection-hint"
              }
              className={inputBase}
            >
              <option value="">
                {existing ? t("connectionKeep") : t("connectionChoose")}
              </option>
              {(connections ?? []).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </FieldRow>
          {noConnection ? (
            <p
              data-testid="work-add-collector-no-connection"
              className="text-sm text-foreground"
            >
              {t.rich("noConnection", {
                link: (chunks) => (
                  <SafeLink
                    to={routes.repositories(org, ws)}
                    className={linkText}
                  >
                    {chunks}
                  </SafeLink>
                ),
              })}
            </p>
          ) : null}
          <FieldRow
            id="work-collector-repos"
            label={t("repos")}
            hint={t("reposHint")}
          >
            <textarea
              id="work-collector-repos"
              name="repos"
              rows={4}
              spellCheck={false}
              aria-required="true"
              aria-describedby="work-collector-repos-hint"
              className={`${textareaBase} font-mono`}
            />
          </FieldRow>
          <p className="text-[12.5px] text-muted-foreground">
            {t("writeBack")}
          </p>
          {failure === null ? null : (
            <FormAlert testId="work-action-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={t("pending")}
            disabled={noConnection}
            testId="work-add-collector-submit"
          />
        </form>
      </SheetDialog>
    </>
  );
}
