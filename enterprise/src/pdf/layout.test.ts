// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDocument } from './layout';

const INPUT = {
  title: 'A title',
  author: 'Ann Admin',
  date: new Date('2026-10-13T09:30:00.000Z'),
  subject: 'The subject line',
};

async function render(input: typeof INPUT): Promise<Buffer> {
  const { doc, done } = createDocument(input);
  doc.addPage();
  doc.font('bold').text('Hello');
  doc.end();
  return done;
}

describe('createDocument', () => {
  it('gives the same bytes for the same inputs', async () => {
    const a = await render(INPUT);
    const b = await render({ ...INPUT, date: new Date(INPUT.date) });
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
  });

  it('writes the given subject and date into the info fields', async () => {
    const pdf = await render(INPUT);
    const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
    const { info } = await doc.getMetadata();
    expect(info).toMatchObject({
      Title: 'A title',
      Author: 'Ann Admin',
      Subject: 'The subject line',
      CreationDate: 'D:20261013093000Z',
      ModDate: 'D:20261013093000Z',
    });
  });

  it('changes the bytes when an info field changes', async () => {
    const a = await render(INPUT);
    const b = await render({ ...INPUT, date: new Date('2026-10-13T09:30:01.000Z') });
    expect(a.equals(b)).toBe(false);
  });
});
