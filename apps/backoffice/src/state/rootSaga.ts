import { all, fork } from 'redux-saga/effects';
import adminSaga from './admin/sagas';
import boardSaga from './board/sagas';
import coverSaga from './cover/sagas';

export default function* rootSaga() {
  yield all([fork(adminSaga), fork(boardSaga), fork(coverSaga)]);
}