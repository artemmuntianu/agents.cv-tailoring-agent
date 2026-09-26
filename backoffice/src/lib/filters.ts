import type { BoardCard, StageId } from './types';

/**
 * The top control bar's state, and the pure logic behind it.
 *
 * Everything is client-side: the board loads at most 200 cards (`db.ts::BOARD_LIMIT`)
 * and the toolbar only decides which of them to show. That is a deliberate POC limit -
 * filtering server-side (and paging) is a documented gap.
 *
 * The default window is a rolling 30 days, so the board opens on the current search
 * rather than on everything ever scraped. Because a default *can* hide cards, the bar
 * always reports `showing N of M` and the empty state offers a one-click reset.
 */

export type DateRangeId =
  | 'last30'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'all'
  | 'custom';

export const DATE_RANGES: { id: DateRangeId; label: string }[] = [
  { id: 'last30', label: 'Last 30 days' },
  { id: 'this_week', label: 'This week' },
  { id: 'last_week', label: 'Last week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom…' },
];

export interface BoardFilters {
  /** Free text over title, company, id, posting url and refusal reason. */
  query: string;
  range: DateRangeId;
  /** `yyyy-mm-dd` bounds, read only when `range === 'custom'`. */
  from: string;
  to: string;
  /** Empty = every column. */
  stages: StageId[];
  /** Empty = any action. A card matches when one of its history entries has one. */
  actions: string[];
  showActive: boolean;
  showArchived: boolean;
}

export const DEFAULT_FILTERS: BoardFilters = {
  query: '',
  range: 'last30',
  from: '',
  to: '',
  stages: [],
  actions: [],
  showActive: true,
  showArchived: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** ISO weeks start on Monday; `getDay()` puts Sunday at 0. */
function startOfWeek(date: Date): number {
  const day = (date.getDay() + 6) % 7;
  return startOfDay(date) - day * DAY_MS;
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

export interface DateWindow {
  /** Inclusive lower bound; null = unbounded. */
  from: number | null;
  /** Exclusive upper bound; null = unbounded. */
  to: number | null;
}

/** Turn the range choice into concrete bounds. Pure: `now` is injected. */
export function dateWindow(filters: BoardFilters, now: Date = new Date()): DateWindow {
  switch (filters.range) {
    case 'all':
      return { from: null, to: null };
    case 'last30':
      return { from: now.getTime() - 30 * DAY_MS, to: null };
    case 'this_week':
      return { from: startOfWeek(now), to: null };
    case 'last_week': {
      const thisWeek = startOfWeek(now);
      return { from: thisWeek - 7 * DAY_MS, to: thisWeek };
    }
    case 'this_month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: null };
    case 'last_month':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        to: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      };
    case 'custom': {
      const from = parseDay(filters.from);
      const to = parseDay(filters.to);
      return { from, to: to === null ? null : to + DAY_MS };
    }
  }
}

/**
 * A card is dated by its **last change** (`resumes`/`resume_board` `updated_at`), which
 * archive and restore also bump - so a refused card surfaces in the window in which it
 * was refused.
 */
function withinWindow(updatedAt: string, window: DateWindow): boolean {
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return true;
  if (window.from !== null && at < window.from) return false;
  if (window.to !== null && at >= window.to) return false;
  return true;
}

export function matchesQuery(card: BoardCard, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return [
    card.title,
    card.company,
    card.externalId,
    card.sourceUrl ?? '',
    card.archivedReason ?? '',
  ].some((field) => field.toLowerCase().includes(query));
}

/** A card matches when *any* of its history entries carries one of the values. */
export function matchesAction(card: BoardCard, actions: string[]): boolean {
  if (actions.length === 0) return true;
  return card.history.some((entry) => actions.includes(entry.action));
}

export function filterCards(
  cards: BoardCard[],
  filters: BoardFilters,
  now: Date = new Date(),
): BoardCard[] {
  const window = dateWindow(filters, now);
  return cards.filter((card) => {
    // Visibility first: archived is a separate view, never a column.
    if (card.archived ? !filters.showArchived : !filters.showActive) return false;
    if (filters.stages.length > 0 && !filters.stages.includes(card.stage)) return false;
    if (!matchesAction(card, filters.actions)) return false;
    if (!matchesQuery(card, filters.query)) return false;
    return withinWindow(card.updatedAt, window);
  });
}

/** How many filter groups differ from the defaults - the Filters button's badge. */
export function activeFilterCount(
  filters: BoardFilters,
  defaults: BoardFilters = DEFAULT_FILTERS,
): number {
  let count = 0;
  if (filters.query.trim() !== defaults.query) count += 1;
  if (filters.range !== defaults.range) count += 1;
  if (filters.stages.length > 0) count += 1;
  if (filters.actions.length > 0) count += 1;
  if (filters.showActive !== defaults.showActive) count += 1;
  if (filters.showArchived !== defaults.showArchived) count += 1;
  return count;
}

/** `showing 3 of 12 cards` - the guard that keeps a default window from hiding work. */
export function summarize(shown: number, total: number): string {
  return `showing ${shown} of ${total} ${total === 1 ? 'card' : 'cards'}`;
}
