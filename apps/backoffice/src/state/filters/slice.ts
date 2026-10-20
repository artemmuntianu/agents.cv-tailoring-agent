import { DEFAULT_FILTERS, type BoardFilters } from '../../lib/filters';
import type { StageId } from '../../lib/types';

export const FILTERS_CHANGED = 'filters/changed';
export const FILTERS_RESET = 'filters/reset';

export interface FiltersChangedAction {
  type: typeof FILTERS_CHANGED;
  filters: BoardFilters;
}
export interface FiltersResetAction {
  type: typeof FILTERS_RESET;
}
export type FiltersAction = FiltersChangedAction | FiltersResetAction;

export const filtersChanged = (filters: BoardFilters): FiltersChangedAction => ({
  type: FILTERS_CHANGED,
  filters,
});
export const filtersReset = (): FiltersResetAction => ({ type: FILTERS_RESET });

/** The panel's stage chip: an empty array means "every column". */
export function toggleStage(filters: BoardFilters, stage: StageId): BoardFilters {
  const stages = filters.stages.includes(stage)
    ? filters.stages.filter((item) => item !== stage)
    : [...filters.stages, stage];
  return { ...filters, stages };
}

/** The panel's action checkbox: a card matches when any history entry carries it. */
export function toggleAction(filters: BoardFilters, value: string): BoardFilters {
  const actions = filters.actions.includes(value)
    ? filters.actions.filter((item) => item !== value)
    : [...filters.actions, value];
  return { ...filters, actions };
}

export default function filtersReducer(
  state: BoardFilters = DEFAULT_FILTERS,
  action: FiltersAction,
): BoardFilters {
  switch (action.type) {
    case FILTERS_CHANGED:
      return action.filters;
    case FILTERS_RESET:
      return DEFAULT_FILTERS;
    default:
      return state;
  }
}