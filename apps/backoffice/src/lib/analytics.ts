import { type DateWindow } from './filters';
import { STAGES, isStageId, stageLabel } from './stages';
import type { BoardCard, StageId } from './types';

/**
 * The Analytics page's pure half: *what happened in each period*.
 *
 * A column is one **period** and its stack is that period's own activity: one segment per board
 * column, bottom-to-top in the board's own order (Scraped at the bottom, Offer on top), each
 * segment counting the entries the operator recorded *into* that column inside that period. The
 * axis is a count, so a quiet period and a busy one are different heights - these are daily
 * statistics, not a running picture of the board. Refusals and restores are counted beside the
 * stack rather than inside it (`refused`/`restored`): they are outcomes rather than funnel steps,
 * so they are read on hover and in the subtitle and never drawn.
 *
 * **Where a period's number comes from.** The board's cards carry their own audit trail
 * (`resume_history`: one row per confirmed change, `lib/db.ts::fetchHistory`), and that trail is the
 * only record of *when* a card changed column. Every entry is attributed to the bucket its own
 * timestamp falls in and to no other: the intake's row (`resumes.created_at`) is one entry into
 * Scraped on the day it was created, every `move` row is one entry into the column it moved into,
 * and `archive`/`restore` rows are counted as themselves. Nothing is stored twice and no second
 * source of board state is added, so this reading can never disagree with the board it reads.
 *
 * A period is a **local calendar day, ISO week or calendar month** - the same unit `cardMeta.ts`
 * dates a card by (`today`, `yesterday`, ...) - so "a day" means one thing in this app.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which period one column is: a local day, an ISO week (Monday-started) or a calendar month. */
export type Granularity = 'day' | 'week' | 'month';

/**
 * The aggregation the page offers, in the order the dropdown lists them. `day` is the finest and
 * therefore the default: the question the page answers is "what did I do that day".
 */
