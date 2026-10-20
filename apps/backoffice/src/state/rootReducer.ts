import { combineReducers } from 'redux';
import admin from './admin/slice';
import board from './board/slice';
import cover from './cover/slice';
import dialogs from './dialogs/slice';
import filters from './filters/slice';
import vocabulary from './vocabulary/slice';

const rootReducer = combineReducers({ admin, board, cover, dialogs, filters, vocabulary });

export type RootState = ReturnType<typeof rootReducer>;
export default rootReducer;