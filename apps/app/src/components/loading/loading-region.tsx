import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn(className)}>
      {children}
    </div>
  );
}