export const GRANULARITIES: { id: Granularity; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/**
 * Most columns the chart draws at once, per granularity.
 *
 * A column has to stay wide enough to hold its own number: past roughly this many the segments are
 * thinner than their labels and the picture stops being readable. `All time` on a board that goes
 * back months would be hundreds of columns, so the newest ones are kept, `bucketsFor` stops there
 * and `summarizeSeries` says so rather than dropping the start silently. The coarser the period,
 * the fewer columns are worth drawing - and the longer a window each of them stands for.
 */
export const MAX_BUCKETS: Record<Granularity, number> = { day: 90, week: 52, month: 24 };

/**
 * How much of a segment's colour survives while **another** segment is hovered - `diagram1.png`'s
 * rule, where the hovered stage keeps its colour and every other one fades to a tint. Expressed as
 * a blend toward white rather than an SVG opacity, so a faded segment composites the same way in
 * every browser and the white panel behind it shows through consistently.
 */
export const FADED_FILL = 0.85;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The next local midnight - `Date` arithmetic, so a DST day is 23 or 25 hours long, not 24. */
function nextMidnight(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** `2026-10-12` in the operator's own zone - the bucket's name, never a timestamp. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `12 Oct` - a day's own label, for the axis and the hover caption. */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/** `Week of 5 Oct` - a week is named by the Monday it starts on, never by an ISO number. */
export function weekLabel(day: string): string {
  return `Week of ${dayLabel(day)}`;
}

/** `Oct 2026` - a month's own label. */
export function monthLabel(day: string): string {
  const [year, month] = day.split('-').map(Number);
  if (!year || !month) return day;
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

/** The label a bucket's key carries, in the granularity that produced it. */
export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === 'week') return weekLabel(key);
  if (granularity === 'month') return monthLabel(key);
  return dayLabel(key);
}

/**
 * The local start of the ISO week a moment is in - Monday, the same week `filters.ts` weeks by.
 *
 * `Date` arithmetic through `addDays` rather than `- day * DAY_MS`: a week containing a DST change
 * is not seven times 24 hours, and a bucket bound an hour off midnight would file an entry into the
 * wrong week.
 */
function startOfWeek(ms: number): number {
  const date = new Date(ms);
  return addDays(startOfDay(ms), -((date.getDay() + 6) % 7));
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** The local start of the period `ms` falls in. */
function periodStart(ms: number, granularity: Granularity): number {
  if (granularity === 'week') return startOfWeek(ms);
  if (granularity === 'month') return startOfMonth(ms);
  return startOfDay(ms);
}

/**
 * The next period's start - `Date` arithmetic again, so a 23- or 25-hour DST day is still one day
 * and a month of 28 to 31 days is still one month.
 */
function nextPeriod(ms: number, granularity: Granularity): number {
  if (granularity === 'week') return addDays(ms, 7);
  if (granularity === 'month') {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  }
  return nextMidnight(ms);
}

/** How many periods `first`..`last` covers, both being period starts. */
function periodSpan(first: number, last: number, granularity: Granularity): number {
  if (granularity === 'week') return Math.round((last - first) / (7 * DAY_MS)) + 1;
  if (granularity === 'month') {
    const from = new Date(first);
    const to = new Date(last);
    return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;
  }
  return Math.round((last - first) / DAY_MS) + 1;
}

/** A period start shifted by whole periods - how the cap keeps the **newest** columns. */
function shiftPeriods(ms: number, periods: number, granularity: Granularity): number {
  if (granularity === 'week') return addDays(ms, periods * 7);
  if (granularity === 'month') {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth() + periods, 1).getTime();
  }
  return addDays(ms, periods);
}

/** One period the chart draws a column for. */
export interface AnalyticsBucket {
  /**
   * The bucket's name - `yyyy-mm-dd` of its own start, never a timestamp: `2026-10-12` for a day,
   * `2026-10-05` for the week starting that Monday, `2026-10-01` for October 2026. Unique inside one
   * granularity, sortable, and the chart's own `indexBy`.
   */
  key: string;
  /** `12 Oct` · `Week of 5 Oct` · `Oct 2026` - what the axis and the hover read. */
  label: string;
  /** Which period this is, so a caller never has to parse the key to label it again. */
  granularity: Granularity;
  /** Inclusive lower bound: the period's local start. */
  from: number;
  /** Exclusive upper bound: the next period's start. */
  to: number;
}

/**
 * The bounds the chart actually draws.
 *
 * `All time` has no lower bound and every other range has no upper one, and an unbounded axis
 * cannot be drawn - so an open end is closed against the data: the window starts at the earliest
 * day any card existed and ends at today. Pure, with `now` injected, like the board's `dateWindow`.
 * Both bounds keep `DateWindow`'s own meaning, so the upper one stays **exclusive**.
 */
export function resolveWindow(
  window: DateWindow,
  cards: BoardCard[],
  now: Date = new Date(),
): { from: number; to: number } {
  let earliest: number | null = null;
  for (const card of cards) {
    const at = Date.parse(card.createdAt);
    if (Number.isNaN(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  const to = window.to ?? now.getTime();
  return { from: window.from ?? earliest ?? to, to };
}

/**
 * One bucket per period the window `[from, to)` covers, in the requested granularity.
 *
 * `to` is **exclusive** - it is `filters.ts::dateWindow`'s upper bound, the same field the board's
 * own filter compares against (`at >= window.to` is outside it) - so the last column is the period
 * that bound falls *inside*, not the one it lands on. That is the difference between "Last week"
 * being its seven days and being eight: the range runs Monday 00:00 to Monday 00:00, and that second
 * Monday is not part of last week (an eighth Oct-12 column, fixed 2026-10-12).
 *
 * The last bucket's own `to` is the next period's start, so an entry recorded later today still
 * lands in today's column rather than being dropped. A window longer than `MAX_BUCKETS` (or a `from`
 * after its `to`) still returns something: the chart never has nothing to draw.
 */
export function bucketsFor(
  from: number,
  to: number,
  granularity: Granularity = 'day',
): AnalyticsBucket[] {
  const first = periodStart(from, granularity);
  const last = periodStart(to - 1, granularity);
  const cap = MAX_BUCKETS[granularity];
  const start =
    periodSpan(first, last, granularity) > cap
      ? shiftPeriods(last, -(cap - 1), granularity)
      : first;

  const bucketAt = (cursor: number): AnalyticsBucket => {
    const key = dayKey(cursor);
    return {
      key,
      label: bucketLabel(key, granularity),
      granularity,
      from: cursor,
      to: nextPeriod(cursor, granularity),
    };
  };

  const buckets: AnalyticsBucket[] = [];
  for (let cursor = start; cursor <= last; cursor = nextPeriod(cursor, granularity)) {
    buckets.push(bucketAt(cursor));
  }
  if (buckets.length === 0) buckets.push(bucketAt(first));
  return buckets;
}

/**
 * The stages a card **entered inside** the bucket, oldest row first.
 *
 * Two things count as an entry: the intake created the row (`resumes.created_at` inside the bucket,
 * so a scraped or hand-typed vacancy lands in Scraped on the day it was created) and every confirmed
 * `move` row dated inside it that actually **changes** the column, which is the column it moved
 * *into*. `archive`/`restore` rows are not column entries - a refusal keeps its column (invariant 19)
 * - and `tailoring` rows mirror the worker's own statuses rather than the operator's funnel; both are
 * read separately (`refusalCounts`).
 *
 * A card can appear more than once in a bucket (two drags in one afternoon are two entries), and
 * never in two buckets: an entry belongs to the period its own timestamp falls in and to no other,
 * which is what makes these daily numbers rather than a running total. A `move` row the operator
 * later corrected or removed is simply not in the trail any more, so this follows the trail.
 */
export function stageEventsInBucket(card: BoardCard, bucket: AnalyticsBucket): StageId[] {
  const entered: StageId[] = [];
  const createdAt = Date.parse(card.createdAt);
  if (!Number.isNaN(createdAt) && createdAt >= bucket.from && createdAt < bucket.to) {
    entered.push('scraped');
  }
  for (const entry of card.history) {
    if (entry.kind !== 'move' || !isStageId(entry.to)) continue;
    // `from_state = to_state` is **activity, not a transition**. `lib/db.ts::recordCardActivity`
    // writes exactly that row for the *Add action* button and for every interview add/edit/remove,
    // and a drag into Prepare that retries tailoring writes it too: they move the card's clock - the
    // field that dates a card everywhere else (invariant 26) - and never its column. Counting them
    // drew two entries for one drag: the transition into Interviewing, plus the interview that was
    // scheduled on the card that afternoon (reported 2026-10-14).
    if (entry.from === entry.to) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at < bucket.from || at >= bucket.to) continue;
    entered.push(entry.to);
  }
  return entered;
}

/**
 * The refusals and restores a card recorded **inside** the bucket.
 *
 * These are the two readings the chart keeps beside its stack rather than in it: a refusal is an
 * outcome, not a funnel step, and stacking it above Offer would make a column's height stop meaning
 * "how much happened". They are per-period facts all the same, so they belong to the bucket their
 * own row is dated in - a refusal recorded today is today's, not the day the card was scraped.
 */
export function refusalCounts(
  card: BoardCard,
  bucket: AnalyticsBucket,
): { refused: number; restored: number } {
  let refused = 0;
  let restored = 0;
  for (const entry of card.history) {
    if (entry.kind !== 'archive' && entry.kind !== 'restore') continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at < bucket.from || at >= bucket.to) continue;
    if (entry.kind === 'archive') refused += 1;
    else restored += 1;
  }
  return { refused, restored };
}

export interface AnalyticsOptions {
  /**
   * Count refused vacancies' activity too. On by default: the entries a card recorded before it was
   * refused did happen, and a refusal is a fact about a vacancy rather than a column of its own.
   * Switched off it drops the refused cards' entries *and* the `refused`/`restored` counters - which
   * is what the page's own *Include refused* checkbox says.
   */
  includeArchived?: boolean;
}

export interface AnalyticsSeries {
  buckets: AnalyticsBucket[];
  /** One entry per column, **bottom-to-top in `STAGES` order** - Scraped is the bottom band. */
  stages: { stage: StageId; values: number[] }[];
  /** Everything recorded in the bucket: the six columns summed. The stack's own height. */
  totals: number[];
  /** The busiest bucket, for scaling the axis and for the empty state. */
  maxTotal: number;
  /** Refusals recorded in each bucket - counted **beside** the stack, never drawn in it. */
  refused: number[];
  /** Restores recorded in each bucket, likewise beside the stack. */
  restored: number[];
  /** The window's refusals, for the page's subtitle. */
  refusedTotal: number;
  /** The window's restores, for the page's subtitle. */
  restoredTotal: number;
}

/**
 * The per-period counts the diagram is drawn from.
 *
 * One pass per card and bucket, asking the trail what the card *entered* in that period. An entry
 * belongs to its own bucket only, so a move made on the 11th is the 11th's business and never
 * reappears on the 12th - which is the whole difference between this and a running picture of the
 * board. A period nobody touched a card in is a zero, and that zero is the answer.
 */
export function buildSeries(
  cards: BoardCard[],
  buckets: AnalyticsBucket[],
  options: AnalyticsOptions = {},
): AnalyticsSeries {
  const counted =
    options.includeArchived === false ? cards.filter((card) => !card.archived) : cards;

  const stages = STAGES.map((meta) => ({ stage: meta.id, values: buckets.map(() => 0) }));
  const rowOf = new Map(stages.map((serie, index) => [serie.stage, index]));
  const totals = buckets.map(() => 0);
  const refused = buckets.map(() => 0);
  const restored = buckets.map(() => 0);

  for (const card of counted) {
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      for (const stage of stageEventsInBucket(card, bucket)) {
        const row = rowOf.get(stage);
        if (row === undefined) continue;
        stages[row].values[index] += 1;
        totals[index] += 1;
      }
      const beside = refusalCounts(card, bucket);
      refused[index] += beside.refused;
      restored[index] += beside.restored;
    }
  }

  return {
    buckets,
    stages,
    totals,
    maxTotal: totals.reduce((max, total) => Math.max(max, total), 0),
    refused,
    restored,
    refusedTotal: refused.reduce((sum, count) => sum + count, 0),
    restoredTotal: restored.reduce((sum, count) => sum + count, 0),
  };
}

/**
 * One bucket's shares, in percent, **summing to exactly 100**.
 *
 * The axis counts entries now, so these are not what the chart stacks: they are what the segments'
 * second line prints (`share_<stage>`), because a label saying `3` with no share would leave the
 * operator dividing by the bucket's total in their head. The largest segment absorbs the rounding
 * residue, so the six printed shares add up to a whole bucket and never to 100.4%. A bucket with
 * nothing in it is all zeroes rather than six NaNs.
 */
export function sharePercents(values: number[], total: number): number[] {
  const shares = values.map(() => 0);
  if (total <= 0) return shares;
  let biggest = 0;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    shares[index] = (values[index] / total) * 100;
    sum += shares[index];
    if (values[index] > values[biggest]) biggest = index;
  }
  shares[biggest] += 100 - sum;
  return shares;
}

