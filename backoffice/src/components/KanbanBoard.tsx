import { useState } from 'react';
import { countColumns, groupByStage } from '../lib/board';
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
}

/**
 * Five columns; cards are moved with native HTML5 drag & drop.
 *
 * Each header reports `active | ⛔️ archived`, and an archived card is never a drop
 * target: refusing a vacancy keeps it *in place*, so a refused card that could still be
 * dragged would defeat the whole idea (the card itself also refuses to start a drag).
 */
export default function KanbanBoard({
  cards,
  onRequestMove,
  onOpen,
  onArchive,
  onRestore,
}: KanbanBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<StageId | null>(null);
  const columns = groupByStage(cards);
  const counts = countColumns(cards);

  return (
    <div className="grid flex-1 grid-cols-5 gap-4 overflow-hidden p-4">
      {columns.map(({ stage, cards: columnCards }) => {
        const meta = STAGES.find((item) => item.id === stage) ?? STAGES[0];
        const isHovered = hoverStage === stage;
        const column = counts.find((item) => item.stage === stage) ?? { active: 0, archived: 0, total: 0 };

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
              'flex min-h-0 flex-col rounded-lg border bg-slate-50/60',
              isHovered ? 'border-slate-400 bg-slate-100' : 'border-slate-200',
            ].join(' ')}
          >
            <header className={`rounded-t-lg border-b px-3 py-2 ${meta.head}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">{meta.label}</h2>
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
