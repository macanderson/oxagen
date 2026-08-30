"use client";
import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/utils";
import { Input, type InputProps } from "./input";

/*
 * SearchInput — Input with a leading search glyph and an optional clear
 * affordance. Replaces the absolutely-positioned-icon boilerplate repeated
 * across catalogs, graph views, and marketplace panels.
 *
 *   <SearchInput value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")} />
 */
export interface SearchInputProps extends Omit<InputProps, "type"> {
  /** Shows an X button when there is a value; called on click. */
  onClear?: () => void;
  /** Class for the wrapping element (the Input itself takes `className`). */
  containerClassName?: string;
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, containerClassName, onClear, value, ...props }, ref) => {
    const showClear = Boolean(onClear) && value != null && value !== "";
    return (
      <div className={cn("relative", containerClassName)}>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={ref}
          type="search"
          value={value}
          className={cn(
            "pl-8 [&::-webkit-search-cancel-button]:appearance-none",
            showClear && "pr-8",
            className,
          )}
          {...props}
        />
        {showClear && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={onClear}
            className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-[var(--motion-micro)] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";

export { SearchInput };