/**
 * One row per bucket, in the shape `@nivo/bar` draws.
 *
 * `bucket` is the index (`indexBy`) and its own `label` rides beside it, each **stage id** carries
 * that bucket's **count** - the stack, and therefore the axis' unit - and `share_<stage>` carries
 * that count's share of the bucket, which is what the segment's second line prints.
 * `refused`/`restored` are in the datum but deliberately **not** in `keys`: the chart stacks the
 * keys and nothing else, so the two outcomes stay readable on hover without ever adding to a
 * column's height.
 */
export interface MixRow extends Record<string, string | number> {
  /** The bucket's key (`yyyy-mm-dd` of its start), the chart's `indexBy`. */
  bucket: string;
  /** The bucket's label, so the tooltip and the axis need no key parsing. */
  label: string;
  /** Everything recorded in the bucket: the stack's height. */
  total: number;
  /** That bucket's refusals, read on hover - outside `keys`, so never stacked. */
  refused: number;
  /** That bucket's restores, likewise. */
  restored: number;
}

/**
 * **Every** stage key is written on **every** bucket, zeros included.
 *
 * The chart stacks `datum[key]`, so a missing key is `undefined` and an `undefined` segment is a
 * `NaN` height - the one way this picture could grow a hole. A bucket with nothing in a column is a
 * real zero, and this is where it is made explicit.
 */
