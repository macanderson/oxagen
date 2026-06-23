// Ambient CSS module declaration — allows `import "…/something.css"` side-effect
// imports (e.g. react-easy-crop) to type-check without requiring css-modules setup.
declare module "*.css" {
  const styles: Record<string, string>;
  export default styles;
}

// Ambient typing for the User-Agent Client Hints API (`navigator.userAgentData`),
// which is not yet part of TypeScript's built-in DOM lib. We only read
// `platform` (to detect macOS for the ⌘K vs Ctrl+K hint), so the minimal
// surface is declared here. `navigator.platform` is deprecated; `userAgentData`
// is its modern replacement.
// https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData

interface NavigatorUAData {
  readonly platform: string;
}

interface Navigator {
  /** User-Agent Client Hints — present in Chromium-based browsers only. */
  readonly userAgentData?: NavigatorUAData;
}
