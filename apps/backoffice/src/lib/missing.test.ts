import { describe, expect, it } from 'vitest';
import {
  COMPANY_FIELD,
  MAX_COMPANY_LENGTH,
  missingFields,
  missingRequest,
  resolveCompany,
} from './missing';

describe('the Missing fields the Move dialog offers', () => {
  it('asks for the company only when the card has none', () => {
    expect(missingFields({ company: '' })).toEqual([COMPANY_FIELD]);
    expect(missingFields({ company: '   ' })).toEqual([COMPANY_FIELD]);
    expect(missingFields({ company: 'Binariks' })).toEqual([]);
    // A card with a company the operator already typed passes straight through.
    expect(missingFields({ company: ' New Wave Devs ' })).toEqual([]);
  });

  it('turns the typed values into a request fragment, dropping the empty ones', () => {
    expect(missingRequest({ company: '  Acme   Data ' })).toEqual({ company: 'Acme Data' });
    expect(missingRequest({ company: '   ' })).toEqual({});
    expect(missingRequest({})).toEqual({});
    expect(missingRequest(undefined)).toEqual({});
    // Longer than the column's own scrape limit is cut, never sent as something the batch
    // contract would refuse.
    expect(missingRequest({ company: 'x'.repeat(400) }).company).toHaveLength(MAX_COMPANY_LENGTH);
  });
});

describe('resolving the company for one move', () => {
  it('lets the stored value win over anything typed', () => {
    expect(resolveCompany('Binariks', 'Acme')).toEqual({ company: 'Binariks', fill: null });
  });

  it('fills a blank: the same value is written and published', () => {
    expect(resolveCompany(null, 'Acme Data')).toEqual({ company: 'Acme Data', fill: 'Acme Data' });
    expect(resolveCompany('', ' Acme ')).toEqual({ company: 'Acme', fill: 'Acme' });
  });

  it('stays blank when nobody typed one - and never writes on its own', () => {
    expect(resolveCompany(null, null)).toEqual({ company: '', fill: null });
    expect(resolveCompany('   ', '   ')).toEqual({ company: '', fill: null });
    expect(resolveCompany(undefined, undefined).fill).toBeNull();
  });
});
