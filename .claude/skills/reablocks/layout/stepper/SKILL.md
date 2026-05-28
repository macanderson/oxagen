# Stepper

Multi-step progress indicator with dot or numbered markers, optional labels, and animated appearance. Composed of Stepper and Step.

## Import

```tsx
import { Stepper, Step } from 'reablocks';
```

## Stepper Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `activeStep` | `number` | `0` | Currently active step (1-indexed: steps < activeStep are marked complete) |
| `variant` | `'default' \| 'numbered'` | `'default'` | Marker style (dots or numbered circles) |
| `continuous` | `boolean` | — | Show connector line after last step |
| `animated` | `boolean` | — | *(deprecated)* Animate step appearance |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation config |
| `className` | `string` | — | Container CSS classes |
| `theme` | `StepperTheme` | — | Per-instance theme override |

## Step Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `label` | `string` | — | Optional marker label (renders as pill badge) |
| `className` | `string` | — | Step content CSS classes |
| `children` | `ReactNode` | — | Step content |

## Basic Usage (Dots)

```tsx
<Stepper activeStep={2}>
  <Step>Step 1 content</Step>
  <Step>Step 2 content</Step>
  <Step>Step 3 content</Step>
</Stepper>
```

## Numbered

```tsx
<Stepper activeStep={2} variant="numbered">
  <Step>Create account</Step>
  <Step>Verify email</Step>
  <Step>Complete profile</Step>
</Stepper>
```

## With Labels

```tsx
<Stepper activeStep={2}>
  <Step label="Setup">Configure your project</Step>
  <Step label="Review">Review your settings</Step>
  <Step label="Deploy">Deploy to production</Step>
</Stepper>
```

Layout: CSS grid with `grid-cols-[min-content_1fr]` — markers on the left, content on the right, connected by a vertical border line.

## StepperTheme Interface

```typescript
interface StepperTheme {
  base: string;        // Container (grid)
  step: {
    base: {
      common: string;  // Connector line (border-l)
      dot: string;     // Dot variant offset
      circle: string;  // Circle/numbered variant offset
    };
    marker: {
      container: { common, dot, circle };
      base: string;    // Dot marker (rounded-full, bg)
      active: string;  // Active dot color
      label: {
        base: string;  // Label pill (flex, border, rounded, px/py)
        active: string; // Active label styling
      };
    };
    active: string;    // Active connector line color
    content: string;   // Step content (padding)
  };
}
```
