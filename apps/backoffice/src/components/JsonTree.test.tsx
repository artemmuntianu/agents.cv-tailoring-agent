import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import JsonTree from './JsonTree';

/**
 * The shared tree `/sources` renders every JSON document with.
 *
 * Two things have to hold for it to be the right surface for both callers, and neither is visible
 * from the props: a document arrives as its own keys with their values (not as flattened lines), and
 * `readOnly` really is a *viewer* - the artifact files must not offer a control whose write has
 * nowhere to go (the board reads the volume and never writes it).
 */

const MODEL = {
  header: { title: 'Senior Software Engineer' },
  summary: 'Twenty years of it.',
  professional_experience: [{ role: 'Lead', company_info: 'Acme' }],
};

function rendered(node: React.ReactElement): string {
  return renderToString(node).replace(/<!--.*?-->/g, '');
}

describe('the shared JSON tree', () => {
  it('renders a document as its own keys and values', () => {
    const html = rendered(<JsonTree data={MODEL} rootName="cv_data.json" readOnly />);
    expect(html).toContain('cv_data.json');
    expect(html).toContain('professional_experience');
    expect(html).toContain('company_info');
    expect(html).toContain('Twenty years of it.');
    expect(html).toContain('Find a key or a value');
  });

  it('is a viewer when it is read-only: no edit, add or delete control is rendered', () => {
    const html = rendered(<JsonTree data={MODEL} rootName="cv_data.json" readOnly />);
    // The value is still worth copying out of the page.
    expect(html).toContain('aria-label="Copy');
    expect(html).not.toContain('aria-label="Edit');
    expect(html).not.toContain('aria-label="Add');
    expect(html).not.toContain('aria-label="Remove');
  });

  it('hands the edit controls to a caller that owns the document', () => {
    const html = rendered(
      <JsonTree
        data={{ Question: 'An answer.' }}
        rootName="standing_answers"
        searchPlaceholder="Find a question or an answer"
        customText={{ TOOLTIP_EDIT: () => 'Edit this answer' }}
      />,
    );
    expect(html).toContain('aria-label="Edit this answer');
    expect(html).toContain('Find a question or an answer');
  });
});
