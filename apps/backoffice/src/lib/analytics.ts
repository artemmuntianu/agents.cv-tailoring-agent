import { type DateWindow } from './filters';
import { STAGES, isStageId, stageLabel } from './stages';
import type { BoardCard, StageId } from './types';

/**
 * The Analytics page's pure half: *how many vacancies stood in each column, on each day*.
 *
 * The chart is a **100% stacked column per day** - one segment per board column, stacked
 * bottom-to-top in the board's own order (Scraped at the bottom, Offer on top), each segment's
 * height its share of that day's board - so the page needs two things and nothing else: a count
 * per column per day, and a vocabulary to read it with. Both live here, so the page and the chart
 * component stay rendering layers, exactly like the board's `lib/board.ts` and `lib/filters.ts`.
 *
 * **Where a day's number comes from.** The board's cards carry their own audit trail
 * (`resume_history`: one row per confirmed change, `lib/db.ts::fetchHistory`), and that trail is
 * the only record of *when* a card changed column. A card therefore starts in Scraped on the day
 * it was scraped (`resumes.created_at` - the day the intake created the row, which is also the
 * day a card that has no `resume_board` row yet appears in Scraped) and every `move` row moves
 * it. Nothing is stored twice and no second source of board state is added: the chart is a
 * *reading* of the cards the board already loads.
 *
 * The window is measured in **local calendar days**, the same unit `cardMeta.ts` dates a card by
 * (`today`, `yesterday`, ...), so "a day" means one thing in this app.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Most days the chart draws at once.
 *
 * A column a day has to stay wide enough to hold its own number: past roughly this many columns
 * the segments are thinner than their labels and the picture stops being readable - and `All time`
 * on a board that goes back months would be hundreds of them. The newest `MAX_DAYS` are kept and
 * `dayBuckets` stops there; `summarizeSeries` says so rather than dropping the start silently.
 */
export const MAX_DAYS = 90;

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

/** `12 Oct` - the bucket's own label, for the axis and the hover caption. */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/** One local calendar day the chart draws a column for. */
export interface AnalyticsBucket {
  /** `yyyy-mm-dd`, local. */
  day: string;
  /** Inclusive lower bound: local midnight. */
  from: number;
  /** Exclusive upper bound: the next local midnight. */
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
 * One bucket per local calendar day the window `[from, to)` covers.
 *
 * `to` is **exclusive** - it is `filters.ts::dateWindow`'s upper bound, the same field the board's
 * own filter compares against (`at >= window.to` is outside it) - so the last column is the day that
 * bound falls *inside*, not the day it lands on. That is the difference between "Last week" being its
 * seven days and being eight: the range runs Monday 00:00 to Monday 00:00, and that second Monday is
 * not part of last week (an eighth Oct-12 column, fixed 2026-10-12).
 *
 * The last bucket's own `to` is the next midnight, so a card created later today still lands in
 * today's column rather than being dropped. A window longer than `MAX_DAYS` (or a `from` after its
 * `to`) still returns something: the chart never has nothing to draw.
 */
export function dayBuckets(from: number, to: number): AnalyticsBucket[] {
  const first = startOfDay(from);
  const last = startOfDay(to - 1);
  const span = Math.round((last - first) / DAY_MS) + 1;
  const start = span > MAX_DAYS ? addDays(last, -(MAX_DAYS - 1)) : first;

  const buckets: AnalyticsBucket[] = [];
  for (let cursor = start; cursor <= last; cursor = nextMidnight(cursor)) {
    buckets.push({ day: dayKey(cursor), from: cursor, to: nextMidnight(cursor) });
  }
  if (buckets.length === 0) {
    buckets.push({ day: dayKey(first), from: first, to: nextMidnight(first) });
  }
  return buckets;
}

/**
 * The column a card stood in at the end of `dayEnd` - `null` while the card did not exist yet.
 *
 * Rebuilt from the card's own trail: Scraped by default, then the **latest** `move` row dated at
 * or before the end of the day. `archive`/`restore`/`tailoring` rows are not column changes and
 * are ignored (refusing a vacancy keeps its column, invariant 19).
 *
 * The card's **current** column wins from the card's last activity onward
 * (`resume_board.updated_at`): the audit trail is correctable and prunable
 * (`PATCH`/`DELETE /api/board/history/<id>`), and the last bucket must never disagree with the
 * board the operator is looking at.
 */
export function stageOnDay(card: BoardCard, dayEnd: number): StageId | null {
  const createdAt = Date.parse(card.createdAt);
  if (!Number.isNaN(createdAt) && createdAt > dayEnd) return null;

  let stage: StageId = 'scraped';
  let movedAt = Number.NEGATIVE_INFINITY;
  for (const entry of card.history) {
    if (entry.kind !== 'move') continue;
    const at = Date.parse(entry.at);
    // Skipping only an *earlier* row keeps the trail's own `at asc, id asc` order, so two moves
    // recorded in the same second still resolve to the later one.
    if (Number.isNaN(at) || at > dayEnd || at < movedAt) continue;
    if (isStageId(entry.to)) {
      stage = entry.to;
      movedAt = at;
    }
  }

  const touchedAt = Date.parse(card.updatedAt);
  if (!Number.isNaN(touchedAt) && touchedAt <= dayEnd && isStageId(card.stage)) stage = card.stage;
  return stage;
}

export interface AnalyticsOptions {
  /**
   * Count refused vacancies too (a refusal keeps the card in the column it dropped out of). On by
   * default: the chart asks "how many vacancies stood where", and a refusal is a fact about a
   * vacancy rather than a column of its own.
   */
  includeArchived?: boolean;
}

