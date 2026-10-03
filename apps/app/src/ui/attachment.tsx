// A file shown as a chip: its icon or preview, its name, one line about it,
// and an action such as Remove. Ported from shadcn's base-maia `attachment`
// (https://ui.shadcn.com/docs/components/base/attachment) with the same slots
// and data attributes, written with plain class lists instead of `cva` and
// `cn` so the app takes no new dependency for it (#4690, ADR-222).
//
// The chip sits on the assistant's flyout, a raised surface, so it is drawn
// with the raised tokens, and its action is the kit's ghost icon button.
import type { ComponentProps } from "react";
import { Button } from "./button";

/** Where a file is on its way to the message. */
export type AttachmentState = "uploading" | "error" | "done";

type AttachmentSize = "default" | "sm" | "xs";

function join(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const SIZE: Record<AttachmentSize, string> = {
  default:
    "gap-2 px-2.5 py-2 text-base has-data-[slot=attachment-media]:p-2 has-data-[slot=attachment-media]:pr-2.5",
  sm: "gap-2 px-2 py-1.5 text-sm has-data-[slot=attachment-media]:p-1.5 has-data-[slot=attachment-media]:pr-2",
  xs: "gap-1.5 rounded-lg px-1.5 py-1 text-sm has-data-[slot=attachment-media]:p-1 has-data-[slot=attachment-media]:pr-1.5",
};

/** One file. `state` reaches `data-state`, which every slot reads. */
export function Attachment({
  className,
  state = "done",
  size = "default",
  ...props
}: ComponentProps<"div"> & {
  state?: AttachmentState;
  size?: AttachmentSize;
}) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      aria-busy={state === "uploading" ? true : undefined}
      className={join(
        "group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 items-center rounded-xl border border-border bg-app-raised-bg text-app-raised-fg transition-colors focus-within:ring-1 focus-within:ring-ring/50 data-[state=error]:border-destructive/40",
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

/** The file's icon, or a preview image with `variant="image"`. */
export function AttachmentMedia({
  className,
  variant = "icon",
  ...props
}: ComponentProps<"div"> & { variant?: "icon" | "image" }) {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={join(
        "relative flex aspect-square w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-foreground group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-md group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5",
        variant === "image" &&
          "opacity-60 group-data-[state=done]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover",
        className,
      )}
      {...props}
    />
  );
}

/** The name and the line under it. */
export function AttachmentContent({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-content"
      className={join("max-w-full min-w-0 flex-1 leading-tight", className)}
      {...props}
    />
  );
}

/** The file's name, cut with an ellipsis when it does not fit. */
export function AttachmentTitle({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-title"
      className={join(
        "block max-w-48 min-w-0 truncate font-medium group-data-[state=uploading]/attachment:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One line about the file. Put each fact in its own element and let the gap
 * separate them, rather than joining them with punctuation.
 */
export function AttachmentDescription({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-description"
      className={join(
        "mt-0.5 flex max-w-48 min-w-0 gap-2 truncate text-sm text-muted-foreground group-data-[state=error]/attachment:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

/** Where the chip's buttons sit. */
export function AttachmentActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-actions"
      className={join("relative flex shrink-0 items-center", className)}
      {...props}
    />
  );
}

/**
 * An icon button on the chip: the kit's ghost icon button, with a glyph one
 * step larger than its `icon-xs` size draws.
 * The caller names it with `aria-label`.
 */
export function AttachmentAction({
  className,
  type = "button",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  className?: string;
  "aria-label": string;
}) {
  return (
    <Button
      data-slot="attachment-action"
      type={type}
      variant="ghost"
      size="icon-xs"
      className={join(
        "[&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** A row of chips that scrolls sideways when it runs out of room. */
export function AttachmentGroup({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-group"
      className={join(
        "flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain py-1 *:data-[slot=attachment]:flex-none",
        className,
      )}
      {...props}
    />
  );
}
