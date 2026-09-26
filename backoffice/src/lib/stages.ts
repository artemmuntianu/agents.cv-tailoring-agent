import type { Actor, BoardCard, HistoryKind, StageId, TailoringStateId } from './types';

export interface StageMeta {
  id: StageId;
  label: string;
  /** One-line explanation shown under the column header. */
  hint: string;
  /** Small badge used on cards. */
  chip: string;
  /** Column header bar. */
  head: string;
}

/** Columns in board order. Class strings are literal so Tailwind can see them. */
export const STAGES: StageMeta[] = [
  {
    id: 'created',
    label: 'Created',
    hint: 'tailored or being tailored',
    chip: 'bg-slate-100 text-slate-700 ring-slate-200',
    head: 'border-slate-300 bg-slate-50',
  },
  {
    id: 'applied',
    label: 'Applied',
    hint: 'CV sent',
    chip: 'bg-sky-100 text-sky-700 ring-sky-200',
    head: 'border-sky-300 bg-sky-50',
  },
  {
    id: 'negotiating',
    label: 'Negotiating',
    hint: 'terms in flight',
    chip: 'bg-amber-100 text-amber-800 ring-amber-200',
    head: 'border-amber-300 bg-amber-50',
  },
  {
    id: 'interviewing',
    label: 'Interviewing',
    hint: 'in the process',
    chip: 'bg-violet-100 text-violet-700 ring-violet-200',
    head: 'border-violet-300 bg-violet-50',
  },
  {
    id: 'offer',
    label: 'Offer',
    hint: 'decision time',
    chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
    head: 'border-emerald-300 bg-emerald-50',
  },
];

export interface TailoringMeta {
  id: TailoringStateId;
  label: string;
  chip: string;
}

/** Sub-states shown on cards that are still in the `created` column. */
export const TAILORING_STATES: TailoringMeta[] = [
  {
    id: 'in_progress',
    label: 'Tailoring In Progress',
    chip: 'bg-amber-100 text-amber-800 ring-amber-200',
  },
  {
    id: 'failed',
    label: 'Tailoring Failed',
    chip: 'bg-rose-100 text-rose-700 ring-rose-200',
  },
  {
    id: 'tailored',
    label: 'Tailored',
    chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  },
];

export function stageMeta(id: StageId): StageMeta {
  return STAGES.find((stage) => stage.id === id) ?? STAGES[0];
}

export function stageLabel(id: string): string {
  return STAGES.find((stage) => stage.id === id)?.label ?? id;
}

export function tailoringMeta(id: TailoringStateId): TailoringMeta {
  return TAILORING_STATES.find((state) => state.id === id) ?? TAILORING_STATES[0];
}

export function tailoringLabel(id: string): string {
  return TAILORING_STATES.find((state) => state.id === id)?.label ?? id;
}

/**
 * The Actor dropdown is the stored vocabulary (`'Candidate' | 'Company'`, see
 * `types.ts`); these hints are the only thing the UI adds to it.
 */
export const ACTOR_HINT: Record<Actor, string> = {
  Candidate: 'you',
  Company: 'the employer',
};

/** Short label for one history entry's kind, used as the line prefix. */
export function historyKindLabel(kind: HistoryKind): string {
  switch (kind) {
    case 'move':
      return 'stage';
    case 'tailoring':
      return 'tailoring';
    case 'archive':
      return 'archived';
    case 'restore':
      return 'restored';
  }
}

/**
 * Render one history transition: `stage: Applied → Interviewing`,
 * `archived: active → refused`, `restored: refused → active`. The archive kinds use
 * their own two-state vocabulary (`active`/`archived`), not column names.
 */
export function describeHistory(kind: HistoryKind, from: string, to: string): string {
  const label = (state: string): string => {
    if (kind === 'move') return stageLabel(state);
    if (kind === 'tailoring') return tailoringLabel(state);
    return state === 'archived' ? 'refused' : 'active';
  };
  return `${historyKindLabel(kind)}: ${label(from)} → ${label(to)}`;
}

/**
 * `⛔️ Rejected by Company • Salary mismatch` - who ended the application, and why. Used
 * by the muted card and by the modal's header.
 */
export function refusalLabel(card: BoardCard): string {
  const who = card.archivedActor === 'Company' ? 'Rejected by Company' : 'Withdrawn by Candidate';
  return card.archivedReason ? `${who} • ${card.archivedReason}` : who;
}

/** True when the string is one of the board's columns (used to validate requests). */
export function isStageId(value: unknown): value is StageId {
  return typeof value === 'string' && STAGES.some((stage) => stage.id === value);
}

/**
 * The `created` sub-state is derived from the worker's own `resumes.status` - the
 * board never writes that column, because it is the worker's claim/idempotency
 * state (`ACTIVE_STATUSES` in `utils/db.py`). Anything still in flight reads as
 * "Tailoring In Progress" (including `submitted`, the row the ingest gateway creates
 * before the message is published - KEDA turns that into `processing` within
 * seconds, so a separate "queued" chip would only flicker), a parked task as
 * "Tailoring Failed", `completed` (or a `skipped` row, which means the result
 * already existed) as "Tailored".
 */
export function tailoringFromStatus(status: string): TailoringStateId {
  switch ((status || '').toLowerCase()) {
    case 'completed':
    case 'skipped':
      return 'tailored';
    case 'failed':
    case 'rate_limited':
    case 'dead_lettered':
      return 'failed';
    case 'submitted':
      return 'in_progress';
    default:
      return 'in_progress';
  }
}

