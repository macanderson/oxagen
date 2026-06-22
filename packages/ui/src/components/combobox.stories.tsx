import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
} from "./combobox";

const meta = {
  title: "Forms/Combobox",
  component: Combobox,
} satisfies Meta<typeof Combobox>;
export default meta;
// Combobox's root requires `children`; base the story on the component so
// render-only stories don't have to declare an `args` object.
type Story = StoryObj<typeof Combobox>;

const FRAMEWORKS = [
  "Next.js",
  "Remix",
  "Astro",
  "SvelteKit",
  "Nuxt",
  "SolidStart",
  "Qwik City",
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = React.useState<string | null>(null);
    return (
      <div className="w-64">
        <Combobox value={value} onValueChange={setValue}>
          <ComboboxTrigger className="w-full">
            <ComboboxValue placeholder="Select framework" />
          </ComboboxTrigger>
          <ComboboxPopup searchPlaceholder="Search frameworks…">
            {FRAMEWORKS.map((f) => (
              <ComboboxItem key={f} value={f}>
                {f}
              </ComboboxItem>
            ))}
          </ComboboxPopup>
        </Combobox>
      </div>
    );
  },
};
