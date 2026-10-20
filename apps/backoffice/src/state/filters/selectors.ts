import { activeFilterCount } from '../../lib/filters';
import type { RootState } from '../store';

export const selectFilters = (state: RootState) => state.filters;
export const selectActiveFilterCount = (state: RootState) => activeFilterCount(state.filters);