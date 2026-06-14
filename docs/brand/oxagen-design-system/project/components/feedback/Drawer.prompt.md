Edge-anchored sliding panel with scrim and spring slide. Controlled via `open`/`onClose`.

```jsx
const [open, setOpen] = React.useState(false);
<Drawer open={open} onClose={() => setOpen(false)} side="right" title="Edge details"
  footer={<><Button variant="ghost">Deny</Button><Button variant="primary">Approve</Button></>}>
  …body…
</Drawer>
```

- `side`: `right` (default) · `left` · `bottom`; `size` = width or height in px. Esc closes.
- Requires framer-motion loaded as `window.Motion` for animation (degrades to instant otherwise).
