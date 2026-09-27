import { useEffect, useRef, useState } from 'react';
import {
  CHANNEL_HINT,
  COMMUNICATION_CHANNELS,
  describeChannels,
  toggleChannel,
} from '../lib/details';
import type { CommunicationChannel } from '../lib/types';

interface ChannelSelectProps {
  value: CommunicationChannel[];
  onChange: (channels: CommunicationChannel[]) => void;
  /** Marks the whole control as unavailable while a save is in flight. */
  disabled?: boolean;
}

/**
 * Communication channel: a multi-select dropdown over the six-value vocabulary.
 *
 * A button that shows what is chosen plus a panel of six checkboxes (`board_actions`-style
 * data would be overkill here - the vocabulary is the DB CHECK, not operator data). It closes on
 * a click outside, on Escape and on *Done*.
 *
 * Escape closes the panel **without** closing the card behind it: the listener runs in the
 * capture phase and stops the event there, because the card modal also listens for Escape on
 * `window` and would otherwise unmount this control's whole card.
 */
export default function ChannelSelect({ value, onChange, disabled = false }: ChannelSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    // Deferred by a tick, so the click that opened the panel does not close it again.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onPointer), 0);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative mt-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm font-normal normal-case tracking-normal text-slate-900 disabled:text-slate-400"
      >
        <span className={value.length > 0 ? '' : 'text-slate-400'}>
          {value.length > 0 ? describeChannels(value) : 'not said yet'}
        </span>
        <span aria-hidden className="text-slate-400">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Communication channel"
          className="absolute left-0 top-full z-30 mt-1 w-full min-w-56 rounded-md border border-slate-200 bg-white p-1 shadow-xl"
        >
          {COMMUNICATION_CHANNELS.map((channel) => {
            const checked = value.includes(channel);
            return (
              <label
                key={channel}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(toggleChannel(value, channel))}
                  className="h-3.5 w-3.5"
                />
                <span className="min-w-0 flex-1 truncate">{channel}</span>
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {CHANNEL_HINT[channel]}
                </span>
              </label>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-1 w-full rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
