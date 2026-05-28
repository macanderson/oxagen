"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface BranchSwitcherProps {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function BranchSwitcher({ index, total, onPrev, onNext }: BranchSwitcherProps) {
  if (total <= 1) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-xs">
      <Button variant="ghost" size="sm" onClick={onPrev} disabled={index === 0}>
        <ChevronLeft className="h-3 w-3" />
      </Button>
      <span className="tabular-nums text-muted-foreground">
        {index + 1} / {total}
      </span>
      <Button variant="ghost" size="sm" onClick={onNext} disabled={index === total - 1}>
        <ChevronRight className="h-3 w-3" />
      </Button>
    </div>
  );
}
