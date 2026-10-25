import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_SECRET_PATTERN } from '../server/src/scm/github/app-auth';

/**
 * The UI never imports the server (AGENTS.md rule 5), so the forms that set a connection's webhook
 * secret keep a copy of the pattern the server checks, in one module that both pages use. This test
 * reads the UI's sources as text and keeps the copy equal to the server's.
 */
const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('the UI and the server accept the same webhook secrets', () => {
  it('the UI’s pattern is the server’s: the same source and the same flags', () => {
    const found = /^export const WEBHOOK_SECRET = \/(.+)\/([a-z]*);$/m.exec(
      read('ui/src/app/settings/webhook-secret.ts'),
    );
    expect(found).not.toBeNull();
    const [, source, flags] = found!;
    expect(source).toBe(WEBHOOK_SECRET_PATTERN.source);
    expect(flags).toBe(WEBHOOK_SECRET_PATTERN.flags);
  });

  it.each(['gitlab', 'github'])('the %s page uses it, and has no pattern of its own', (page) => {
    const source = read(`ui/src/app/settings/${page}.page.ts`);
    expect(source).toContain("import { WEBHOOK_SECRET } from './webhook-secret';");
    expect(source).not.toMatch(/WEBHOOK_SECRET = /);
    expect(source).not.toContain('\\x21-\\x7e');
  });
});
