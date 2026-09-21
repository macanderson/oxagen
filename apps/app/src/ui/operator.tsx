"use client";
// An operator, named. The label is the person's full name, never the
// principal id: an id is a key the record uses, and a person reads a name.
// A principal with no name reads by what it is (an agent, a service, an
// unnamed person), and the id stays inside the hover card, copyable, beside
// the email, the avatar and the role in the scope being read.
//
// The card mounts only while the pointer or the keyboard focus is on the
// name, so a table cell's text is the name and nothing else, and it opens on
// the kit's overlay timing.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
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
export function initialsOf(name: string): string {
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
      data-testid={testId ?? "operator"}
      data-operator-id={operator.id ?? undefined}
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
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span
        tabIndex={hasCard ? 0 : undefined}
        className="min-w-0 truncate rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children ?? label}
      </span>
      {hasCard && open ? (
        <span
          role="tooltip"
          data-testid="operator-card"
          className="animate-in absolute top-full left-0 z-30 mt-1.5 block w-max min-w-56 max-w-xs rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm font-normal whitespace-normal text-card-foreground shadow-md"
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
        </span>
      ) : null}
    </span>
  );
}
