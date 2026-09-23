"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Bell, CheckCheck } from "lucide-react";
import { readShellActivity, markShellNotification } from "./activity-actions";
import { useShellState } from "./shell-state";
import { useSidebarSections } from "./sidebar";
import type { ShellData } from "./shell-data";
import { ApprovalsPanel } from "@/features/fleet";
import { readOk } from "@/data/read";
import { routes, sanitizeNext } from "@/shared/safe-path";
import { SheetDialog } from "@/ui/sheet-dialog";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { buttonSecondary } from "@/ui/control-styles";

type Activity = Awaited<ReturnType<typeof readShellActivity>>;
type ActivityState = {
  read: Activity | null;
  failed: boolean;
  refresh: () => Promise<void>;
};
const ActivityContext = createContext<ActivityState | null>(null);

export function useShellActivity() {
  return use(ActivityContext);
}

export function ShellActivityProvider({
  data,
  children,
}: {
  data: ShellData;
  children: ReactNode;
}) {
  const { ws } = useSidebarSections(data);
  const [result, setResult] = useState<{ key: string; read: Activity } | null>(
    null,
  );
  const generation = useRef(0);
  const [failed, setFailed] = useState(false);
  const key = `${data.org.slug}/${ws ?? ""}`;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const read = await readShellActivity(data.org.slug, ws);
      if (request !== generation.current) return;
      setResult({ key, read });
      setFailed(false);
    } catch {
      if (request === generation.current) setFailed(true);
    }
  }, [data.org.slug, ws, key]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 30_000);
    };
    void poll();
    return () => {
      stopped = true;
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [refresh]);
  const read = result?.key === key ? result.read : null;
  return (
    <ActivityContext value={{ read, failed, refresh }}>
      {children}
    </ActivityContext>
  );
}

export function ActivityButtons() {
  const t = useTranslations("shell.activity");
  const state = useShellActivity();
  const { setApprovalsOpen, setNotificationsOpen } = useShellState();
  const value = state?.read?.ok ? state.read.value : null;
  const count = value?.workspaces.reduce(
    (n, w) => n + (w.pending.ok ? w.pending.value.items.length : 0),
    0,
  );
  const incomplete = value?.workspaces.some(
    (w) => !w.pending.ok || w.pending.value.more,
  );
  const unread = value
    ? value.notifications.items.filter((n) => n.notification.unread).length
    : null;
  return (
    <>
      <button
        type="button"
        data-touch-target=""
        className="relative grid min-h-11 min-w-11 place-items-center rounded-lg border border-border"
        aria-label={t("notifications")}
        onClick={() => setNotificationsOpen(true)}
      >
        <Bell aria-hidden="true" className="size-4" />
        {unread !== null && unread > 0 ? (
          <span
            aria-label={t("unread", { count: unread })}
            className="absolute right-2 top-2 size-2 rounded-full bg-info"
          />
        ) : null}
      </button>
      <button
        type="button"
        data-touch-target=""
        className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-xs"
        aria-label={t("approvals")}
        onClick={() => setApprovalsOpen(true)}
      >
        <CheckCheck aria-hidden="true" className="size-4" />
        <span className="hidden sm:inline">{t("approvals")}</span>
        {count === undefined ? null : (
          <span className="font-mono">
            {count}
            {incomplete ? "+" : ""}
          </span>
        )}
      </button>
    </>
  );
}

