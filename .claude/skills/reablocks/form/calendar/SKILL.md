# Calendar

Date picker calendar with day/month/year views, range selection, time picker, presets, min/max constraints, and animated transitions. Built on date-fns and Framer Motion.

## Import

```tsx
import { Calendar } from 'reablocks';
```

## Calendar Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `Date \| [Date, Date] \| undefined` | — | Selected date(s) |
| `min` | `Date` | — | Minimum selectable date |
| `max` | `Date \| 'now'` | — | Maximum selectable date (`'now'` for current date) |
| `disabled` | `boolean` | — | Disable the calendar |
| `isRange` | `boolean` | — | Enable range selection mode |
| `showDayOfWeek` | `boolean` | — | Show day-of-week labels |
| `showToday` | `boolean` | — | Highlight today's date |
| `showTime` | `boolean` | `false` | Show time picker alongside calendar |
| `is12HourCycle` | `boolean` | `false` | Use 12-hour format for time picker |
| `animated` | `boolean` | `true` | Enable view transition animations |
| `animation` | `MotionNodeAnimationOptions` | — | Custom animation for day transitions |
| `animationViewChange` | `MotionNodeAnimationOptions` | — | Custom animation for view changes |
| `preset` | `PresetOption[]` | — | Preset date options (quick filters) |
| `previousArrow` | `ReactNode \| string` | `'‹'` | Previous button content |
| `nextArrow` | `ReactNode \| string` | `'›'` | Next button content |
| `onChange` | `(value: Date \| [Date, Date]) => void` | — | Date selection handler |
| `onViewChange` | `(view: CalendarViewType) => void` | — | View change callback |
| `theme` | `CalendarTheme` | — | Per-instance theme override |

## CalendarViewType

The calendar cycles through views: `'days'` → `'months'` → `'years'` (click header to drill up).

## Basic Usage

```tsx
const [date, setDate] = useState(new Date());
<Calendar value={date} onChange={setDate} showDayOfWeek />
```

## Range Selection

```tsx
const [range, setRange] = useState<[Date, Date]>([startDate, endDate]);
<Calendar value={range} isRange onChange={setRange} showDayOfWeek />
```

## With Time Picker

```tsx
<Calendar value={date} showTime onChange={setDate} />
<Calendar value={date} showTime is12HourCycle onChange={setDate} />
```

## Min/Max Constraints

```tsx
<Calendar value={date} min={new Date('2024-01-01')} max="now" onChange={setDate} />
```

## Presets

```tsx
const presets: PresetOption[] = [
  { label: 'Today', value: new Date() },
  { label: 'Last 7 days', value: () => [subDays(new Date(), 7), new Date()] },
  { label: 'Last 30 days', value: () => [subDays(new Date(), 30), new Date()] }
];

<Calendar value={date} preset={presets} isRange onChange={setDate} />
```

`PresetOption` has `{ label: string; value: Date | [Date, Date] | (() => Date | [Date, Date]) }`.
