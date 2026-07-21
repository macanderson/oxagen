// packages/oxagen/src/iam/index.ts — re-exports for the pure IAM resolver layer.
//
// Only pure, dep-free code lives here. The impure IAM runtime (DB reads,
// ClickHouse writes, access-request creation) lives in packages/iam.

export * from "./resolve";
export * from "./conditions";
export * from "./agent-run";
