// Storybook's preview imports the app's global stylesheet for its side effect;
// Next's own ambient CSS declarations live in next-env.d.ts, which this
// config does not include.
declare module "*.css";
