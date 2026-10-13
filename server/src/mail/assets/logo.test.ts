import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOGO_CID, logoPng } from './logo';

describe('the mail logo (E1 spec, M6)', () => {
  const png = readFileSync(new URL('./logo.png', import.meta.url));

  it('is a 56×56 PNG under 4 KB', () => {
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(56);
    expect(png.readUInt32BE(20)).toBe(56);
    expect(png.length).toBeLessThan(4096);
  });

  it('bundles the same bytes as logo.png, under cid logo@qualor', () => {
    expect(logoPng().equals(png)).toBe(true);
    expect(LOGO_CID).toBe('logo@qualor');
  });
});
