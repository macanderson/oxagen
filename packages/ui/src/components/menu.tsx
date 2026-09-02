"use client";
import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Menu — coss ui menu built on Base UI `Menu` (replaces the shadcn/Radix-era
 * `DropdownMenu`).
 *
 *   <Menu>
 *     <MenuTrigger render={<Button variant="ghost" />}>Open</MenuTrigger>
 *     <MenuPopup>
 *       <MenuItem onClick={...}>Item</MenuItem>
 *     </MenuPopup>
 *   </Menu>
 *
 * Composition uses Base UI's `render` prop (not `asChild`); items use the
 * native `onClick` (not `onSelect`). Base UI closes the menu on click.
 */
const Menu = MenuPrimitive.Root;
const MenuGroup = MenuPrimitive.Group;
const MenuPortal = MenuPrimitive.Portal;
const MenuRadioGroup = MenuPrimitive.RadioGroup;
const MenuSub = MenuPrimitive.SubmenuRoot;
const MenuTrigger = MenuPrimitive.Trigger;

interface MenuPopupProps
  extends React.ComponentPropsWithoutRef<typeof MenuPrimitive.Popup> {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** Forwarded to Base UI `Menu.Portal` (e.g. `keepMounted`, custom `container`). */
  portalProps?: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Portal>;
}

const MenuPopup = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Popup>,
  MenuPopupProps
>(
  (
    { className, sideOffset = 4, align = "start", side, portalProps, ...props },
    ref,
  ) => (
    <MenuPrimitive.Portal {...portalProps}>
      <MenuPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="z-50"
      >
        <MenuPrimitive.Popup
          ref={ref}
          className={cn(
            "z-50 min-w-[8rem] overflow-hidden rounded-lg border border-menu-popup-border bg-menu-popup-bg p-1 text-menu-popup-fg",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:-translate-y-1",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  ),
);
MenuPopup.displayName = "MenuPopup";

interface MenuItemProps
  extends React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> {
  inset?: boolean;
  /** `destructive` inks the item with the error token (delete/remove actions). */
  variant?: "default" | "destructive";
}

const MenuItem = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Item>,
  MenuItemProps
>(({ className, inset, variant = "default", ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-menu-item-fg outline-none transition-colors data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg data-[disabled]:pointer-events-none data-[disabled]:text-menu-item-disabled-fg [&_svg]:size-4 [&_svg]:shrink-0",
      variant === "destructive" &&
        "text-error data-[highlighted]:bg-error/10 data-[highlighted]:text-error [&_svg]:text-error",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
MenuItem.displayName = "MenuItem";

const MenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-menu-item-fg outline-none transition-colors data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg data-[disabled]:pointer-events-none data-[disabled]:text-menu-item-disabled-fg",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <MenuPrimitive.CheckboxItemIndicator>
        <Check className="h-4 w-4" />
      </MenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>
));
MenuCheckboxItem.displayName = "MenuCheckboxItem";

const MenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-menu-item-fg outline-none transition-colors data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg data-[disabled]:pointer-events-none data-[disabled]:text-menu-item-disabled-fg",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <MenuPrimitive.RadioItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </MenuPrimitive.RadioItemIndicator>
    </span>
    {children}
  </MenuPrimitive.RadioItem>
));
MenuRadioItem.displayName = "MenuRadioItem";

/**
 * MenuGroupLabel — standalone, non-interactive label inside a menu popup. This
 * is the coss equivalent of shadcn's `DropdownMenuLabel` (a plain styled `div`),
 * NOT Base UI's `Menu.GroupLabel` — the latter throws "MenuGroupContext is
 * missing" unless wrapped in a `<Menu.Group>`/`<Menu.RadioGroup>`. Use this for
 * headers and section titles that aren't bound to a specific group. If you need
 * a label that's ARIA-associated with a group, render it inside `<MenuGroup>`;
 * the styling still applies.
 */
const MenuGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <div
    ref={ref}
    role="presentation"
    className={cn(
      "px-2 py-1.5 text-sm font-semibold text-menu-group-label-fg",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
MenuGroupLabel.displayName = "MenuGroupLabel";

const MenuSeparator = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-menu-separator", className)}
    {...props}
  />
));
MenuSeparator.displayName = "MenuSeparator";

function MenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  );
}
MenuShortcut.displayName = "MenuShortcut";

const MenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.SubmenuTrigger>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubmenuTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <MenuPrimitive.SubmenuTrigger
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg data-[popup-open]:bg-menu-item-highlighted-bg",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </MenuPrimitive.SubmenuTrigger>
));
MenuSubTrigger.displayName = "MenuSubTrigger";

const MenuSubPopup = React.forwardRef<
  React.ComponentRef<typeof MenuPrimitive.Popup>,
  MenuPopupProps
>(
  (
    { className, sideOffset = 0, align = "start", side, portalProps, ...props },
    ref,
  ) => (
    <MenuPrimitive.Portal {...portalProps}>
      <MenuPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="z-50"
      >
        <MenuPrimitive.Popup
          ref={ref}
          className={cn(
            "z-50 min-w-[8rem] overflow-hidden rounded-lg border border-menu-popup-border bg-menu-popup-bg p-1 text-menu-popup-fg",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:-translate-y-1",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  ),
);
MenuSubPopup.displayName = "MenuSubPopup";

export {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
  MenuGroup,
  MenuPortal,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
};
