import { describe, expect, it } from "vitest";
import * as agent from "./agent";
import * as bundle from "./bundle";
import * as common from "./common";
import * as files from "./files";
import * as governance from "./governance";
import * as health from "./health";
import * as barrel from "./index";
import * as jsonSchema from "./json-schema";
import * as names from "./names";
import * as paths from "./paths";
import * as promotion from "./promotion";
import * as record from "./record";
import * as reflection from "./reflection";
import * as schemaIds from "./schema-ids";
import * as schemas from "./schemas";
import * as settingsBaseline from "./settings-baseline";
import * as templates from "./templates";
import * as tokens from "./tokens";
import * as toolbelt from "./toolbelt";
import * as workspace from "./workspace";

const exported = barrel as Record<string, unknown>;

/** Each module the barrel re-exports, one of its names, and the module. */
const modules: [string, string, object][] = [
  ["agent", "agentSchema", agent],
  ["bundle", "bundleSchema", bundle],
  ["common", "lineageSchema", common],
  ["files", "readTomlFile", files],
  ["governance", "governanceSchema", governance],
  ["health", "repoHealthSchema", health],
  ["json-schema", "toJsonSchema", jsonSchema],
  ["names", "REQUIRED_CHECK_NAME", names],
  ["paths", "agentFilePath", paths],
  ["promotion", "promotionSchema", promotion],
  ["record", "RECORD_KINDS", record],
  ["reflection", "reflectionSchema", reflection],
  ["schema-ids", "SCHEMA_IDS", schemaIds],
  ["schemas", "STEERING_REPO_SCHEMAS", schemas],
  ["settings-baseline", "GITHUB_SETTINGS_BASELINE", settingsBaseline],
  ["templates", "renderManagedBlock", templates],
  ["tokens", "countTokens", tokens],
  ["toolbelt", "toolbeltSchema", toolbelt],
  ["workspace", "workspaceSchema", workspace],
];

describe("steering repo barrel", () => {
  it.each(modules)(
    "re-exports every value of %s, such as %s",
    (_module, name, module) => {
      const values = module as Record<string, unknown>;
      expect(values[name]).toBeDefined();
      expect(exported[name]).toBe(values[name]);
      for (const [key, value] of Object.entries(values)) {
        expect(exported[key], key).toBe(value);
      }
    },
  );

  it("exports nothing the modules do not, and drops no name", () => {
    const moduleKeys = new Set(
      modules.flatMap(([, , module]) => Object.keys(module)),
    );
    expect(Object.keys(exported).sort()).toEqual([...moduleKeys].sort());
  });

  it("leaves out the fixture repo, which touches the file system", () => {
    expect("fixtureRepo" in exported).toBe(false);
  });
});
