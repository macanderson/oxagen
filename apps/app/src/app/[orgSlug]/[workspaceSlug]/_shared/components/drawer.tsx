"use client";

import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Drawer — Phase-0 slide-over primitive.
 *
 * Composes `@/components/ui/sheet` (Base UI Dialog under the hood), which
 * provides focus trap, ESC-to-close, and aria wiring for free.
 */
export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  side?: "right" | "left";
  children: React.ReactNode;
  className?: string;
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  side = "right",
  children,
  className,
}: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side={side} className={cn(className)}>
        {(title || description) && (
          <SheetHeader>
            {title && <SheetTitle>{title}</SheetTitle>}
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
        )}
        <SheetPanel>{children}</SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
