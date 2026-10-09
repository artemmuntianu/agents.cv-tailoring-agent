import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CandidateProfile } from '../lib/candidateFacts';
import StandingAnswersEditor from './StandingAnswersEditor';

/**
 * The answering half of the row as the *page* renders it.
 *
 * This is the one place a stored value is rendered rather than a decision made, so it is where the
 * point of the change is pinned: the recruiter answers have to arrive as labelled, readable rows with
 * the editor's own controls, not as the single `JSON.stringify` line the page used to print.
 *
 * `renderToString` is the right tool rather than jsdom: `json-edit-react` is a client component and
 * Astro server-renders exactly this HTML before the island hydrates, so this asserts what the first
 * paint carries.
 */

const PROFILE: CandidateProfile = {
  facts: { full_name: 'Artem Muntianu' },
  standing_answers: {
    'Years of commercial React and TypeScript experience; the largest React project':
      'More than 4 years of active commercial experience.',
    'Years of classic .NET Framework / ASP.NET MVC / Web API experience': 'More than 7 years.',
  },
};

/** React's SSR puts comment separators between adjacent text nodes; read the page, not the markers. */
function rendered(profile: CandidateProfile | null): string {
  return renderToString(<StandingAnswersEditor profile={profile} />).replace(/<!--.*?-->/g, '');
}

describe('rendering the standing answers', () => {
  it('shows each question with its answer instead of stringifying the document', () => {
    const html = rendered(PROFILE);
    expect(html).toContain('Years of commercial React and TypeScript experience');
    expect(html).toContain('More than 4 years of active commercial experience.');
    expect(html).toContain('Years of classic .NET Framework / ASP.NET MVC / Web API experience');
    expect(html).toContain('More than 7 years.');
    // The old rendering was `JSON.stringify(document)` in a <pre>: quoted keys in one line.
    expect(html).not.toContain('&quot;standing_answers&quot;');
  });

  it('carries the editor itself - the tree, its rows and the save control', () => {
    const html = rendered(PROFILE);
    expect(html).toContain('jer-editor-container');
    expect(html).toContain('Standing answers');
    expect(html).toContain('2 of 40');
    const longest = Math.max(...Object.values(PROFILE.standing_answers).map((text) => text.length));
    expect(html).toContain(`longest ${longest} of 3000 chars`);
    expect(html).toContain('Save answers');
    expect(html).toContain('Find a question or an answer');
    // The root name of the tree, so the set is anchored to the row's own key.
    expect(html).toContain('standing_answers');
  });

  it('says the set is empty and how it gets filled, rather than rendering a bare empty row', () => {
    const html = rendered(null);
    expect(html).toContain('0 of 40');
    expect(html).toContain('No standing answers stored');
    expect(html).toContain('scripts/seed_profile.py');
  });
});
