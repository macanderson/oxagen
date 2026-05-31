// packages/iam/src/index.ts — @oxagen/iam public surface.
//
// The impure IAM enforcement runtime: DB reads, ClickHouse writes, and
// access-request creation. Depends on @oxagen/database and @oxagen/telemetry.
// The pure IAM resolver lives in @oxagen/oxagen/iam (dep-light).

export { denial, isDenial } from "./denial.js";
export type { DenialResponse } from "./denial.js";

export { fetchAuthz } from "./fetch-authz.js";
export type { AuthzData, FetchAuthzArgs } from "./fetch-authz.js";

export { emitAudit } from "./emit-audit.js";
export type { EmitAuditArgs } from "./emit-audit.js";

export { checkIAM } from "./check-iam.js";
export type { CheckIAMArgs, CheckIAMResult } from "./check-iam.js";

export { createAccessRequest } from "./access-request.js";
export type { CreateAccessRequestArgs } from "./access-request.js";

export { bootstrapIAMRuntime } from "./bootstrap.js";
