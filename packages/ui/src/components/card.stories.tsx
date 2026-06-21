import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
  CardFooter,
} from "./card";
import { Button } from "./button";

const meta = {
  title: "Surfaces/Card",
  component: Card,
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Create project</CardTitle>
        <CardDescription>Deploy your new project in one click.</CardDescription>
      </CardHeader>
      <CardPanel>
        <p className="text-sm text-muted-foreground">
          Card body content lives inside <code>CardPanel</code> — the coss ui
          body wrapper (replaces shadcn <code>CardContent</code>).
        </p>
      </CardPanel>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost">Cancel</Button>
        <Button>Deploy</Button>
      </CardFooter>
    </Card>
  ),
};
