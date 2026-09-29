// record-effect.ts: a constraint's effect. It imports only zod, so a
// capability contract can name an effect without pulling the YAML reader in
// record.ts into the eager contracts graph (skill-frontmatter.test.ts).
// record.ts re-exports both names.
import { z } from "zod";

/** A constraint's effect. `allow` does not exist: a record never grants authority. */
export const recordEffectSchema = z.enum(["require", "forbid"]);
export type RecordEffect = z.output<typeof recordEffectSchema>;
