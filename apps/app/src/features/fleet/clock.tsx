"use client";
// A live m:ss reading off an approval's instants: time waited since it was
// parked, or time left until it expires. The first render uses the server's
// instant, so the server and client markup agree; it ticks once a second after.
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { formatClock } from "@/ui/money-format";

const TICK_MS = 1000;

export function Clock({
  at,
  now,
  direction,
}: {
  /** Epoch milliseconds of the instant the clock reads from or to. */
  at: number;
  /** Epoch milliseconds the server rendered at. */
  now: number;
  direction: "since" | "until";
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
    <time dateTime={`PT${String(seconds)}S`} className="font-mono tabular-nums">
      {formatClock(seconds, locale)}
    </time>
  );
}
