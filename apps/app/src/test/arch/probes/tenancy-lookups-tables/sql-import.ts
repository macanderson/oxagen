import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";

export function anything() {
  return withSystemDb((tx) => tx.execute(sql`select * from auth.sessions`));
}
