import { parseConfig, type QualorConfig } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { AnalyzerId } from '../analyzers/types';
import { incompleteSecretScans } from './run';

/** `qualor.yml` as parsed, with `enabled` set for the named analyzers. */
const config = (enabled: Partial<Record<AnalyzerId, boolean | 'auto'>> = {}): QualorConfig =>
  parseConfig({
    version: 1,
    analyzers: Object.fromEntries(Object.entries(enabled).map(([id, e]) => [id, { enabled: e }])),
  });

const analyzers = (...ids: AnalyzerId[]) => ids.map((id) => ({ id }));
/** The three engines whose findings mask secrets, and one that masks none. */
const ENGINES = analyzers('gitleaks', 'semgrep', 'qualor', 'eslint');
const engines = (...records: [string, 'ok' | 'failed' | 'skipped' | 'timeout'][]) =>
  records.map(([id, status]) => ({ id, status }));

describe('the secret scans that did not complete (6I-2 Review Focus 2, ruling G6)', () => {
  it('finds none when every secret engine ran to the end', () => {
    const ok = engines(['gitleaks', 'ok'], ['semgrep', 'ok'], ['qualor', 'ok'], ['eslint', 'ok']);
    expect(incompleteSecretScans(ENGINES, ok, config(), [])).toEqual([]);
  });

  it.each(['failed', 'timeout'] as const)('counts an engine that %s', (status) => {
    const records = engines(['gitleaks', status], ['semgrep', status], ['qualor', status]);
    expect(
      incompleteSecretScans(ENGINES, records, config(), ['gitleaks', 'semgrep', 'qualor']),
    ).toEqual(['gitleaks', 'semgrep', 'qualor']);
  });

  it('counts a Semgrep or Qualor engine whose tool is unavailable (ruling G6 lists it)', () => {
    const records = engines(['gitleaks', 'ok'], ['semgrep', 'skipped'], ['qualor', 'skipped']);
    expect(incompleteSecretScans(ENGINES, records, config(), ['semgrep', 'qualor'])).toEqual([
      'semgrep',
      'qualor',
    ]);
  });

  it('does not count a Semgrep or Qualor engine that was skipped with nothing to run', () => {
    // Not in ruling G6's list: no rule files, no pack, no file of its languages.
    const records = engines(['gitleaks', 'ok'], ['semgrep', 'skipped'], ['qualor', 'skipped']);
    expect(incompleteSecretScans(ENGINES, records, config(), [])).toEqual([]);
  });

  it('counts Gitleaks whenever it is not ok, a skip included: it scans every repository', () => {
    const skipped = engines(['gitleaks', 'skipped'], ['semgrep', 'ok'], ['qualor', 'ok']);
    expect(incompleteSecretScans(ENGINES, skipped, config(), [])).toEqual(['gitleaks']);
  });

  it('does not count an engine that qualor.yml switches off', () => {
    const records = engines(['gitleaks', 'skipped'], ['semgrep', 'skipped'], ['qualor', 'failed']);
    const off = config({ gitleaks: false, semgrep: false, qualor: false });
    expect(incompleteSecretScans(ENGINES, records, off, ['semgrep', 'qualor'])).toEqual([]);
  });

  it('counts an engine with no record at all, whatever the list says', () => {
    expect(incompleteSecretScans(ENGINES, engines(['gitleaks', 'ok']), config(), [])).toEqual([
      'semgrep',
      'qualor',
    ]);
  });

  it('never counts an engine that masks no secrets', () => {
    expect(
      incompleteSecretScans(analyzers('eslint'), engines(['eslint', 'failed']), config(), [
        'eslint',
      ]),
    ).toEqual([]);
  });
});
