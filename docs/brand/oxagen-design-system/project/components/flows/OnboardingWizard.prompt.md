Multi-step onboarding flow: Stepper header, animated slide+fade transitions, Back/Continue controls.

```jsx
<OnboardingWizard
  onComplete={(data) => console.log(data)}
  steps={[
    { label: "Organization", render: ({ setData }) => <Input onChange={e => setData({ org: e.target.value })} /> },
    { label: "Connect source", render: ({ data, setData }) => <SourcePicker value={data.source} onChange={s => setData({ source: s })} /> },
    { label: "Done", render: () => <Success /> },
  ]}
/>
```

- Each step `render` receives `{ index, goNext, goBack, data, setData }`.
- Pair with `Stepper` (used internally) for the progress header. Requires framer-motion (`window.Motion`).