export function mixRows(series: AnalyticsSeries): { data: MixRow[]; keys: StageId[] } {
  const keys = STAGES.map((meta) => meta.id);
  const data = series.buckets.map((bucket, index) => {
    const values = series.stages.map((serie) => serie.values[index] ?? 0);
    const total = series.totals[index] ?? 0;
    const shares = sharePercents(values, total);
    const row: Record<string, string | number> = {
      bucket: bucket.key,
      label: bucket.label,
      total,
      refused: series.refused[index] ?? 0,
      restored: series.restored[index] ?? 0,
    };
    series.stages.forEach((serie, position) => {
      row[serie.stage] = values[position] ?? 0;
      row[`share_${serie.stage}`] = shares[position] ?? 0;
    });
    return row as MixRow;
  });
  return { data, keys };
}

/**
 * The count axis: its top and its gridlines.
 *
 * The axis is not a fixed `0-100%` any more - with counts, three entries and sixty have to look
 * different - so the top is the busiest bucket rounded **up** to a readable step with equal
 * gridlines, and every tick is a whole number of entries (never `0.5`). A window with nothing in it
 * is `0`/`[0]`, which the chart reads as its empty state before it ever asks for an axis.
 */
export function countAxis(busiest: number): { max: number; ticks: number[] } {
  const top = Math.max(0, Math.ceil(busiest));
  if (top <= 0) return { max: 0, ticks: [0] };
  // A handful of entries needs no rounding at all: one tick per entry draws the busiest day at the
  // top of the panel instead of a quarter of the way up it, which is the common case for a board
  // only a few moves a day touch.
  if (top <= 4) return { max: top, ticks: Array.from({ length: top + 1 }, (_, value) => value) };
  const step = niceCountStep(top / 4);
  const max = step * 4;
  return { max, ticks: [0, step, step * 2, step * 3, max] };
}

