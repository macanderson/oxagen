// @oxagen/ingestion/collectors: the collector framework (agent-work-spec.html,
// Collectors). Each collector type is one module beside types.ts, registered
// in modules.ts. Everything else here is shared by all of them.
export * from "./types";
export * from "./registry";
export * from "./modules";
export * from "./file";
export * from "./cloudevent";
export * from "./health";
export * from "./pipeline";
export * from "./writeback";
export * from "./send-back";
export * from "./mirror";
