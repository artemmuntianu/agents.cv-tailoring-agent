import { describe, expect, it } from 'vitest';
import {
  FADED_FILL,
  MAX_DAYS,
  bandColor,
  bandFill,
  buildSeries,
  dayBuckets,
  dayKey,
  dayLabel,
  describeShare,
  fadeHex,
  mixRows,
  resolveWindow,
  segmentLabel,
  sharePercents,
  stageOnDay,
  summarizeSeries,
  tickValues,
  type AnalyticsSeries,
} from './analytics';
import { dateWindow } from './filters';
import { STAGES } from './stages';
import type { BoardCard, HistoryEntry, HistoryKind, StageId } from './types';

/**
 * The Analytics chart's rules, pinned to one instant: 12 Oct 2026, 12:00 local.
 *
 * Three things carry most of these tests. A card's column on a day is rebuilt from its own audit
 * trail (so "the latest move at or before the end of that day" is the whole rule); **every** day
 * must carry **every** stage key, because a missing key is an `undefined` the chart stacks into a
 * `NaN` segment; and a day's shares must add up to exactly 100, because a column is drawn against
 * a fixed 0-100% axis.
 */

const NOW = new Date(2026, 9, 12, 12, 0, 0);

/** A local date & time as the ISO string the board stores, so the buckets line up with local days. */
function at(year: number, month: number, day: number, hour = 10, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

/** The last millisecond of a local day - the instant `buildSeries` asks each bucket about. */
function endOf(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day + 1).getTime() - 1;
}

/** One `resume_history` row. `id` arrives as a string from node-pg (`int8`), but is typed number. */
function entry(kind: HistoryKind, iso: string, to: string, id = 1, from = 'scraped'): HistoryEntry {
  return { id, at: iso, actor: 'Candidate', action: `${kind}: ${from} → ${to}`, kind, from, to };
}

function move(iso: string, to: StageId, id = 1): HistoryEntry {
  return entry('move', iso, to, id);
}

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: '374001-1',
    externalId: '374001',
    source: 'dou',
    title: 'Platform Lead',
    company: 'Acme',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: 1,
    durationMs: 12000,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: at(2026, 10, 10),
    updatedAt: at(2026, 10, 10),
    stage: 'scraped',
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    artifactAvailability: { pdf: false, docx: false },
    coverLetter: null,
    docxUpdate: null,
    hasDescription: true,
    history: [],
    details: {
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
      applyUrl: null,
    },
    interviews: [],
    ...overrides,
  };
}

describe('where a card stood on a day', () => {
  it('is Scraped from the day it was scraped, and nothing before that', () => {
    const scraped = card();
    expect(stageOnDay(scraped, endOf(2026, 10, 10))).toBe('scraped');
    expect(stageOnDay(scraped, endOf(2026, 10, 9))).toBeNull();
  });

  it('counts a move from its own day, never earlier', () => {
    const moved = card({
      updatedAt: at(2026, 10, 11),
      stage: 'applied',
      history: [move(at(2026, 10, 11), 'applied')],
    });
    expect(stageOnDay(moved, endOf(2026, 10, 10))).toBe('scraped');
    expect(stageOnDay(moved, endOf(2026, 10, 11))).toBe('applied');
  });

  it('takes the latest move at or before the end of the day', () => {
    const journey = card({
      updatedAt: at(2026, 10, 12),
      stage: 'interviewing',
      history: [
        move(at(2026, 10, 10), 'prepare', 1),
        move(at(2026, 10, 11), 'applied', 2),
        move(at(2026, 10, 12), 'interviewing', 3),
        // A row dated in the future must not leak backwards into an earlier day.
        move(at(2026, 10, 20), 'offer', 4),
      ],
    });
    expect(stageOnDay(journey, endOf(2026, 10, 10))).toBe('prepare');
    expect(stageOnDay(journey, endOf(2026, 10, 11))).toBe('applied');
    expect(stageOnDay(journey, endOf(2026, 10, 12))).toBe('interviewing');
    expect(stageOnDay(journey, endOf(2026, 10, 19))).toBe('interviewing');
  });

  it('resolves two moves recorded in the same second to the later one', () => {
    const sameSecond = card({
      updatedAt: at(2026, 10, 11),
      stage: 'applied',
      history: [move(at(2026, 10, 11), 'prepare', 1), move(at(2026, 10, 11), 'applied', 2)],
    });
    expect(stageOnDay(sameSecond, endOf(2026, 10, 11))).toBe('applied');
  });

  it('ignores the rows that are not column changes', () => {
    const refused = card({
      updatedAt: at(2026, 10, 12),
      stage: 'scraped',
      archived: true,
      archivedAt: at(2026, 10, 10),
      archivedActor: 'Company',
      archivedReason: 'No response',
      history: [
        entry('archive', at(2026, 10, 10), 'archived', 1, 'active'),
        entry('restore', at(2026, 10, 11), 'active', 2, 'archived'),
        entry('tailoring', at(2026, 10, 12), 'tailored', 3, 'in_progress'),
      ],
    });
    // A refusal keeps the card in its column, so the chart still reads Scraped.
    expect(stageOnDay(refused, endOf(2026, 10, 12))).toBe('scraped');
  });

  it("lets the card's own column win from its last activity onward", () => {
    // The trail was pruned after the fact: the board says Offer, the remaining row says Applied.
    const corrected = card({
      updatedAt: at(2026, 10, 11),
      stage: 'offer',
      history: [move(at(2026, 10, 10), 'applied')],
    });
    expect(stageOnDay(corrected, endOf(2026, 10, 10))).toBe('applied');
    expect(stageOnDay(corrected, endOf(2026, 10, 11))).toBe('offer');
    expect(stageOnDay(corrected, endOf(2026, 10, 12))).toBe('offer');
  });
});

describe('the day buckets', () => {
  it('is one bucket per local day the window covers, back to back', () => {
    const buckets = dayBuckets(Date.parse(at(2026, 10, 10)), Date.parse(at(2026, 10, 12)));
    expect(buckets.map((bucket) => bucket.day)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    for (let i = 1; i < buckets.length; i += 1) {
      // No gap and no overlap: each day starts where the previous one ended.
      expect(buckets[i].from).toBe(buckets[i - 1].to);
    }
    expect(buckets[0].day).toBe(dayKey(buckets[0].from));
  });

  it('keeps an upper bound that lands on a midnight out of the window', () => {
    // "Last week" is a Monday-to-Monday range: 12 Oct 2026 *is* a Monday, so its upper bound is
    // 12 Oct 00:00 - which is outside the window. The bug drew eight columns, through Oct 12.
    const buckets = dayBuckets(new Date(2026, 9, 5).getTime(), new Date(2026, 9, 12).getTime());
    expect(buckets).toHaveLength(7);
    expect(buckets[0].day).toBe('2026-10-05');
    expect(buckets[buckets.length - 1].day).toBe('2026-10-11');
    // ... and the last day still ends where the bound is, so its snapshot is that whole day.
    expect(buckets[buckets.length - 1].to).toBe(new Date(2026, 9, 12).getTime());
  });

  it('draws last week as its own seven days, ending the day before this week starts', () => {
    const now = new Date(2026, 9, 12, 12, 0, 0);
    const bounds = resolveWindow(
      dateWindow({ range: 'last_week', from: '', to: '' }, now),
      [card()],
      now,
    );
    expect(dayBuckets(bounds.from, bounds.to).map((bucket) => bucket.day)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  it('puts a moment mid-day in that day, and ends the bucket at the next midnight', () => {
    const [bucket] = dayBuckets(Date.parse(at(2026, 10, 12)), Date.parse(at(2026, 10, 12, 12)));
    expect(bucket.day).toBe('2026-10-12');
    expect(bucket.from).toBe(new Date(2026, 9, 12).getTime());
    expect(bucket.to).toBe(new Date(2026, 9, 13).getTime());
  });

  it('clamps an all-time window to the newest days it will draw', () => {
    const buckets = dayBuckets(Date.parse(at(2020, 1, 1)), Date.parse(at(2026, 10, 12, 12)));
    expect(buckets).toHaveLength(MAX_DAYS);
    expect(buckets[buckets.length - 1].day).toBe('2026-10-12');
    expect(buckets[0].day).toBe(dayKey(new Date(2026, 9, 12 - (MAX_DAYS - 1)).getTime()));
  });

  it('still returns one day when the window is empty or backwards', () => {
    expect(dayBuckets(Date.parse(at(2026, 10, 12)), Date.parse(at(2026, 10, 10)))).toHaveLength(1);
  });
});

describe('closing an open window against the data', () => {
  it('starts at the earliest card and ends at now when the range has no bounds', () => {
    const window = resolveWindow({ from: null, to: null }, [card()], NOW);
    expect(window.from).toBe(Date.parse(at(2026, 10, 10)));
    expect(window.to).toBe(NOW.getTime());
  });

  it('keeps the bounds a bounded range already has', () => {
    const from = Date.parse(at(2026, 9, 1));
    const to = Date.parse(at(2026, 10, 1));
    expect(resolveWindow({ from, to }, [card()], NOW)).toEqual({ from, to });
  });

  it('has nothing to clamp when there are no cards', () => {
    const window = resolveWindow({ from: null, to: null }, [], NOW);
    expect(window.from).toBe(NOW.getTime());
  });
});

/** The three days every series test is drawn over: 10, 11 and 12 Oct 2026. */
function buckets() {
  return dayBuckets(Date.parse(at(2026, 10, 10)), Date.parse(at(2026, 10, 12)));
}

function valuesOf(series: AnalyticsSeries, stage: StageId): number[] {
  return series.stages.find((serie) => serie.stage === stage)?.values ?? [];
}

describe('the per-day series', () => {
  /** Scraped on the 10th, dragged into Applied on the 11th. */
  const journey = card({
    jobId: 'a',
    updatedAt: at(2026, 10, 11),
    stage: 'applied',
    history: [move(at(2026, 10, 11), 'applied')],
  });
  /** Never touched: Scraped from the day it was scraped. */
  const newcomer = card({ jobId: 'b', createdAt: at(2026, 10, 11), updatedAt: at(2026, 10, 11) });

  it('counts each card in the column it stood in, day by day', () => {
    const series = buildSeries([journey, newcomer], buckets(), {});
    expect(valuesOf(series, 'scraped')).toEqual([1, 1, 1]);
    expect(valuesOf(series, 'applied')).toEqual([0, 1, 1]);
    expect(series.totals).toEqual([1, 2, 2]);
    expect(series.maxTotal).toBe(2);
  });

  it('counts a card nowhere before it existed', () => {
    const series = buildSeries([newcomer], buckets(), {});
    expect(series.totals).toEqual([0, 1, 1]);
  });

  it('stacks bottom-to-top in board order, Scraped at the bottom', () => {
    const series = buildSeries([journey], buckets(), {});
    expect(series.stages.map((serie) => serie.stage)).toEqual(STAGES.map((meta) => meta.id));
    expect(series.stages[0].stage).toBe('scraped');
    expect(series.stages[series.stages.length - 1].stage).toBe('offer');
  });

  it('counts a refused card by default, and leaves it out on request', () => {
    const refused = card({
      jobId: 'c',
      archived: true,
      archivedAt: at(2026, 10, 11),
      archivedActor: 'Company',
      archivedReason: 'No response',
    });
    expect(buildSeries([journey, refused], buckets(), {}).totals[2]).toBe(2);
    expect(buildSeries([journey, refused], buckets(), { includeArchived: false }).totals[2]).toBe(1);
  });
});

describe('the rows the bar chart is handed', () => {
  const cards = [
    card({
      jobId: 'a',
      updatedAt: at(2026, 10, 11),
      stage: 'interviewing',
      history: [move(at(2026, 10, 11), 'interviewing')],
    }),
    card({ jobId: 'b', createdAt: at(2026, 10, 12), updatedAt: at(2026, 10, 12) }),
  ];

  it('is one row per day, keyed bottom-to-top in board order', () => {
    const { data, keys } = mixRows(buildSeries(cards, buckets(), {}));
    expect(data).toHaveLength(3);
    expect(keys).toEqual(STAGES.map((meta) => meta.id));
    expect(keys[0]).toBe('scraped');
    expect(data.map((row) => row.day)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('writes every stage key and its own count on every day, so no segment can be NaN', () => {
    // A missing key is an `undefined` the chart stacks as a `NaN` height - the one way this
    // picture could grow a hole. Every row must be complete, and every value a real number.
    const { data, keys } = mixRows(buildSeries(cards, buckets(), {}));
    for (const row of data) {
      for (const key of keys) {
        expect(key in row, `${key} missing on ${String(row.day)}`).toBe(true);
        expect(Number.isFinite(row[key]), `${key} on ${JSON.stringify(row)}`).toBe(true);
        expect(Number.isFinite(row[`count_${key}`]), `count_${key}`).toBe(true);
      }
    }
  });

  it('states a stage with no vacancies as an explicit zero', () => {
    const { data } = mixRows(buildSeries(cards, buckets(), {}));
    // Nobody is in Negotiating on the first day - a zero, not a missing key.
    expect(data[0].negotiating).toBe(0);
    expect(data[0].count_negotiating).toBe(0);
  });

  it('carries the count behind the share, so the hover can answer in vacancies', () => {
    const { data } = mixRows(buildSeries(cards, buckets(), {}));
    // 12 Oct: one card in Interviewing, one still in Scraped - half the board each, of two.
    expect(data[2].total).toBe(2);
    expect(data[2].interviewing).toBe(50);
    expect(data[2].count_interviewing).toBe(1);
    expect(data[2].count_scraped).toBe(1);
  });
});

describe('the shares a column is drawn from', () => {
  it('adds up to exactly 100, whatever the rounding does', () => {
    // Three equal thirds would otherwise leave the column a hair short of the axis.
    const shares = sharePercents([1, 1, 1], 3);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 10);
    expect(shares[0]).toBeCloseTo(33.333, 3);
  });

  it('gives the residue to the largest share, so no segment overshoots the axis', () => {
    const shares = sharePercents([7, 1, 1], 9);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 10);
    // The largest of the three is the first, so that is where the correction lands.
    expect(shares[0]).toBeGreaterThan(77.7);
  });

  it('is all zeroes for a day with no vacancies, never a NaN', () => {
    expect(sharePercents([0, 0, 0, 0, 0, 0], 0)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('sizes a day exactly, so the axis can be a fixed 0-100%', () => {
    const { data, keys } = mixRows(buildSeries([card({ jobId: 'a' })], buckets(), {}));
    for (const row of data) {
      const sum = keys.reduce((total, key) => total + Number(row[key]), 0);
      expect(sum).toBeCloseTo(100, 10);
    }
  });
});

describe('the day axis', () => {
  it('labels a handful of days and always the newest one', () => {
    expect(tickValues(buildSeries([card()], buckets(), {}), 2)).toEqual([
      '2026-10-10',
      '2026-10-12',
    ]);
  });

  it('labels every day when the window fits', () => {
    expect(tickValues(buildSeries([card()], buckets(), {}))).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
  });

  it('has nothing to label when there are no days', () => {
    expect(tickValues({ buckets: [], stages: [], totals: [], maxTotal: 0 })).toEqual([]);
  });
});

describe('the hover rule', () => {
  it('keeps every segment solid while nothing is hovered', () => {
    expect(bandFill('applied', null)).toBe(bandColor('applied'));
  });

  it('keeps the hovered stage solid and fades the rest (diagram1.png)', () => {
    expect(bandFill('applied', 'applied')).toBe(bandColor('applied'));
    expect(bandFill('scraped', 'applied')).toBe(fadeHex(bandColor('scraped'), FADED_FILL));
    expect(bandFill('scraped', 'applied')).not.toBe(bandColor('scraped'));
  });

  it('blends toward white, so a faded tint still reads on the panel', () => {
    expect(fadeHex('#000000', 0)).toBe('#000000');
    expect(fadeHex('#000000', 0.5)).toBe('#808080');
    expect(fadeHex('#000000', 1)).toBe('#ffffff');
    // Anything it does not recognise is handed back rather than guessed at.
    expect(fadeHex('tomato', 0.5)).toBe('tomato');
  });

  it('colours every board stage, and falls back for a stage it does not know', () => {
    for (const meta of STAGES) expect(bandColor(meta.id)).toMatch(/^#[0-9a-f]{6}$/);
    expect(bandColor('something-else')).toBe('#94a3b8');
  });
});

describe('the words around the chart', () => {
  it('words a segment as its two lines - the count, then the share', () => {
    expect(segmentLabel(12, 25)).toEqual({ count: '12', share: '25%' });
    // A share that does not divide evenly is rounded, never printed as a float.
    expect(segmentLabel(1, 100 / 3)).toEqual({ count: '1', share: '33%' });
    // An empty stage is a real zero on both lines.
    expect(segmentLabel(0, 0)).toEqual({ count: '0', share: '0%' });
  });

  it('reads one stage out of the series', () => {
    const series = buildSeries(
      [
        card({
          jobId: 'a',
          updatedAt: at(2026, 10, 11),
          stage: 'applied',
          history: [move(at(2026, 10, 11), 'applied')],
        }),
      ],
      buckets(),
      {},
    );
    // The date half is the locale's own rendering, so it is derived rather than hardcoded.
    expect(describeShare(series, 'applied', 1)).toBe(
      `Applied — 1 vacancy · 100% · ${dayLabel('2026-10-11')}`,
    );
    expect(describeShare(series, 'applied', 0)).toBe(
      `Applied — 0 vacancies · 0% · ${dayLabel('2026-10-10')}`,
    );
    expect(describeShare(series, 'offer', 1)).toBe(
      `Offer — 0 vacancies · 0% · ${dayLabel('2026-10-11')}`,
    );
  });

  it('summarizes the window from its last day', () => {
    const series = buildSeries([card()], buckets(), {});
    expect(summarizeSeries(series)).toBe(`3 days · 1 vacancy on ${dayLabel('2026-10-12')}`);
  });

  it('says so when a wider range was cut to the newest days it draws', () => {
    const wide = dayBuckets(Date.parse(at(2020, 1, 1)), Date.parse(at(2026, 10, 12)));
    const series = buildSeries([card()], wide, {});
    expect(series.buckets).toHaveLength(MAX_DAYS);
    expect(summarizeSeries(series)).toContain(`newest ${MAX_DAYS} days`);
  });
});
