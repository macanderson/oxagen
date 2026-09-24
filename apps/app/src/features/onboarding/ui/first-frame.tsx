"use client";
// Step 3 of Register an agent (register-run spec): the two client halves of
// the wait. The waiting card schedules the next server read after each one
// completes; the server holds each read open inside `get_first_frame`'s own
// wait while a host is enrolled, so an open page costs one kernel call per
// wait. The received card counts six seconds down and opens Fleet, and Open in
// Fleet opens it at once. Both render what the server read and formatted:
// nothing here is invented, and a log line Oxagen does not hold is not drawn.
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";

/** Seconds the received card waits before it opens Fleet on its own (register-run spec). */
const AUTO_OPEN_SECONDS = 6;

/**
 * Re-reads the step once the last read completed. Before a host enrolls the
 * server answers at once, so the delay keeps that path from a tight loop.
 */
export function FirstFramePoll({ revision }: { revision: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    const timer = setTimeout(() => {
      navigate.refresh();
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [revision, navigate]);
  return null;
}

/** Check again: one more read now, with its progress in the label. */
export function CheckAgain({ className = "" }: { className?: string }) {
  const t = useTranslations("onboarding.register.run");
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setChecking(true);
        navigate.refresh();
      }}
      className={`${buttonSecondary} ${className}`}
    >
      {checking ? t("checking") : t("again")}
    </button>
  );
}

/**
 * The received card's footer end: the countdown caption (`#regAuto`, in the
 * DOM and announced) and Open in Fleet, the screen's one gold action.
 */
export function OpenInFleet({
  fleet,
  children,
}: {
  fleet: SafePath;
  /** Cancel, drawn first in the footer row. */
  children: ReactNode;
}) {
  const t = useTranslations("onboarding.register.run.received");
  const navigate = useNavigate();
  const [left, setLeft] = useState(AUTO_OPEN_SECONDS);

  useEffect(() => {
    if (left <= 0) {
      navigate.push(fleet);
      return;
    }
    const timer = setTimeout(() => {
      setLeft((n) => n - 1);
    }, 1_000);
    return () => {
      clearTimeout(timer);
    };
  }, [left, fleet, navigate]);

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      {children}
      <span
        id="regAuto"
        role="status"
        className="text-xs text-muted-foreground md:ml-auto"
      >
        {left >= AUTO_OPEN_SECONDS ? t("auto") : t("autoIn", { n: left })}
      </span>
      <button
        type="button"
        onClick={() => {
          navigate.push(fleet);
        }}
        className={`${buttonPrimary} max-md:w-full`}
      >
        {t("open")}
      </button>
    </div>
  );
}
