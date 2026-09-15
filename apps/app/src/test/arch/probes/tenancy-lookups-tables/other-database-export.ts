import { db, schema } from "@oxagen/database";

export function organizations() {
  return db().select().from(schema.organizations);
}
