import { schema, withSystemDb } from "@oxagen/database";

export function sessions() {
  const { sessions: table } = schema;
  return withSystemDb((tx) => tx.select().from(table));
}
