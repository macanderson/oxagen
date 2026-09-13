/**
 * Shared route-level UI primitives (empty / error / loading blocks, section
 * and tile containers, and a drawer). Import the barrel, not the files:
 * `@/app/[orgSlug]/[workspaceSlug]/_shared/components`. Reuse — do not fork.
 */

export { EmptyState } from "./empty-state";
export type { EmptyStateProps } from "./empty-state";

export { ErrorState } from "./error-state";
export type { ErrorStateProps } from "./error-state";

export { LoadingState } from "./loading-state";
export type { LoadingStateProps } from "./loading-state";

export { Section } from "./section";
export type { SectionProps } from "./section";

export { Tile } from "./tile";
export type { TileProps } from "./tile";

export { Drawer } from "./drawer";
export type { DrawerProps } from "./drawer";
