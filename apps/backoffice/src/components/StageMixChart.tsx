import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, type BarCustomLayerProps, type BarTooltipProps } from '@nivo/bar';
import {
  SEGMENT_LABEL_HEIGHT,
  bandColor,
  bandFill,
  countAxis,
  describeShare,
  labelOpacity,
  mixRows,
  segmentLabel,
  tickValues,
  type AnalyticsSeries,
  type MixRow,
} from '../lib/analytics';
import { STAGES, stageLabel } from '../lib/stages';
import type { StageId } from '../lib/types';

/**
 * The analytics diagram: what happened in each column, in each period.
 *
 * A **stacked column per period** - a local day by default, or a week or a month - with one segment
 * per board stage, stacked bottom-to-top in board order (Scraped at the bottom). Each segment is the
 * number of entries the operator recorded into that column in that period, and carries both that
 * count and its share of the period - `3` over `25%`. The axis counts entries, so a quiet day and a
 * busy one are different heights and a day nobody touched a card is a zero. Refusals and restores
 * are read *beside* the stack (the tooltip, the caption and the page's subtitle) rather than stacked
 * in it: they are outcomes, not funnel steps. Nivo draws the columns; the numbers on them are ours
 * (`SegmentLabels`).
 *
 * Discrete columns rather than a stream graph, for the same reason as before: periods are discrete
 * things, and a smoothed flowing band (`offsetType: 'wiggle'` + `catmullRom`) would draw waves
 * through them and imply a change that never happened. A printed label in each segment is readable
 * at any size, and a segment too short for its two lines drops the label rather than shrinking it
 * (`SEGMENT_LABEL_HEIGHT`).
 *
 * The data is `lib/analytics.ts`' own reading of each card's trail, so nothing here decides
 * anything about the vacancies - this file is a rendering layer, and every rule it follows (the
 * shares, the colours, the hover fade, both axes) is a pure function in that module.
 */

/** What the chart is drawn at before the container has been measured (SSR and the first paint). */
const DEFAULT_WIDTH = 960;

/** The container's own width, measured - so the chart fills the page and the SVG never scales. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = node.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [width, ref] as const;
}

/**
 * The hover readout: the segment's count, its share of the period, and the period's two outcomes.
 *
 * A column is drawn to a count, so the tooltip answers with the count **and the base** it is a share
 * of - `3 of 12 · 25%` - because a share without its base is not a fact the operator can act on.
 * Refusals and restores are named here instead of being stacked, and only when the period has them.
 */
function ShareTooltip({ id, data }: BarTooltipProps<MixRow>) {
  const stage = String(id) as StageId;
  const count = Number(data[stage] ?? 0);
  const total = Number(data.total ?? 0);
  const share = Math.round(Number(data[`share_${stage}`] ?? 0));
  const refused = Number(data.refused ?? 0);
  const restored = Number(data.restored ?? 0);
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-slate-900">{stageLabel(stage)}</p>
      <p className="text-slate-600">
        {count} {count === 1 ? 'entry' : 'entries'} of {total} · {share}%
      </p>
      <p className="text-slate-400">{data.label}</p>
      {(refused > 0 || restored > 0) && (
        <p className="mt-1 text-slate-500">
          {refused > 0 && `${refused} refused`}
          {refused > 0 && restored > 0 && ' · '}
          {restored > 0 && `${restored} restored`}
        </p>
      )}
    </div>
  );
}

interface LegendProps {
  series: AnalyticsSeries;
  hovered: string | null;
  onHover: (stage: string | null) => void;
}

/**
 * The legend row, in board order (Scraped first) - our own rather than Nivo's `BoxLegendSvg`,
 * which always redraws its own `data` (reversed, so Offer would lead) and cannot be a hover target.
 *
 * Buttons rather than spans: focusing one highlights its segment exactly like hovering does, so the
 * page's one interaction works from the keyboard too. Each item carries its own latest count, which
 * is the number the operator most often wants.
 */
