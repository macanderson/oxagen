# DateInput

Text input with calendar popup for date selection. Supports single dates and date ranges with optional preset quick filters. Built on Input, Calendar, and Menu components.

## Import

```tsx
import { DateInput } from 'reablocks';
```

## DateInput Props

Extends Input props (except `value` and `onChange`), plus:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `Date` (single) or `[Date, Date]` (range) | — | Selected date(s) |
| `onChange` | `(value: Date) => void` or `(value: [Date, Date]) => void` | — | Date change handler |
| `isRange` | `boolean` | `false` | Enable range mode |
| `format` | `string` | `'MM/dd/yyyy'` | date-fns format string for display/parsing |
| `placement` | `Placement` | `'bottom-start'` | Calendar popup placement |
| `openOnFocus` | `boolean` | `true` | Open calendar when input is focused |
| `preset` | `PresetOption[]` | `[]` | Preset date options (shows list before calendar) |
| `openCalendarOptionName` | `string` | `'Custom Date'` / `'Custom Dates'` | Label for the "open calendar" option in preset list |
| `icon` | `ReactElement` | `<CalendarIcon />` | Icon for the calendar button |
| `theme` | `DateInputTheme` | — | Per-instance theme override |

## Single Date

```tsx
const [date, setDate] = useState(new Date());
<DateInput value={date} onChange={setDate} />
```

## Date Range

```tsx
const [range, setRange] = useState<[Date, Date]>([startDate, endDate]);
<DateInput value={range} isRange onChange={setRange} />
```

## With Presets

```tsx
const presets: PresetOption[] = [
  { label: 'Today', value: new Date() },
  { label: 'Last 7 days', value: () => [subDays(new Date(), 7), new Date()] }
];

<DateInput value={date} preset={presets} onChange={setDate} />
```

When presets are provided, a list of options is shown first. Selecting "Custom Date" opens the full calendar.

## Custom Format

```tsx
<DateInput value={date} format="yyyy-MM-dd" onChange={setDate} />
```

The input placeholder automatically shows the format in uppercase (e.g. `MM/DD/YYYY`). Users can type dates directly — the input parses them using the format string.
