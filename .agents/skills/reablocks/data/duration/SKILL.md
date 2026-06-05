# Duration

Formats millisecond values into human-readable durations (ms, s, min, hr, day, month). Auto-pluralizes units. Also exports `formatDuration` utility function.

## Import

```tsx
import { Duration } from 'reablocks';
// or utility only
import { formatDuration } from 'reablocks';
```

## Duration Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `number \| string \| null \| undefined` | — | Duration in milliseconds |
| `emptyValue` | `string` | `'N/A'` | Displayed when value is null/undefined |
| `zeroValue` | `string` | `'0 ms'` | Displayed when value is 0 |

## Basic Usage

```tsx
<Duration value="125" />          {/* "125 ms" */}
<Duration value="1234567" />      {/* "20.58 mins" */}
<Duration value="123456789101" /> {/* "47.69 months" */}
```

## Scale

Values are formatted using these time units:
- `ms` (1), `s` (1000), `min` (60,000), `hr` (3,600,000), `day` (86,400,000), `month` (2,592,000,000)

## Zero and Empty

```tsx
<Duration value="0" />                              {/* "0 ms" */}
<Duration value="0" zeroValue="No value" />          {/* "No value" */}
<Duration value={null} />                            {/* "N/A" */}
<Duration value={null} emptyValue="Nothing to see" /> {/* "Nothing to see" */}
```

## formatDuration Utility

```tsx
import { formatDuration } from 'reablocks';

formatDuration(1234567);            // "20.58 mins"
formatDuration(null);               // ["N/A"]
formatDuration(0, 'N/A', '0 ms');   // "0 ms"
```
