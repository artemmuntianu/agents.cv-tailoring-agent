import { describe, expect, it } from 'vitest';
import { RELATIVE_DAYS, shortDate, sourceLabel, updatedLabel } from './cardMeta';

/**
 * The card face's two reads, pinned to one instant so the labels are deterministic: 29 Sep 2026,
 * 09:00 local. The interesting assertions are the boundary (a card at exactly `RELATIVE_DAYS`
 * still reads as a distance) and the two ends the distance cannot spell out.
 */

const NOW = new Date(2026, 8, 29, 9, 0, 0);

/** An ISO stamp `days` local calendar days before `NOW`, at noon so no time zone can shift it. */
function daysBefore(days: number): string {
  return new Date(2026, 8, 29 - days, 12, 0, 0).toISOString();
}

describe('the site chip names the site, not the stored slug', () => {
  it('knows every slug the intake can produce', () => {
    expect(sourceLabel('djinni')).toBe('Djinni');
    expect(sourceLabel('dou')).toBe('DOU');
    expect(sourceLabel('greenhouse')).toBe('Greenhouse');
  });

  it('tolerates the case and the whitespace of a stored value', () => {
    expect(sourceLabel('Djinni')).toBe('Djinni');
    expect(sourceLabel('  dou ')).toBe('DOU');
  });

  it('echoes a site it does not know instead of inventing a name for it', () => {
    expect(sourceLabel('work-ua')).toBe('work-ua');
    expect(sourceLabel('')).toBe('unknown site');
  });
});

describe('a card dates by distance while it is fresh', () => {
  it('spells out the two ends the distance cannot', () => {
    expect(updatedLabel(daysBefore(0), NOW)).toBe('today');
    expect(updatedLabel(daysBefore(1), NOW)).toBe('yesterday');
  });

  it('counts days up to the boundary, inclusive', () => {
    expect(updatedLabel(daysBefore(3), NOW)).toBe('3 days ago');
    expect(updatedLabel(daysBefore(RELATIVE_DAYS), NOW)).toBe('9 days ago');
  });

  it('reads a 23:00 change as yesterday at 08:00, not as today', () => {
    const lateLastNight = new Date(2026, 8, 28, 23, 0, 0);
    const thisMorning = new Date(2026, 8, 29, 8, 0, 0);
    expect(updatedLabel(lateLastNight.toISOString(), thisMorning)).toBe('yesterday');
  });
});

describe('an older card shows the day it changed', () => {
  it('gives up the distance one day past the boundary', () => {
    const old = daysBefore(RELATIVE_DAYS + 1);
    expect(updatedLabel(old, NOW)).toBe(shortDate(old));
    expect(updatedLabel(old, NOW)).not.toContain('ago');
  });

  it('dates a card that has been parked for months', () => {
    expect(updatedLabel(new Date(2026, 7, 31, 12, 0, 0).toISOString(), NOW)).toBe(
      shortDate(new Date(2026, 7, 31, 12, 0, 0).toISOString()),
    );
  });

  it('never renders an unreadable stamp as a date', () => {
    expect(updatedLabel('not a date', NOW)).toBe('unknown');
    expect(updatedLabel('', NOW)).toBe('unknown');
  });
});
