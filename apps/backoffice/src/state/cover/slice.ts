import type { CoverLetterState } from '../../lib/types';

/** The `vacancy` block `GET /api/cover/<job_id>` returns beside the letter. */
export interface CoverVacancy {
  jobId: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  hasDescription: boolean;
}

export interface CoverPayload extends CoverLetterState {
  vacancy: CoverVacancy | null;
}

export interface CoverState {
  payload: CoverPayload | null;
  error: string;
  loading: boolean;
  asking: boolean;
}

export const initialCoverState: CoverState = { payload: null, error: '', loading: true, asking: false };

export const COVER_REQUESTED = 'cover/requested';
export const COVER_LOADED = 'cover/loaded';
export const COVER_FAILED = 'cover/failed';
export const COVER_ASK_REQUESTED = 'cover/askRequested';
export const COVER_ASKING = 'cover/asking';

export interface CoverRequestedAction { type: typeof COVER_REQUESTED; jobId: string }
export interface CoverLoadedAction { type: typeof COVER_LOADED; payload: CoverPayload }
export interface CoverFailedAction { type: typeof COVER_FAILED; error: string }
export interface CoverAskRequestedAction { type: typeof COVER_ASK_REQUESTED; jobId: string }
export interface CoverAskingAction { type: typeof COVER_ASKING; asking: boolean }

export type CoverAction =
  | CoverRequestedAction
  | CoverLoadedAction
  | CoverFailedAction
  | CoverAskRequestedAction
  | CoverAskingAction;

export const coverRequested = (jobId: string): CoverRequestedAction => ({ type: COVER_REQUESTED, jobId });
export const coverLoaded = (payload: CoverPayload): CoverLoadedAction => ({ type: COVER_LOADED, payload });
export const coverFailed = (error: string): CoverFailedAction => ({ type: COVER_FAILED, error });
export const coverAskRequested = (jobId: string): CoverAskRequestedAction => ({
  type: COVER_ASK_REQUESTED,
  jobId,
});
export const coverAsking = (asking: boolean): CoverAskingAction => ({ type: COVER_ASKING, asking });

export default function coverReducer(state: CoverState = initialCoverState, action: CoverAction): CoverState {
  switch (action.type) {
    case COVER_LOADED:
      return { ...state, payload: action.payload, error: '', loading: false };
    case COVER_FAILED:
      return { ...state, error: action.error, loading: false };
    case COVER_ASKING:
      return { ...state, asking: action.asking };
    default:
      return state;
  }
}