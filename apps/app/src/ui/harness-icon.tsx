import type { ReactNode } from "react";
import { Terminal } from "lucide-react";

const MARKS: Readonly<Record<string, string>> = {
  "claude-code": "claude-code",
  "claude-agent-sdk": "claude-desktop",
  "claude-desktop": "claude-desktop",
  codex: "codex",
  cursor: "cursor",
  stella: "stella",
};

export interface HarnessIconProps {
  harness: string | null | undefined;
  size?: number;
  className?: string;
}

/** Decorative mark. Keep the recorded harness name beside it. */
export function HarnessIcon({
  harness,
  size = 24,
  className = "",
}: HarnessIconProps) {
  // Only a canonical recorded harness gets a mark. An alias or a custom name
  // keeps the generic icon, so the mark never claims more than the record does.
  const key = harness ?? "";
  const mark = MARKS[key];
  const style = { width: size, height: size };
  if (!mark) {
    return (
      <Terminal
        aria-hidden="true"
        size={size}
        className={`shrink-0 text-muted-foreground ${className}`}
      />
    );
  }
  const light =
    mark === "stella"
      ? "/brand/stella-icon.svg"
      : `/harnesses/${mark}-light.svg`;
  const dark = mark === "stella" ? light : `/harnesses/${mark}-dark.svg`;
  return (
    <span
      aria-hidden="true"
      data-harness-mark={mark}
      className={`inline-flex shrink-0 align-middle ${className}`}
      style={style}
    >
      {/* Local SVG brand marks need no raster resizing or image proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={light}
        alt=""
        width={size}
        height={size}
        className={
          light === dark
            ? "size-full object-contain"
            : "size-full object-contain dark:hidden"
        }
      />
      {light === dark ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- The dark variant is also a local SVG.
        <img
          src={dark}
          alt=""
          width={size}
          height={size}
          className="hidden size-full object-contain dark:block"
        />
      )}
    </span>
  );
}

export function HarnessLabel({
  harness,
  children,
  className = "",
  size = 24,
}: HarnessIconProps & { children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <HarnessIcon harness={harness} size={size} />
      <span>{children}</span>
    </span>
  );
}
