// The steering repo contract (steering-repo-spec, Shared contract): paths,
// names, schemas, templates, and the settings baseline every steering repo
// lane builds on. Nothing here changes behavior on its own.
//
// Two modules stay out of this barrel because they touch the file system:
// `generate-schemas` and `fixture-repo`. Import them by their own subpath.
export * from "./agent";
export * from "./bundle";
export * from "./common";
export * from "./files";
export * from "./governance";
export * from "./health";
export * from "./json-schema";
export * from "./names";
export * from "./paths";
export * from "./promotion";
export * from "./record";
export * from "./reflection";
export * from "./schema-ids";
export * from "./schemas";
export * from "./settings-baseline";
export * from "./templates";
export * from "./tokens";
export * from "./toolbelt";
export * from "./workspace";
