Jewel-tone button; `gradient` is the single hero CTA per surface, `primary` the default action.

```jsx
<Button variant="gradient" startIcon={<Icon name="arrow-up" size={15} color="#fff" />}>Run agent</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="outline" size="sm">Filter</Button>
<Button variant="ghost" iconOnly><Icon name="more-horizontal" /></Button>
```

- `variant`: `primary` · `secondary` · `outline` · `ghost` · `destructive` · `gradient` · `link`
- `size`: `sm` (28px) · `md` (36px) · `lg` (44px); `iconOnly` makes it square
- `startIcon` / `endIcon` take any node (e.g. a Lucide `<Icon>`). Hover lifts 1px + brightens; press settles with a slight scale-down.