/** The smallest whole number on the `1, 2, 3, 4, 5, 6, 8, 10, 20, …` ladder that is at least `value`. */
function niceCountStep(value: number): number {
  let magnitude = 1;
  while (magnitude * 10 <= value) magnitude *= 10;
  for (const candidate of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const step = candidate * magnitude;
    if (step >= value) return step;
  }
  return magnitude * 10;
}

/** The bucket keys the axis labels: every `n`-th one, always including the newest. */
export function tickValues(series: AnalyticsSeries, max = 12): string[] {
  const buckets = series.buckets;
  if (buckets.length === 0) return [];
  const step = Math.max(1, Math.ceil(buckets.length / max));
  const keys = buckets.filter((_, index) => index % step === 0).map((bucket) => bucket.key);
  const newest = buckets[buckets.length - 1].key;
  if (keys[keys.length - 1] !== newest) keys.push(newest);
  return keys;
}

/**
 * One colour per column, in the board's own hue family (`stages.ts`): a colour means the same
 * thing on the board and on the chart. These are hex values because they fill SVG paths, not
 * Tailwind class names - and Scraped/Prepare are a light and a dark grey deliberately, because
 * those two bands sit next to each other in the stack.
 */
export const STAGE_BAND_COLORS: Record<StageId, string> = {
  scraped: '#a1a1aa', // zinc-400
  prepare: '#475569', // slate-600
  applied: '#0ea5e9', // sky-500
  negotiating: '#f59e0b', // amber-500
  interviewing: '#8b5cf6', // violet-500
  offer: '#10b981', // emerald-500
};

export function bandColor(stage: string): string {
  return STAGE_BAND_COLORS[stage as StageId] ?? '#94a3b8';
}

