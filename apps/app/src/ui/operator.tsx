"use client";
// An operator, named. The label is the person's full name, never the
// principal id: an id is a key the record uses, and a person reads a name.
// A principal with no name reads by what it is (an agent, a service, an
// unnamed person), and the id stays inside the hover card, copyable, beside
// the email, the avatar and the role in the scope being read.
//
// The card mounts only while the pointer or the keyboard focus is on the
// name, so a table cell's text is the name and nothing else, and it opens on
// the kit's overlay timing. It renders into the document body, placed under
// the name, because a table cell clips what overflows it (#4665).
import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Avatar } from "./avatar";
import { mono } from "./control-styles";

export type OperatorIdentity = {
  /** The principal public id; the key, never the label. */
  id: string | null;
  name: string | null;
  /** Why there is no name, when there is none: what kind of principal this is. */
  kind?: "human" | "agent" | "service" | null;
  email?: string | null;
  avatarUrl?: string | null;
  /** The role in the scope the page reads: the workspace's, or the org's. */
  role?: string | null;
};

/** Two letters from a name: first letters of its first two words. */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

export function OperatorName({
  operator,
  children,
  className,
  testId,
}: {
  operator: OperatorIdentity;
  /**
   * The label to draw: the caller's own wording for a principal with no
   * name, or the name wrapped in a link. The name itself by default.
   */
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const t = useTranslations("ui.operator");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    // 6px under the name, or over it when the viewport has no room below,
    // and kept 8px inside the viewport's right edge.
    const follow = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const width = cardRef.current?.offsetWidth ?? 0;
      const height = cardRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + 6;
      const above = rect.top - 6 - height;
      const fitsBelow = below + height <= window.innerHeight - 8;
      // eslint-disable-next-line @eslint-react/set-state-in-effect -- layout measurement: the card's place comes from the name's box after layout
      setPlace({
        top: fitsBelow || above < 8 ? below : above,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    };
    follow();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);
  const label =
    operator.name ??
    (operator.kind === "agent" || operator.kind === "service"
      ? t(`kind.${operator.kind}`)
      : operator.kind === "human"
        ? t("unnamed")
        : t("unknown"));
  const hasCard =
    operator.id !== null ||
    operator.email != null ||
    operator.role != null ||
    operator.avatarUrl != null;
  return (
    <span
      ref={rootRef}
      data-testid={testId ?? "operator"}
      data-operator-id={operator.id ?? undefined}
      // The card shows the whole name, so a table cell's tooltip stays shut.
      data-hover-card={hasCard ? "" : undefined}
      className={`relative inline-flex max-w-full items-center ${className ?? ""}`}
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
      onFocus={() => {
        setOpen(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          !event.currentTarget.contains(next) &&
          cardRef.current?.contains(next) !== true
        )
          setOpen(false);
      }}
    >
      <span
        tabIndex={hasCard ? 0 : undefined}
        className="min-w-0 truncate rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children ?? label}
      </span>
      {hasCard && open
        ? createPortal(
            <span
              ref={cardRef}
              role="tooltip"
              data-testid="operator-card"
              style={place}
              className="animate-in fixed z-50 block w-max min-w-56 max-w-xs rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm font-normal whitespace-normal text-card-foreground shadow-md"
            >
              <span className="flex items-center gap-2.5">
                <Avatar
                  value={operator.avatarUrl ?? null}
                  initials={initialsOf(operator.name ?? label)}
                  size={32}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">{label}</span>
                  {operator.email == null ? null : (
                    <span className="truncate text-xs text-muted-foreground">
                      {operator.email}
                    </span>
                  )}
                </span>
              </span>
              <span className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">{t("role")}</span>
                <span>{operator.role ?? t("noRole")}</span>
                {operator.id === null ? null : (
                  <>
                    <span className="text-muted-foreground">{t("id")}</span>
                    <span className={`${mono} select-all break-all`}>
                      {operator.id}
                    </span>
                  </>
                )}
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
