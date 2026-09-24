"use client";
// A live clock reading off one instant: time since it (an approval parked, a
// run started), or time left until it (an approval's expiry). The first render
// uses the server's instant, so the server and client markup agree; it ticks
// once a second after. Fleet's approval clocks and the Run page's wall clock
// read it.
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { formatClock } from "@/ui/money-format";

const TICK_MS = 1000;

export function Clock({
  at,
  now,
  direction,
  className = "font-mono tabular-nums",
}: {
  /** Epoch milliseconds of the instant the clock reads from or to. */
  at: number;
  /** Epoch milliseconds the server rendered at. */
  now: number;
  direction: "since" | "until";
  /** The reading's type; tabular figures keep it from jittering as it ticks. */
  className?: string;
}) {
  const locale = useLocale();
  const [current, setCurrent] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const elapsed = direction === "since" ? current - at : at - current;
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  return (
    <time dateTime={`PT${String(seconds)}S`} className={className}>
      {formatClock(seconds, locale)}
    </time>
  );
}
