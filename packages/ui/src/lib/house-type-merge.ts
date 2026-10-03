import type {
  ConfigExtension,
  DefaultClassGroupIds,
  DefaultThemeGroupIds,
} from "tailwind-merge";
import houseTypeUtilities from "./house-type-utilities.json";

/**
 * The tailwind-merge config every `cn()` in product builds on, through
 * `extendTailwindMerge(houseTypeMerge)`. It files the house type utilities
 * under `font-size`.
 *
 * tailwind-merge's default config does not know `text-a-h3` or `text-m-body`,
 * so it reads them as a text colour. A colour class such as `text-foreground`
 * in the same list then wins, and the size is dropped (oxageninc/brand#75,
 * #5185). In the `font-size` group, a house size conflicts only with another
 * size, such as `text-sm` or `text-a-h1`.
 *
 * The groups come from `house-type-utilities.json`, which the kit generates
 * from its type scales and the brand sync copies here. A step the kit adds,
 * such as `text-a-2xs` in kit 2.7.0, reaches `cn()` with the sync and needs
 * no edit in this file. `utils.test.ts` checks the list against every utility
 * `house-tailwind.css` defines.
 *
 * `packages/ui`, `apps/app`, and `apps/app_deprecated` each keep their own
 * `cn()`, so this one config is what keeps the three in step.
 */
export const houseTypeMerge: ConfigExtension<DefaultClassGroupIds, DefaultThemeGroupIds> = {
  extend: {
    classGroups: houseTypeUtilities.tailwind_merge,
  },
};
