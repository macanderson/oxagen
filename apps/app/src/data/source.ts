// Adapter selection (plan §4.5): the ONLY file that imports an adapter.
import "server-only";
import { liveSource } from "./adapters/live";
import type { DataSource } from "./ports";

/**
 * The data source every page reads through. Fixture data is for dev, Storybook
 * and e2e only: `next build` inlines NODE_ENV as "production", so the fixture
 * branch is constant-folded away and a production bundle never contains it.
 */
export async function dataSource(): Promise<DataSource> {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.MC_DATA === "fixture"
  ) {
    const { fixtureSource } = await import("./adapters/fixture");
    return fixtureSource;
  }
  return liveSource;
}
