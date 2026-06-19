import "../src/app/globals.css";
import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    layout: "padded",
    controls: { expanded: true },
  },
};

export default preview;
