// The fixture seed: the mockup's demo record, mapped to spec vocabulary and
// parsed through every view-model contract once, at load.
import raw from "./raw/mc-baseline-w1.json";
import * as markup from "./raw/markup-rows";
import { mapSeed } from "./mapping";
import { Seed } from "./seed-schema";

export const seed: Seed = Seed.parse(mapSeed(raw, markup));
