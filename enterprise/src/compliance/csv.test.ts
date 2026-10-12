// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import { csvCell, csvRows } from './csv';
import { sampleReport } from './test-report';

describe('csvRows (4E-1 §2.5)', () => {
  it('starts with a BOM and the header, one column per standard', () => {
    const [head] = csvRows(sampleReport());
    expect(
      head!.startsWith(
        '﻿section,project,path,line,rule,rule_name,engine,severity,kind,cwe,status,in_new_code,first_seen_at,s,triage_by,triage_at,triage_comment\r\n',
      ),
    ).toBe(true);
  });
  it('writes open findings, then triage rows', () => {
    const lines = [...csvRows(sampleReport())];
    expect(lines[1]).toBe(
      'code,alpha,a.ts,1,semgrep:sqli,SQLi,semgrep,high,issue,89,open,true,2026-01-01T00:00:00.000Z,A;B,,,\r\n',
    );
    expect(lines.at(-1)).toMatch(
      /^code,alpha,c\.ts,3,semgrep:sqli,,,high,,89,false_positive,,,A;B,Ann,2026-05-01T00:00:00\.000Z,"not reachable, see ""ADR-7"""\r\n$/,
    );
  });
  it('quotes and neutralises formulas (Review Focus 3)', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-1')).toBe(`'-1`);
    expect(csvCell('@a')).toBe(`'@a`);
    expect(csvCell('\tx')).toBe(`'\tx`);
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('x'.repeat(10_000))).toHaveLength(10_000);
    expect(csvCell('路径/文件.ts')).toBe('路径/文件.ts');
  });
});
