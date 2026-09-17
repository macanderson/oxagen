import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";

export function connections(orgId: string) {
  return withSystemDb((tx) =>
    tx
      .select()
      .from(schema.sourceConnections)
      .where(eq(schema.sourceConnections.orgId, orgId)),
  );
}
