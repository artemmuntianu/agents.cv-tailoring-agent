import { useState } from 'react';
import { countColumns, groupByStage, sortCards, type SortDirection } from '../lib/board';
import { STAGES } from '../lib/stages';
import type { BoardCard, StageId } from '../lib/types';
import VacancyCard from './VacancyCard';

interface KanbanBoardProps {
  cards: BoardCard[];
  /** Called on drop; the actual move happens only when the dialog is confirmed. */
  onRequestMove: (card: BoardCard, to: StageId) => void;
  onOpen: (jobId: string) => void;
  onArchive: (jobId: string) => void;
  onRestore: (jobId: string) => void;
  onRemove: (jobId: string) => void;
  /** The card's `➕ Add action` button: record a change without moving the card. */
  onAddAction: (jobId: string) => void;
}

/**
 * Five columns; cards are moved with native HTML5 drag & drop.
 *
 * The columns keep a fixed width and the board scrolls **horizontally** (5 x 20rem is wider
 * than a laptop screen), while each column's own card list scrolls vertically.
 *
 * Each header reports `active | ⛔️ archived` and the date sort of its own list (newest
 * first by default, oldest first once flipped), and an archived card is never a drop target:
 * refusing a vacancy keeps it *in place*, so a refused card that could still be dragged would
 * defeat the whole idea (the card itself also refuses to start a drag).
 */
export default function KanbanBoard({
  cards,
  onRequestMove,
  onOpen,
  onArchive,
  onRestore,
  onRemove,
  onAddAction,
}: KanbanBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<StageId | null>(null);
  // Per column, in memory only: the board re-reads the database every few seconds, and a sort
  // order is a way of reading it rather than board state.
  const [sort, setSort] = useState<Partial<Record<StageId, SortDirection>>>({});
  const columns = groupByStage(cards);
  const counts = countColumns(cards);

  return (
    <div className="flex flex-1 gap-4 overflow-x-auto overflow-y-hidden p-4">
      {columns.map(({ stage, cards: stageCards }) => {
        const meta = STAGES.find((item) => item.id === stage) ?? STAGES[0];
        const isHovered = hoverStage === stage;
        const column = counts.find((item) => item.stage === stage) ?? { active: 0, archived: 0, total: 0 };
        const direction: SortDirection = sort[stage] ?? 'desc';
        const columnCards = sortCards(stageCards, direction);

        return (
          <section
            key={stage}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setHoverStage(stage);
            }}
            onDragLeave={() => setHoverStage((current) => (current === stage ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setHoverStage(null);
              const jobId = event.dataTransfer.getData('text/plain');
              const card = cards.find((item) => item.jobId === jobId);
              setDraggingId(null);
              if (card && !card.archived && card.stage !== stage) onRequestMove(card, stage);
            }}
            className={[
              // A fixed width, not a fifth of the viewport: five columns are wider than most
              // screens on purpose, and the board scrolls sideways (`w-80` is the knob).
              'flex min-h-0 w-80 min-w-80 shrink-0 flex-col rounded-lg border bg-slate-50/60',
              isHovered ? 'border-slate-400 bg-slate-100' : 'border-slate-200',
            ].join(' ')}
          >
            <header className={`rounded-t-lg border-b px-3 py-2 ${meta.head}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">{meta.label}</h2>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) => ({
                        ...current,
                        [stage]: direction === 'desc' ? 'asc' : 'desc',
                      }))
                    }
                    title="Sort this column by the card's last change"
                    aria-label={
                      `Sort ${meta.label} by ` +
                      (direction === 'desc' ? 'oldest first' : 'newest first')
                    }
                    className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-100"
                  >
                    {direction === 'desc' ? '↓ Newest' : '↑ Oldest'}
                  </button>
                  <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
                    <span>{column.active}</span>
                  {column.archived > 0 && (
                    <>
                      <span className="text-slate-300" aria-hidden>
                        |
                      </span>
                      <span className="text-rose-600" title={`${column.archived} refused`}>
                        ⛔️ {column.archived}
                      </span>
                    </>
                  )}
                  </span>
                </span>
              </div>
              <p className="text-[11px] text-slate-500">{meta.hint}</p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {columnCards.map((card) => (
                <VacancyCard
                  key={card.jobId}
                  card={card}
                  dragging={draggingId === card.jobId}
                  onDragStart={setDraggingId}
                  onDragEnd={() => setDraggingId(null)}
                  onOpen={onOpen}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onRemove={onRemove}
                  onAddAction={onAddAction}
                />
              ))}
              {columnCards.length === 0 && (
                <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-[11px] text-slate-400">
                  drag a card here
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
