/**
 * Chat component registry — maps capability component IDs to lazily-loaded
 * React components. The stream route emits a "component" event containing a
 * `componentId`; the message bubble dispatches to this registry.
 *
 * IDs are stable contracts. Never rename a key without a migration —
 * persisted content_blocks rows reference them by string.
 *
 * Files at registry-components/* are created by the M/V agents in this run.
 * The @ts-expect-error directives silence "module not found" until those files
 * land; the final gate validates once they exist.
 */
import { lazy, type LazyExoticComponent } from "react";

// LazyExoticComponent is generic over its props; widening to
// Record<string, unknown> is the correct type for a heterogeneous registry map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLazy = LazyExoticComponent<(props: any) => React.ReactElement | null>;

/**
 * Registry keyed by componentId string. All entries are React.lazy so the
 * component bundle is only loaded the first time a matching event arrives.
 *
 * Contract ids (REGISTRY_CONTRACT):
 *   "svg-preview"          — renders an inline SVG string or data-URL (M agent)
 *   "image-preview"        — renders a generated / fetched image (M agent)
 *   "install-instructions" — renders a copy-able installation step block (M agent)
 *   "make-video-form"      — renders the make-a-video request form (V agent)
 */
// The registry-components/* files are created by the M/V agents in this run.
// Each @ts-ignore silences "cannot find module" until those files land.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
export const CHAT_COMPONENTS: Record<string, AnyLazy> = {
  // @ts-ignore — file created by M agent; remove after merge
  "svg-preview": lazy(() => import("@/components/chat/registry-components/svg-preview")),
  // @ts-ignore — file created by M agent; remove after merge
  "image-preview": lazy(() => import("@/components/chat/registry-components/image-preview")),
  // @ts-ignore — file created by M agent; remove after merge
  "install-instructions": lazy(() => import("@/components/chat/registry-components/install-instructions")), // eslint-disable-line
  // @ts-ignore — file created by V agent; remove after merge
  "make-video-form": lazy(() => import("@/components/chat/registry-components/make-video-form")),
} as const;
/* eslint-enable @typescript-eslint/no-unsafe-assignment */
