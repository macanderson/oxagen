import type {
  ConfigExtension,
  DefaultClassGroupIds,
  DefaultThemeGroupIds,
} from "tailwind-merge";

/**
 * The steps of the two house type scales. `house-tailwind.css`, which the
 * brand sync copies from the kit, turns each one into a `text-m-<step>` and a
 * `text-a-<step>` utility. `utils.test.ts` fails when that file gains a step
 * this list lacks.
 */
const TYPE_STEPS = ["h1", "h2", "h3", "h4", "body", "micro"] as const;

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
 * `packages/ui`, `apps/app`, and `apps/app_deprecated` each keep their own
 * `cn()`, so this one list is what keeps the three in step.
 */
export const houseTypeMerge: ConfigExtension<DefaultClassGroupIds, DefaultThemeGroupIds> = {
  extend: {
    classGroups: {
      "font-size": [{ text: [{ a: TYPE_STEPS, m: TYPE_STEPS }] }],
    },
  },
};
