"use client";
// shadcn's base-maia message scroller (ADR-221), written from
// https://ui.shadcn.com/r/styles/base-maia/message-scroller.json over
// `@shadcn/react/message-scroller`. It keeps a conversation where a reader
// expects it: a new question lands at the top with the reply growing under it,
// a restored thread opens at its last question, and a button returns to the
// newest message once the reader has scrolled away.
//
// Five changes from the registry. The viewport drops `scroll-fade-b` and the
// `scrollbar-*` utilities, which the app does not define. The button keeps
// the `secondary` variant's house colours rather than overriding them with
// `bg-background`, is centred with `left-1/2`, which needs no right-to-left
// correction, and draws Phosphor's arrow. Its label is required and arrives
// translated (INV-12), where the registry falls back to "Scroll to end". Only
// the parts the app draws are exported, so the three hooks are not.
import { ArrowDownIcon } from "@phosphor-icons/react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import type { ComponentProps } from "react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/cn";

const MessageScrollerProvider = MessageScrollerPrimitive.Provider;

function MessageScroller({
  className,
  ...props
}: ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-8", className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "min-w-0 shrink-0 lazy-render",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Returns the reader to the newest message. It shows only while the newest
 * message is out of view; otherwise it is inert and out of the tab order.
 */
function MessageScrollerButton({
  label,
  className,
  ...props
}: Omit<
  ComponentProps<typeof MessageScrollerPrimitive.Button>,
  "children" | "direction" | "render"
> & {
  /** The button's name: "Scroll to the newest message". */
  label: string;
}) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      direction="end"
      className={cn(
        "absolute bottom-4 left-1/2 -translate-x-1/2 shadow-sm transition duration-(--motion-overlay) data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-(--motion-entry) data-[active=false]:ease-(--ease-exit) data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-(--ease-entry)",
        className,
      )}
      render={<Button variant="secondary" size="icon-sm" />}
      {...props}
    >
      <ArrowDownIcon aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
};
