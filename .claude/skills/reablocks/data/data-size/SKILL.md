# DataSize

Formats byte values into human-readable sizes (B, KiB, MiB, GiB, etc.) using binary scale (1024). Also exports `formatSize` utility function.

## Import

```tsx
import { DataSize } from 'reablocks';
// or utility only
import { formatSize } from 'reablocks';
```

## DataSize Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `number \| string \| null \| undefined` | — | Byte value to format |
| `emptyValue` | `string` | `'N/A'` | Displayed when value is null/undefined |
| `scale` | `string[]` | `['B','KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB']` | Custom unit scale |
| `decimals` | `number` | `2` | Number of decimal places |

## Basic Usage

```tsx
<DataSize value="4500" />        {/* "4.39 KiB" */}
<DataSize value="34343233" />    {/* "32.75 MiB" */}
<DataSize value={434334434123} /> {/* "404.52 GiB" */}
```

## Custom Scale

```tsx
const scale = ['b', 'kb', 'mb', 'gb', 'tb', 'pb', 'eb', 'zb', 'yb'];
<DataSize value="4500" scale={scale} />  {/* "4.39 kb" */}
```

## Custom Decimals

```tsx
<DataSize value={34343233} decimals={0} />  {/* "33 MiB" */}
<DataSize value={34343233} decimals={5} />  {/* "32.74538 MiB" */}
```

## Empty Value

```tsx
<DataSize value={undefined} />                       {/* "N/A" */}
<DataSize value={null} emptyValue="Nothing to see" /> {/* "Nothing to see" */}
```

## formatSize Utility

```tsx
import { formatSize } from 'reablocks';

formatSize(4500);              // "4.39 KiB"
formatSize(null, 'N/A');       // ["N/A"]
formatSize(4500, 'N/A', ['B','KB','MB','GB'], 0); // custom scale + decimals
```
