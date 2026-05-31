/**
 * Chat component registry — maps capability component IDs to lazily-loaded
 * React components. The stream route emits a "component" event containing a
 * `componentId`; the message bubble dispatches to this registry.
 *
 * IDs are stable contracts. Never rename a key without a migration —
 * persisted content_blocks rows reference them by string.
 *
 * The files under registry-components/ are stub implementations supplied by
 * the R agent. The M agent (svg-preview, image-preview, install-instructions)
 * and V agent (make-video-form) replace them with full implementations.
 */
import { lazy, type LazyExoticComponent } from "react";

// LazyExoticComponent is generic over component props. We widen to a common
// props shape for the registry map — consumers spread `block.props` which is
// typed as `Record<string, unknown>` in the content block.
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
export const CHAT_COMPONENTS: Record<string, AnyLazy> = {
  "svg-preview": lazy(
    () => import("@/components/chat/registry-components/svg-preview"),
  ),
  "image-preview": lazy(
    () => import("@/components/chat/registry-components/image-preview"),
  ),
  "install-instructions": lazy(
    () => import("@/components/chat/registry-components/install-instructions"),
  ),
  "make-video-form": lazy(
    () => import("@/components/chat/registry-components/make-video-form"),
  ),
} as const;
