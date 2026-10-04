import { describe, expect, it } from 'vitest';
import {
  MAX_DOCX_UPLOAD_BYTES,
  RENDER_STATE_LABEL,
  fileRejection,
  looksLikeDocx,
  renderState,
  safeFilename,
  uploadRejection,
} from './docxUpload';

const docxBytes = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x50; // "P"
  bytes[1] = 0x4b; // "K"
  return bytes;
};

describe('what the board accepts as an updated deliverable', () => {
  it('takes a DOCX whose name and size are sane', () => {
    expect(fileRejection('tailored.docx', 120_000)).toBeNull();
    expect(uploadRejection('tailored.docx', docxBytes())).toBeNull();
  });

  it('refuses anything that is not a .docx, because the PDF is regenerated from it', () => {
    // Live gap this closes: the operator downloads the *PDF* by mistake and uploads that.
    expect(fileRejection('tailored.pdf', 120_000)).toMatch(/DOCX/);
    expect(fileRejection('cv', 120_000)).toMatch(/DOCX/);
    expect(uploadRejection('tailored.pdf', docxBytes())).toMatch(/DOCX/);
  });

  it('refuses an empty file and one over the cap (mirrored from config.py)', () => {
    expect(fileRejection('tailored.docx', 0)).toMatch(/empty/);
    expect(fileRejection('tailored.docx', MAX_DOCX_UPLOAD_BYTES + 1)).toMatch(/larger than/);
    expect(uploadRejection('tailored.docx', new Uint8Array(0))).toMatch(/empty/);
  });

  it('refuses bytes that are not a ZIP container at all', () => {
    expect(looksLikeDocx(docxBytes())).toBe(true);
    expect(looksLikeDocx(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false); // "%PDF"
    expect(uploadRejection('tailored.docx', new Uint8Array([1, 2, 3, 4]))).toMatch(/ZIP/);
  });
});

describe('the name kept in the row', () => {
  it('never carries a path and never surprises the worker', () => {
    expect(safeFilename('C:\\Users\\me\\Downloads\\tailored final.docx')).toBe('tailored final.docx');
    expect(safeFilename('../../etc/passwd.docx')).toBe('passwd.docx');
    expect(safeFilename('weird:name?.docx')).toBe('weird_name_.docx');
    expect(safeFilename('')).toBe('deliverable.docx');
  });
});

describe('the state the modal shows', () => {
  it('maps the worker statuses and treats a missing row as "not updated yet"', () => {
    expect(renderState(null)).toBe('absent');
    expect(renderState({ status: 'running' })).toBe('running');
    expect(renderState({ status: 'COMPLETED' })).toBe('completed');
    // Anything the vocabulary does not know is not a render in flight.
    expect(renderState({ status: 'something-else' })).toBe('absent');
    expect(RENDER_STATE_LABEL.completed).toBe('PDF regenerated');
  });
});