/** `#rrggbb` blended toward white by `amount` (0 = as it is, 1 = white). */
export function fadeHex(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const ratio = Math.min(1, Math.max(0, amount));
  const value = parseInt(match[1], 16);
  const blend = (channel: number): number => Math.round(channel + (255 - channel) * ratio);
  const r = blend((value >> 16) & 0xff);
  const g = blend((value >> 8) & 0xff);
  const b = blend(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** `diagram1.png`: the hovered segment keeps its colour, every other one fades to a tint. */
export function bandFill(stage: string, hovered: string | null): string {
  const base = bandColor(stage);
  return hovered !== null && stage !== hovered ? fadeHex(base, FADED_FILL) : base;
}

/** A segment's own two numbers, each as digits: the entries it holds, and its share of the bucket. */
export interface SegmentLabel {
  /** How many entries this period recorded into this stage. */
  count: string;
  /** That stage's share of that period's activity, rounded, with its `%`. */
  share: string;
}

/**
 * The numbers a segment carries, as its two lines - `12` over `25%`.
 *
 * The count is what a share cannot answer on its own (10% of a bucket of ten is one entry, 10% of a
 * bucket of a hundred is ten), and **two lines** rather than `12, 25%` is what fits: at a month's
 * worth of buckets a column is barely 30px wide, and both numbers on one line overflow into their
 * neighbours. The chart draws these itself (`StageMixChart.tsx`), because a two-line label needs
 * `<tspan>`s - Nivo's `label` is a single string, and its `labelFormat` is declared in the library's
 * types but never read at runtime.
 */
export function segmentLabel(count: number, percent: number): SegmentLabel {
  return { count: String(count), share: `${Math.round(percent)}%` };
}

/**
 * How tall a segment has to be to carry its two lines, in pixels: two 10px lines plus a little
 * room. A shorter segment gets no label at all rather than a shrunk or clipped one.
 */
export const SEGMENT_LABEL_HEIGHT = 26;

/**
 * How visible a segment's label is while another stage is hovered.
 *
 * The label is white, so on a faded (near-white) segment it would simply vanish; fading it together
 * with its own segment leaves the hovered stage's numbers the only legible ones, which is the point
 * of the hover (`diagram1.png`).
 */
export const FADED_LABEL_OPACITY = 0.2;

export function labelOpacity(stage: string, hovered: string | null): number {
  return hovered === null || stage === hovered ? 1 : FADED_LABEL_OPACITY;
}

/**
 * The hover caption: `Applied — 3 entries · 25% · 12 Oct · 1 refused · 2 restored`.
 *
 * `entries` rather than `vacancies` on purpose: one vacancy can be counted several times in a day
 * (two moves are two entries), and a share is always a share of that period's activity rather than
 * of the board. The two outcomes that live beside the stack are appended **only when the bucket has
 * them** - a day with no refusals should not carry a `0 refused` nobody asked about.
 */
export function describeShare(series: AnalyticsSeries, stage: StageId, index: number): string {
  const serie = series.stages.find((item) => item.stage === stage);
  const bucket = series.buckets[index];
  if (!serie || !bucket) return '';
  const value = serie.values[index] ?? 0;
  const total = series.totals[index] ?? 0;
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  const parts = [
    `${stageLabel(stage)} — ${value} ${value === 1 ? 'entry' : 'entries'} · ${share}% · ${bucket.label}`,
  ];
  const refused = series.refused[index] ?? 0;
  const restored = series.restored[index] ?? 0;
  if (refused > 0) parts.push(`${refused} refused`);
  if (restored > 0) parts.push(`${restored} restored`);
  return parts.join(' · ');
}

/**
 * `30 days · 12 entries on 12 Oct · busiest 40 · 3 refused · 2 restored` - the page's subtitle.
 *
 * `busiest` is only worth saying when the newest bucket is not already the peak, the two outcomes
 * only when the window has any, and the truncation note is what keeps a capped `All time` honest:
 * the chart drew its newest `MAX_BUCKETS` columns, not everything, and the subtitle is the only
 * place that says so.
 */
export function summarizeSeries(series: AnalyticsSeries): string {
  const buckets = series.buckets.length;
  const last = series.buckets[buckets - 1];
  const latest = series.totals[buckets - 1] ?? 0;
  const granularity = series.buckets[0]?.granularity ?? 'day';
  const unit = granularity === 'month' ? 'month' : granularity === 'week' ? 'week' : 'day';
  const parts = [
    `${buckets} ${buckets === 1 ? unit : `${unit}s`}`,
    `${latest} ${latest === 1 ? 'entry' : 'entries'} ${granularity === 'day' ? 'on' : 'in'} ${
      last ? last.label : dayKey(Date.now())
    }`,
  ];
  if (series.maxTotal > latest) parts.push(`busiest ${series.maxTotal}`);
  if (series.refusedTotal > 0) parts.push(`${series.refusedTotal} refused`);
  if (series.restoredTotal > 0) parts.push(`${series.restoredTotal} restored`);
  const cap = MAX_BUCKETS[granularity];
  if (buckets >= cap) parts.push(`newest ${cap} ${unit}s`);
  return parts.join(' · ');
}
