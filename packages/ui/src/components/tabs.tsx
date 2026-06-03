"use client";
import * as React from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva("group/list inline-flex items-center text-muted-foreground", {
  variants: {
    variant: {
      default: "h-9 justify-center rounded-lg bg-muted p-1",
      underline: "justify-start gap-4 border-b border-border",
    },
  },
  defaultVariants: { variant: "default" },
});

interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = "default", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-variant={variant}
    className={cn(tabsListVariants({ variant }), className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

/** coss ui tab control (replaces the shadcn `TabsTrigger` name). */
const TabsTab = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Tab>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Tab
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
      // Default (pill) list treatment.
      "group-data-[variant=default]/list:rounded-md group-data-[variant=default]/list:px-3 group-data-[variant=default]/list:py-1 group-data-[variant=default]/list:data-[selected]:bg-background group-data-[variant=default]/list:data-[selected]:text-foreground group-data-[variant=default]/list:data-[selected]:shadow",
      // Underline list treatment.
      "group-data-[variant=underline]/list:-mb-px group-data-[variant=underline]/list:border-b-2 group-data-[variant=underline]/list:border-transparent group-data-[variant=underline]/list:px-1 group-data-[variant=underline]/list:py-2 group-data-[variant=underline]/list:data-[selected]:border-foreground group-data-[variant=underline]/list:data-[selected]:text-foreground",
      className,
    )}
    {...props}
  />
));
TabsTab.displayName = "TabsTab";

/** coss ui tab panel (replaces the shadcn `TabsContent` name). */
const TabsPanel = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Panel>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Panel
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsPanel.displayName = "TabsPanel";

export { Tabs, TabsList, TabsTab, TabsPanel };