function Legend({ series, hovered, onHover }: LegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {STAGES.map((meta) => {
        const serie = series.stages.find((item) => item.stage === meta.id);
        const latest = serie ? (serie.values[serie.values.length - 1] ?? 0) : 0;
        const active = hovered === meta.id;
        return (
          <button
            key={meta.id}
            type="button"
            aria-pressed={active}
            title={meta.hint}
            onMouseEnter={() => onHover(meta.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(meta.id)}
            onBlur={() => onHover(null)}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${
              active ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: bandColor(meta.id) }}
            />
            <span>{meta.label}</span>
            <span className="text-xs tabular-nums text-slate-400">{latest}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The hovered stage, handed to the label layer.
 *
 * A Nivo layer cannot be given props - `layers` is rendered from the library's own layer context -
 * and a component defined inline would be a new type on every render, so React would tear down and
 * rebuild every label as the hover moved between segments. The one value the layer needs therefore
 * travels through a context.
 */
const HoverContext = createContext<string | null>(null);

/**
 * The two numbers each segment carries: its count over its share (`segmentLabel`).
 *
 * Drawn by hand because a two-line label needs two `<tspan>`s and Nivo's label is a single string.
 * The layer draws **inside** `SvgWrapper`'s margin group, so `bar.x`/`bar.y` are already in the
 * chart's own space and a segment's centre is `bar.x + bar.width / 2` - Nivo's own `labelX`/`labelY`
 * are *bar-relative* halves of the bar (`useBar`'s layout function returns `width / 2, height / 2`),
 * which is exactly where a custom layer goes wrong by a full column width if it copies them.
 *
 * A segment too short for two lines gets no label rather than a shrunk or clipped one, and the
 * labels fade with their own segments so the hovered stage's numbers stay the legible ones.
 */
function SegmentLabels({ bars }: BarCustomLayerProps<MixRow>) {
  const hovered = useContext(HoverContext);
  return (
    <g pointerEvents="none">
      {bars.map((bar) => {
        const stage = String(bar.data.id);
        if (bar.height < SEGMENT_LABEL_HEIGHT) return null;
        const label = segmentLabel(
          Number(bar.data.data[stage] ?? 0),
          Number(bar.data.data[`share_${stage}`] ?? 0),
        );
        const x = bar.x + bar.width / 2;
        const y = bar.y + bar.height / 2;
        return (
          <text
            key={`${String(bar.data.indexValue)}-${stage}`}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#ffffff"
            fillOpacity={labelOpacity(stage, hovered)}
            fontSize={10}
            fontWeight={600}
          >
            <tspan x={x} dy="-0.55em">
              {label.count}
            </tspan>
            <tspan x={x} dy="1.1em">
              {label.share}
            </tspan>
          </text>
        );
      })}
    </g>
  );
}

interface StageMixChartProps {
  series: AnalyticsSeries;
  /** Height of the drawing area; the width follows the page. */
  height?: number;
}

/** One column per period, one segment per board stage, stacked bottom-to-top in board order. */
export default function StageMixChart({ series, height = 440 }: StageMixChartProps) {
  /** The stage under the cursor - from a segment or from its name above - and the period it was in. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [width, containerRef] = useMeasuredWidth<HTMLDivElement>();
  const { data, keys } = useMemo(() => mixRows(series), [series]);
  const labels = useMemo(() => tickValues(series), [series]);
  /** The count axis: the busiest period rounded up, and its whole-number gridlines. */
  const axis = useMemo(() => countAxis(series.maxTotal), [series.maxTotal]);
  /**
   * Buckets carry their own label (`Week of 5 Oct`, `Oct 2026`) and the axis labels them by **key**,
   * so this is a lookup rather than a second labelling rule living in the component.
   */
  const labelOf = useMemo(
    () => new Map(series.buckets.map((item) => [item.key, item.label])),
    [series.buckets],
  );

  // The legend has no period of its own, so it reads the newest one; a hovered segment reads its own.
  const bucket = hoveredBucket ?? series.buckets.length - 1;
  const caption =
    hovered !== null && series.buckets[bucket]
      ? describeShare(series, hovered as StageId, bucket)
      : 'Hover a segment (or a name above) to read one period.';

  if (series.maxTotal === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Nothing happened in this window. Widen the range, or scrape a vacancy and drag it from
        Scraped.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Legend series={series} hovered={hovered} onHover={setHovered} />

      {/*
        The panel must **not** clip. Nivo's tooltip is absolutely positioned inside this box
        (`position: absolute; z-index: 10`) and `TooltipWrapper` never clamps itself to the chart -
        it only offsets by the anchor - so an `overflow-hidden` here swallowed the tooltip of a
        segment near the top of a column (reported on *Interviewing*, 2026-10-12). `relative z-10`
        then keeps that overflow above the legend row and the readout line rather than behind them.
      */}
      <HoverContext.Provider value={hovered}>
        <div className="relative z-10 rounded-xl border border-slate-200 bg-white">
          <div ref={containerRef} className="w-full">
            <Bar<MixRow>
              data={data}
              keys={keys}
              indexBy="bucket"
              width={width}
              height={height}
              groupMode="stacked"
              layout="vertical"
              // The axis counts entries, and its top is the busiest period rounded up to a readable
              // step: a busy period has to look busy.
              valueScale={{ type: 'linear', min: 0, max: axis.max }}
              indexScale={{ type: 'band', round: true }}
              colors={(datum) => bandFill(String(datum.id), hovered)}
              // No stroke and no radius: a column's segments read as one bar, like the reference.
              borderWidth={0}
              borderRadius={0}
              padding={0.22}
              innerPadding={0}
              // The numbers on the segments are `SegmentLabels`' own, not Nivo's: a two-line label
              // needs two `<tspan>`s, and the library's `label` is a single string (its `labelFormat`
              // is declared in its types but never read at runtime).
              enableLabel={false}
              layers={['grid', 'axes', 'bars', SegmentLabels]}
              enableGridX={false}
              enableGridY
              axisTop={null}
              axisRight={null}
              axisBottom={{
                tickSize: 0,
                tickPadding: 6,
                tickRotation: 0,
                tickValues: labels,
                format: (value) => labelOf.get(String(value)) ?? String(value),
              }}
              axisLeft={{
                tickSize: 0,
                tickPadding: 6,
                tickValues: axis.ticks,
                format: (value) => String(value),
              }}
              margin={{ top: 8, right: 12, bottom: 34, left: 44 }}
              animate={false}
              isInteractive
              onMouseEnter={(datum) => {
                setHovered(String(datum.id));
                setHoveredBucket(datum.index);
              }}
              onMouseLeave={() => {
                setHovered(null);
                setHoveredBucket(null);
              }}
              tooltip={ShareTooltip}
              role="img"
              ariaLabel="Entries per stage per period, as a count"
            />
          </div>
        </div>
      </HoverContext.Provider>

      <p className="min-h-5 text-sm text-slate-600">{caption}</p>
    </div>
  );
}
