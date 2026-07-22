// Re-exports for every schema domain. Drizzle picks tables up from this
// barrel for migration generation and type inference.
export * from "./_mixins";
export * from "./_schemas";

export * from "./org";
export * from "./auth";
export * from "./workspace";
export * from "./agent";
export * from "./workflow";
export * from "./chat";
export * from "./content";
export * from "./billing";
export * from "./reseller";
export * from "./security";
export * from "./iam";
export * from "./mcp";
export * from "./plugin";
export * from "./notification";
export * from "./privacy";
export * from "./ingestion";
export * from "./run-evidence-foundation";
export * from "./schema-registry";
export * from "./environments";
export * from "./ai";
export * from "./eval";
export * from "./cms";
export * from "./ratelimit";

// Relations must be exported for Drizzle to include them in the schema
export * from "../relations";
