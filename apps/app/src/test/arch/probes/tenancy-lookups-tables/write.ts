import { schema, withSystemDb } from "@oxagen/database";

export function join(orgId: string, userId: string) {
  return withSystemDb((tx) =>
    tx.insert(schema.orgUsers).values({ orgId, userId, role: "owner" }),
  );
}