export function ActivityDrawers({ data }: { data: ShellData }) {
  const t = useTranslations("shell.activity");
  const state = useShellActivity();
  const {
    approvalsOpen,
    setApprovalsOpen,
    notificationsOpen,
    setNotificationsOpen,
  } = useShellState();
  const [selection, setSelection] = useState<string | null>(null);
  const [markFailed, setMarkFailed] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const read = state?.read;
  const value = read?.ok ? read.value : null;
  const selected = value?.workspaces
    .flatMap((w) =>
      w.pending.ok ? w.pending.value.items.map((item) => ({ w, item })) : [],
    )
    .find(({ item }) => item.id === selection);
  const mark = async (ws: string | null, id: string, archived: boolean) => {
    setMarking(id);
    setMarkFailed(false);
    try {
      const answer = await markShellNotification(
        data.org.slug,
        ws,
        id,
        archived,
      );
      if (!answer.ok || !answer.value.ok) setMarkFailed(true);
      else await state?.refresh();
    } catch {
      setMarkFailed(true);
    } finally {
      setMarking(null);
    }
  };
  const status = !read ? (
    <p role="status">{t("loading")}</p>
  ) : !read.ok ? (
    <ReadFailure read={read} section={t("approvals")} />
  ) : null;
  return (
    <>
      <SheetDialog
        open={approvalsOpen}
        onOpenChange={setApprovalsOpen}
        title={t("approvals")}
        testId="approvals-drawer"
        side
      >
        <button
          className={buttonSecondary}
          type="button"
          onClick={() => {
            void state?.refresh();
          }}
        >
          {t("refresh")}
        </button>
        {state?.failed ? <p role="alert">{t("failed")}</p> : null}
        {status}
        {selected ? (
          <>
            <button
              className={`${buttonSecondary} my-3`}
              type="button"
              onClick={() => setSelection(null)}
            >
              {t("allApprovals")}
            </button>
            <p className="mb-2 text-sm text-muted-foreground">
              {selected.w.name}
            </p>
            <ApprovalsPanel
              onResolved={() => {
                void state?.refresh();
              }}
              org={data.org.slug}
              ws={selected.w.slug}
              now={Date.parse(value?.readAt ?? "")}
              approvals={readOk({ items: [selected.item], more: false })}
              mandates={
                new Map(
                  selected.w.mandates.ok
                    ? selected.w.mandates.value.mandates.map((m) => [m.id, m])
                    : [],
                )
              }
            />
          </>
        ) : (
          value?.workspaces.map((w) => (
            <section key={w.slug} className="mt-4 space-y-2">
              <h2 className="text-sm font-semibold">{w.name}</h2>
              {!w.pending.ok ? (
                <ReadFailure read={w.pending} section={w.name} />
              ) : w.pending.value.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <ul className="space-y-2">
                  {w.pending.value.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="min-h-11 w-full rounded-lg border border-border p-3 text-left"
                        onClick={() => setSelection(item.id)}
                      >
                        <span className="block font-mono text-xs">
                          {item.tool}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {item.agentKey ?? item.runId ?? item.id}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {w.pending.ok && w.pending.value.more ? (
                <p className="text-xs">{t("partial")}</p>
              ) : null}
              {w.resolved.ok ? (
                <p className="text-xs text-muted-foreground">
                  {t("resolved", { count: w.resolved.value.items.length })}
                  {w.resolved.value.nextCursor ? "+" : ""}
                </p>
              ) : (
                <ReadFailure read={w.resolved} section={t("resolvedTitle")} />
              )}
            </section>
          ))
        )}
        {value?.workspaces.length === 0 ? (
          <p className="mt-4 text-sm">{t("noWorkspaces")}</p>
        ) : null}
      </SheetDialog>
      <SheetDialog
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        title={t("notifications")}
        testId="notifications-drawer"
        side
      >
        {state?.failed || markFailed ? <p role="alert">{t("failed")}</p> : null}
        {!value ? (
          status
        ) : (
          <>
            {value.notifications.failures.map((failure) => (
              <ReadFailure
                key={failure.ws ?? "org"}
                read={failure.read}
                section={failure.ws ?? t("notifications")}
              />
            ))}
            {value.notifications.partial ? (
              <p className="my-2 text-xs">{t("notificationsPartial")}</p>
            ) : null}
            {value.notifications.items.length === 0 ? (
              <p>{t("noNotifications")}</p>
            ) : (
              <ul className="space-y-3">
                {value.notifications.items.map(({ notification: n, ws }) => (
                  <li
                    key={n.publicId}
                    className="rounded-lg border border-border p-3"
                  >
                    <h2 className="text-sm font-semibold">
                      {n.unread ? (
                        <span className="mr-2 inline-block size-2 rounded-full bg-info" />
                      ) : null}
                      {n.title}
                    </h2>
                    {n.body ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {n.body}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {n.deepLink ? (
                        <SafeLink
                          onClick={() => setNotificationsOpen(false)}
                          className={buttonSecondary}
                          to={sanitizeNext(
                            n.deepLink,
                            routes.people(data.org.slug),
                          )}
                        >
                          {t("open")}
                        </SafeLink>
                      ) : null}
                      {n.unread ? (
                        <button
                          type="button"
                          disabled={marking !== null}
                          className={buttonSecondary}
                          onClick={() => {
                            void mark(ws, n.publicId, false);
                          }}
                        >
                          {t("markRead")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={marking !== null}
                        className={buttonSecondary}
                        onClick={() => {
                          void mark(ws, n.publicId, true);
                        }}
                      >
                        {t("archive")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </SheetDialog>
    </>
  );
}