export interface AnalyticsSeries {
  buckets: AnalyticsBucket[];
  /** One entry per column, **bottom-to-top in `STAGES` order** - Scraped is the bottom band. */
  stages: { stage: StageId; values: number[] }[];
  /** The board's size on each day: every column summed. */
  totals: number[];
  /** The busiest day's total, for scaling and for the empty state. */
  maxTotal: number;
}

/**
 * The per-day counts the diagram is drawn from.
 *
 * One pass per card: for every bucket, ask the trail where the card stood at the end of that day.
 * A card that did not exist yet contributes nothing, so each day is a genuine snapshot of the
 * funnel rather than a count of changes.
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

  for (const card of counted) {
    for (let index = 0; index < buckets.length; index += 1) {
      const stage = stageOnDay(card, buckets[index].to - 1);
      if (stage === null) continue;
      const row = rowOf.get(stage);
      if (row === undefined) continue;
      stages[row].values[index] += 1;
      totals[index] += 1;
    }
  }

  return {
    buckets,
    stages,
    totals,
    maxTotal: totals.reduce((max, total) => Math.max(max, total), 0),
  };
}

/**
 * One day's shares, in percent, **summing to exactly 100**.
 *
 * The largest segment absorbs the rounding residue, so a day's column fills the axis precisely
 * (`valueScale.max = 100`) instead of overshooting it by a float's worth of pixels. A day with no
 * vacancies is all zeroes rather than six NaNs.
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
 * One row per day, in the shape `@nivo/bar` draws.
 *
 * `day` is the index (`indexBy`), each **stage id** carries that day's **percentage** - the stack
 * - and `count_<stage>` carries the count behind it, so a column shows shares while the hover
 * answers in vacancies.
 */
export interface MixRow extends Record<string, string | number> {
  /** The day (`yyyy-mm-dd`), the chart's `indexBy`. */
  day: string;
  /** Vacancies on the board that day. */
  total: number;
}

/**
 * **Every** stage key is written on **every** day, zeros included.
 *
 * The chart stacks `datum[key]`, so a missing key is `undefined` and an `undefined` segment is a
 * `NaN` height - the one way this picture could grow a hole. A day with nothing in a column is a
 * real zero, and this is where it is made explicit.
 */
export function mixRows(series: AnalyticsSeries): { data: MixRow[]; keys: StageId[] } {
  const keys = STAGES.map((meta) => meta.id);
  const data = series.buckets.map((bucket, index) => {
    const values = series.stages.map((serie) => serie.values[index] ?? 0);
    const total = series.totals[index] ?? 0;
    const shares = sharePercents(values, total);
    const row: Record<string, string | number> = { day: bucket.day, total };
    series.stages.forEach((serie, position) => {
      row[serie.stage] = shares[position] ?? 0;
      row[`count_${serie.stage}`] = values[position] ?? 0;
    });
    return row as MixRow;
  });
  return { data, keys };
}

/** The day keys the axis labels: every `n`-th day, always including the newest one. */
export function tickValues(series: AnalyticsSeries, max = 12): string[] {
  const days = series.buckets;
  if (days.length === 0) return [];
  const step = Math.max(1, Math.ceil(days.length / max));
  const keys = days.filter((_, index) => index % step === 0).map((bucket) => bucket.day);
  const newest = days[days.length - 1].day;
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

/** A segment's own two numbers, each as digits: the vacancies behind it, and its share of the day. */
export interface SegmentLabel {
  /** How many vacancies stood in this stage, on this day. */
  count: string;
  /** That stage's share of that day's board, rounded, with its `%`. */
  share: string;
}

/**
 * The numbers a segment carries, as its two lines - `12` over `25%`.
 *
 * The count is what a share cannot answer on its own (10% of a board of ten is one vacancy, 10% of
 * a board of a hundred is ten), and **two lines** rather than `12, 25%` is what fits: at a month's
 * worth of days a column is barely 30px wide, and both numbers on one line overflow into their
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

/** The hover caption: `Applied — 12 vacancies · 25% · 12 Oct`. */
export function describeShare(series: AnalyticsSeries, stage: StageId, index: number): string {
  const serie = series.stages.find((item) => item.stage === stage);
  const bucket = series.buckets[index];
  if (!serie || !bucket) return '';
  const value = serie.values[index] ?? 0;
  const total = series.totals[index] ?? 0;
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  const vacancies = value === 1 ? 'vacancy' : 'vacancies';
  return `${stageLabel(stage)} — ${value} ${vacancies} · ${share}% · ${dayLabel(bucket.day)}`;
}

/**
 * `30 days · 236 vacancies on 12 Oct` - the page's subtitle.
 *
 * `busiest` is only worth saying when the newest day is not already the peak, and the truncation
 * note is what keeps a capped `All time` honest: the chart drew its newest `MAX_DAYS` days, not
 * everything, and the subtitle is the only place that says so.
 */
export function summarizeSeries(series: AnalyticsSeries): string {
  const days = series.buckets.length;
  const last = series.buckets[series.buckets.length - 1];
  const latest = series.totals[series.totals.length - 1] ?? 0;
  const vacancies = latest === 1 ? 'vacancy' : 'vacancies';
  const parts = [
    `${days} ${days === 1 ? 'day' : 'days'}`,
    `${latest} ${vacancies} on ${last ? dayLabel(last.day) : dayKey(Date.now())}`,
  ];
  if (series.maxTotal > latest) parts.push(`busiest ${series.maxTotal}`);
  if (days >= MAX_DAYS) parts.push(`newest ${MAX_DAYS} days`);
  return parts.join(' · ');
}
