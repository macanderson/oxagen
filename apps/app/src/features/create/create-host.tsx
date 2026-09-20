"use client";
// The one host every creation wizard opens in (roadmap creation-spec §1-§2;
// mockup `DLG_EXT.create` and `DLG_EXT.wz`). The workspace layout mounts it
// once, and every entry point reaches it through `openCreate` in
// `@/shared/create`: ⌘K Create, Steering · Skills "Add a skill", and each
// page's own button as its wizard lands. `openCreate(null)` opens the
// chooser, `openCreate(kind)` that kind's wizard.
//
// The host reads the workspace's main repository each time it opens, because
// every wizard ends on a pull request against it. It writes nothing itself.
import {
  Compass,
  Fingerprint,
  GraduationCap,
  type LucideIcon,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CREATE_EVENT,
  CREATE_KINDS,
  type CreateKind,
  type CreatePrefill,
  createRequestOf,
} from "@/shared/create";
import { buttonGold, buttonSecondary, mono } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { readMainRepository } from "./actions";
import { useDraft } from "./draft";
import { WIZARDS } from "./kinds";
import { Rail } from "./parts";
import {
  type AnyWizardKind,
  type CreateContext,
  clampStep,
  type RepoState,
} from "./wizard";

const KIND_ICONS: Record<CreateKind, LucideIcon> = {
  agent: Fingerprint,
  tool: Wrench,
  skill: GraduationCap,
  record: Compass,
};

/** The kinds the chooser offers: offered in `CREATE_KINDS`, and carried here. */
function offeredKinds(): CreateKind[] {
  return CREATE_KINDS.filter((kind) => WIZARDS[kind] !== undefined);
}

function repoName(ctx: CreateContext): string | null {
  return ctx.repo.state === "bound" ? ctx.repo.fullName : null;
}

function Chooser({
  ctx,
  onChoose,
  onOpenChange,
}: {
  ctx: CreateContext;
  onChoose: (kind: CreateKind) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("create");
  const repo = repoName(ctx);
  return (
    <SheetDialog
      open
      onOpenChange={onOpenChange}
      title={t("chooser.title")}
      wide
      testId="create-chooser"
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{t("chooser.lead")}</p>
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {offeredKinds().map((kind) => {
            const Icon = KIND_ICONS[kind];
            return (
              <li key={kind}>
                <button
                  type="button"
                  data-kind={kind}
                  onClick={() => {
                    onChoose(kind);
                  }}
                  className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-8 flex-none place-items-center rounded-lg border border-border bg-muted/40"
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-semibold text-foreground">
                      {t(`kinds.${kind}.label`)}
                    </span>
                    <span className="text-muted-foreground">
                      {t(`kinds.${kind}.body`)}
                    </span>
                    <span
                      className={`${mono} break-all text-xs text-muted-foreground`}
                    >
                      {t(`kinds.${kind}.file`)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground">
          {repo === null
            ? t("chooser.noteUnknown")
            : t("chooser.note", { repository: repo })}
        </p>
      </div>
    </SheetDialog>
  );
}

function Wizard({
  kind,
  wizard,
  prefill,
  ctx,
  onOpenChange,
}: {
  kind: CreateKind;
  wizard: AnyWizardKind;
  prefill?: CreatePrefill;
  ctx: CreateContext;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("create");
  const api = useDraft(() => wizard.init(prefill));
  const [requested, setRequested] = useState(1);
  const [running, setRunning] = useState(false);
  const steps = wizard.steps(api.draft);
  const step = clampStep(requested, steps.length);
  const view = wizard.useStep({ api, ctx, step });
  const primary = view.primary;
  const pending = running || primary?.pending === true;

  async function press() {
    if (primary === undefined || !primary.enabled || pending) return;
    if (primary.run === undefined) {
      setRequested(step + 1);
      return;
    }
    setRunning(true);
    try {
      await primary.run();
    } finally {
      setRunning(false);
    }
  }

  return (
    <SheetDialog
      open
      onOpenChange={onOpenChange}
      title={view.title}
      wide
      closeLabel={primary === undefined ? t("close") : t("cancel")}
      testId={`create-${kind}`}
      footer={
        <>
          {step > 1 && primary !== undefined ? (
            <button
              type="button"
              className={buttonSecondary}
              disabled={pending}
              onClick={() => {
                setRequested(step - 1);
              }}
            >
              {t("back")}
            </button>
          ) : null}
          {primary === undefined ? null : (
            <button
              type="button"
              data-testid="wizard-primary"
              className={buttonGold}
              disabled={!primary.enabled || pending}
              aria-busy={pending}
              onClick={() => {
                void press();
              }}
            >
              {pending
                ? (primary.pendingLabel ?? primary.label)
                : primary.label}
            </button>
          )}
        </>
      }
    >
      <Rail steps={steps} current={step} />
      <p className="mb-3 text-sm text-muted-foreground">{view.subtitle}</p>
      {view.body}
      <p className={`${mono} mt-4 text-xs text-muted-foreground`}>
        {t.rich("needs", {
          grant: wizard.need,
          workspace: ctx.ws,
          b: (chunks) => <span className="text-foreground">{chunks}</span>,
        })}
      </p>
    </SheetDialog>
  );
}

type Opening = {
  kind: CreateKind | null;
  session: number;
  prefill?: CreatePrefill;
};

export function CreateHost({
  org,
  ws,
  wsName,
}: {
  org: string;
  ws: string;
  wsName: string;
}) {
  // `session` numbers each opening, so a wizard opened again starts from a
  // fresh draft rather than the one a person closed.
  const [open, setOpen] = useState<Opening | null>(null);
  const [repo, setRepo] = useState<RepoState>({ state: "loading" });
  const sessionsRef = useRef(0);
  const readsRef = useRef(0);

  const readRepo = useCallback(async () => {
    const read = ++readsRef.current;
    setRepo({ state: "loading" });
    let next: RepoState;
    try {
      const result = await readMainRepository(org, ws);
      next = result.ok
        ? result.value === null
          ? { state: "unbound" }
          : { state: "bound", ...result.value }
        : result.reason === "denied"
          ? { state: "denied", code: result.code }
          : {
              state: "unavailable",
              code: "code" in result ? result.code : result.reason,
            };
    } catch {
      next = { state: "unavailable", code: "unanswered" };
    }
    if (read === readsRef.current) setRepo(next);
  }, [org, ws]);

  const show = useCallback(
    (kind: CreateKind | null, prefill?: CreatePrefill) => {
      sessionsRef.current += 1;
      setOpen({
        kind,
        session: sessionsRef.current,
        ...(prefill === undefined ? {} : { prefill }),
      });
    },
    [],
  );

  useEffect(() => {
    const onCreate = (event: Event) => {
      const request = createRequestOf(event);
      if (request === null) return;
      show(request.kind, request.prefill);
      void readRepo();
    };
    window.addEventListener(CREATE_EVENT, onCreate);
    return () => {
      window.removeEventListener(CREATE_EVENT, onCreate);
    };
  }, [readRepo, show]);

  if (open === null) return null;
  const ctx: CreateContext = { org, ws, wsName, repo };
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  const wizard = open.kind === null ? undefined : WIZARDS[open.kind];
  if (open.kind === null || wizard === undefined)
    return <Chooser ctx={ctx} onChoose={show} onOpenChange={close} />;
  return (
    <Wizard
      key={open.session}
      kind={open.kind}
      wizard={wizard}
      {...(open.prefill === undefined ? {} : { prefill: open.prefill })}
      ctx={ctx}
      onOpenChange={close}
    />
  );
}
