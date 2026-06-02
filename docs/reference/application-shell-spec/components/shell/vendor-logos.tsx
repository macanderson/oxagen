import type { Vendor } from "@/lib/models"
import { cn } from "@/lib/utils"

type LogoProps = { className?: string }

/**
 * Simplified, monochrome vendor logomarks rendered with currentColor so they
 * adapt to light/dark themes. These are brand identifiers for the model picker.
 */

function Anthropic({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M14.5 4h-3L6 20h3.2l1.1-3.4h5.4L16.8 20H20L14.5 4Zm-3.3 9.9 1.8-5.5 1.8 5.5h-3.6Z" />
    </svg>
  )
}

function OpenAI({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3.5 19 7.5v9L12 20.5 5 16.5v-9l7-4Z" strokeLinejoin="round" />
      <path d="M12 3.5v8.5l7 4M12 12 5 16M12 12v8.5" />
    </svg>
  )
}

function Google({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" strokeLinecap="round" />
      <path d="M12 12h8" strokeLinecap="round" />
    </svg>
  )
}

function Xai({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m5 5 14 14M19 5 5 19" strokeLinecap="round" />
    </svg>
  )
}

function Meta({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path
        d="M4 15c1.6 0 2.8-1.2 4-3.6C9.3 8.8 10.3 7 12 7s2.7 1.8 4 4.4C17.2 13.8 18.4 15 20 15"
        strokeLinecap="round"
      />
      <path d="M4 15c-.9 0-1.6-.8-1.6-2S3.1 9 4 9s1.8 1.4 3.2 3.6M20 15c.9 0 1.6-.8 1.6-2S20.9 9 20 9s-1.8 1.4-3.2 3.6" strokeLinecap="round" />
    </svg>
  )
}

function Mistral({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M4 5h3v3H4V5Zm13 0h3v3h-3V5ZM4 8h3v3H4V8Zm6 0h4v3h-4V8Zm7 0h3v3h-3V8ZM4 11h16v3H4v-3Zm0 3h3v5H4v-5Zm13 0h3v5h-3v-5Z" />
    </svg>
  )
}

function DeepSeek({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 9c3 0 4 2.5 7 2.5S17 8 20 8c-1 4-4.5 7-8 7S5 12 4 9Z" strokeLinejoin="round" />
      <circle cx="15" cy="10.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BFL({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 3 4 8v8l8 5 8-5V8l-8-5Z" strokeLinejoin="round" />
      <path d="m8 10 4 2.4L16 10M12 12.4V17" strokeLinejoin="round" />
    </svg>
  )
}

const map: Record<Vendor, (p: LogoProps) => React.ReactElement> = {
  anthropic: Anthropic,
  openai: OpenAI,
  google: Google,
  xai: Xai,
  meta: Meta,
  mistral: Mistral,
  deepseek: DeepSeek,
  bfl: BFL,
}

export function VendorLogo({ vendor, className }: { vendor: Vendor; className?: string }) {
  const Cmp = map[vendor]
  return <Cmp className={cn("size-full", className)} />
}

/** A bordered square tile housing a vendor logomark. Defaults to 24px. */
export function VendorTile({
  vendor,
  className,
}: {
  vendor: Vendor
  className?: string
}) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-[5px] border border-border bg-muted/50 text-foreground",
        className,
      )}
    >
      <VendorLogo vendor={vendor} className="size-4" />
    </span>
  )
}
