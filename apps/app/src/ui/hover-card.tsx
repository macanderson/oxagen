"use client";
// shadcn's base-maia hover card (ADR-221), written from
// https://ui.shadcn.com/r/styles/base-maia/hover-card.json. Two changes from
// the registry: the popup fills with the app's raised colour over a blur, as
// every popup does (`menuSurface` in control-styles.ts), and the content can
// take an `anchor`, so one card can show beside any element without a
// trigger of its own (features/shell/cell-overflow.tsx).
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { cn } from "@/ui/cn";

const popoverSurface =
  "relative isolate rounded-2xl bg-app-raised-bg/55 dark:bg-app-raised-bg/70 text-app-raised-fg shadow-pop ring-1 ring-foreground/5 dark:ring-foreground/10 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-lg dark:before:backdrop-blur-2xl before:backdrop-saturate-150";

function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 4,
  anchor,
  collisionPadding,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "anchor"
    | "collisionPadding"
  >) {
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            popoverSurface,
            "z-50 w-72 origin-(--transform-origin) p-4 text-base outline-hidden duration-(--motion-micro) data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent };
