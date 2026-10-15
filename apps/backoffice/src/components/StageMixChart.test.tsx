import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StageMixChart from './StageMixChart';
import { buildSeries, bucketsFor } from '../lib/analytics';
import { STAGES } from '../lib/stages';
import type { BoardCard, HistoryEntry, StageId } from '../lib/types';

/**
 * The analytics chart as it actually renders.
 *
 * What is pinned here is **our** half of the picture: the legend (board order, one swatch per stage
 * in the board's own colour, each stage's latest count), the readout line, the empty state, and the
 * fact that the whole thing server-renders without a DOM. The columns are Nivo's own render, drawn
 * from rules `analytics.test.ts` pins instead - the shares, the palette, the hover fade and the axis
 * ticks are all pure functions there - so this file only has to prove the component is wired to
 * them. Two things would otherwise break silently: a legend that lost its board order or its
 * colours, and a chart that only blew up in the browser.
 */

function at(day: number, hour = 10): string {
  return new Date(2026, 9, day, hour).toISOString();
}

function move(iso: string, to: StageId, id = 1): HistoryEntry {
  return {
    id,
    at: iso,
    actor: 'Candidate',
    action: `move → ${to}`,
    kind: 'move',
    from: 'scraped',
    to,
  };
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
    createdAt: at(10),
    updatedAt: at(10),
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

/**
 * 10, 11 and 12 Oct 2026: a card Scraped on the 10th and then Applied on the 12th, and a second one
 * Scraped on the 12th.
 */
function fixture() {
  // `to` is exclusive, so it has to land *inside* the 12th for the 12th to be drawn at all.
  const buckets = bucketsFor(new Date(2026, 9, 10).getTime(), new Date(2026, 9, 12, 12).getTime());
  return buildSeries(
    [
      card({
        jobId: 'a',
        updatedAt: at(12),
        stage: 'applied',
        history: [move(at(12), 'applied')],
      }),
      card({ jobId: 'b', createdAt: at(12), updatedAt: at(12) }),
    ],
    buckets,
    {},
  );
}

function rendered(node: React.ReactElement): string {
  return renderToString(node).replace(/<!--.*?-->/g, '');
}

describe('the stage mix chart', () => {
  it('server-renders the columns without a DOM', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    expect(html).toContain('<svg');
    // Nivo draws the bars itself; one board stage means one series in the chart's props.
    expect(STAGES).toHaveLength(6);
  });

  it('lists the stages in board order, Scraped first and Offer last', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    for (const meta of STAGES) expect(html).toContain(meta.label);
    expect(html.indexOf('Scraped')).toBeLessThan(html.indexOf('Offer'));
  });

  it('paints each legend swatch with the board palette, not Nivo defaults', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    // Scraped's grey and Applied's sky - the same hexes `lib/analytics.ts` holds.
    expect(html).toContain('background-color:#a1a1aa');
    expect(html).toContain('background-color:#0ea5e9');
  });

  it('shows each stage its own count in the newest period', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    // 12 Oct recorded two entries: one Scraped, one Applied - so exactly two legend items read "1".
    expect(html.match(/>1<\/span>/g)).toHaveLength(2);
  });

  it('invites the hover that reads a period out', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    expect(html).toContain('Hover a segment (or a name above) to read one period.');
  });

  it('writes each segment its count over its share, as two lines', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    // Two `<tspan>`s per label - the count on the first line, the share on the second - never one
    // string: 12 Oct recorded two entries, one Scraped and one Applied, so `1` over `50%`.
    const tspans = html.match(/<tspan/g) ?? [];
    expect(tspans.length).toBeGreaterThan(0);
    expect(tspans.length % 2).toBe(0);
    expect(html).toContain('>1</tspan>');
    expect(html).toContain('>50%</tspan>');
    expect(html).not.toContain('1, 50%');
  });

  it('does not clip its own tooltip: the chart panel has no overflow hidden', () => {
    const html = rendered(<StageMixChart series={fixture()} />);
    // Nivo positions its tooltip absolutely inside the chart and never clamps it to the box, so an
    // `overflow-hidden` ancestor swallows the tooltip of a segment near a column's top edge (the
    // Interviewing bug, 2026-10-12). The panel is unclipped and lifted above its siblings instead.
    expect(html).not.toContain('overflow-hidden');
    expect(html).toContain('relative z-10 rounded-xl');
  });

  it('says so instead of drawing an empty chart', () => {
    const empty = buildSeries([], bucketsFor(Date.now(), Date.now()), {});
    const html = rendered(<StageMixChart series={empty} />);
    expect(html).toContain('Nothing happened in this window');
    expect(html).not.toContain('<svg');
  });
});
