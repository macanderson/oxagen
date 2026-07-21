export * from "./types";
export * from "./pipeline";
export * from "./filters";
export {
  registerConnector,
  getConnector,
  listConnectors,
} from "./connectors/types";
export type {
  ConnectorDefinition,
  AuthCredential,
  AuthScheme,
  DeliveryMethod,
  RecordTypeSample,
  NormalizedRecord,
  RawRecord,
} from "./connectors/types";

// Auto-register all built-in connectors.
import "./connectors/github/index";
import "./connectors/google/drive";
import "./connectors/google/calendar";
import "./connectors/google/gmail";
import "./connectors/google/contacts";
import "./connectors/google/bigquery";
import "./connectors/google/meet";
import "./connectors/google/tasks";
import "./connectors/zoom/index";
import "./connectors/linear/index";
import "./connectors/slack/index";
import "./connectors/salesforce/index";
import "./connectors/microsoft/index";
import "./connectors/custom-sql/index";
import "./connectors/custom-webhook/index";
