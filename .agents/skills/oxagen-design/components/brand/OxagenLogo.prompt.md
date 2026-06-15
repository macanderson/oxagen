The Oxagen logo system. The mark is a thick circle outline ("O") stroked in the nebula gradient; the wordmark is "Oxagen" in Aeonik Fono. Lockups combine them.

```jsx
<OxagenLogo variant="horizontal" size={28} />              {/* ring + wordmark */}
<OxagenLogo variant="vertical" size={64} />                {/* stacked, centered */}
<OxagenLogo variant="mark" size={40} />                    {/* ring only */}
<OxagenLogo variant="wordmark" tone="mono-light" size={24} />
```

- `variant`: `mark` · `wordmark` · `horizontal` (default) · `vertical`
- `tone`: `gradient` (default) · `mono-light` (#F4F6FB, on dark) · `mono-dark` (#0F0E15, on light) · `solid` (currentColor)
- `size` = mark height in px. Aeonik Fono is used ONLY in the wordmark.
