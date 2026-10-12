// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import { parseAsvsCsv, parseCweTop25Html, parseOwaspTop10Markdown } from './parse';

// Excerpts copied from the saved sources (sources/owasp-top10-2021/A03.md, owasp-top10-2025/A05.md).
const OWASP_2021_A03 = `# A03:2021 – Injection    ![icon](assets/TOP_10_Icons_Final_Injection.png){: style="height:80px;width:80px" align="right"}

## Overview

Injection slides down to the third position. 94% of the applications
were tested for some form of injection with a max incidence rate of 19%, an average incidence rate of 3%, and 274k occurrences. Notable Common Weakness Enumerations (CWEs) included are
*CWE-79: Cross-site Scripting*, *CWE-89: SQL Injection*, and *CWE-73:
External Control of File Name or Path*.

## List of Mapped CWEs

[CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)

[CWE-74 Improper Neutralization of Special Elements in Output Used by a
Downstream Component ('Injection')](https://cwe.mitre.org/data/definitions/74.html)

[CWE-917 Improper Neutralization of Special Elements used in an Expression Language Statement ('Expression Language Injection')](https://cwe.mitre.org/data/definitions/917.html)

[CWE-89 Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')](https://cwe.mitre.org/data/definitions/89.html)
`;

const OWASP_2025_A05 = `# A05:2025 Injection ![icon](../assets/TOP_10_Icons_Final_Injection.png){: style="height:80px;width:80px" align="right"}

## Background.

Injection falls two spots from #3 to #5 in the ranking, maintaining its position relative to A04:2025-Cryptographic Failures and A06:2025-Insecure Design.

## List of Mapped CWEs

* [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)

* [CWE-89 Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')](https://cwe.mitre.org/data/definitions/89.html)

## A heading the real files do not have

[CWE-1 Not mapped](https://cwe.mitre.org/data/definitions/1.html)
`;

// The head and the first row of the ranked table in sources/cwe-top25-2025/2025_cwe_top25.html.
const TOP25_HEAD = `<table id="Detail" style="margin-left:auto; margin-right:auto;" border="2" cellpadding="2" cellspacing="2">
<thead><tr>
    <th width="60px">Rank</th>
    <th width="90px">ID</th>
    <th class="top25name">Name</th><th width="80px">Score</th>
    <th width="60px">CVEs in KEV</th>
    <th width="60px">Rank Change vs. 2024</th>
</tr></thead>
`;
/** The real row shape, with the rank, id and name substituted. */
const top25Row = (rank: number, cwe: number, name: string): string => `
<tr>
    <td style="text-align:center;"><b>${rank}</b></td>
    <td style="text-align:center;"><a target="_blank" rel="noopener noreferrer" href="/data/definitions/${cwe}.html" title="${name}">CWE-${cwe}</a></td>
    <td>${name}</td>
    <td style="text-align:center;">60.38</td>
    <td style="text-align:center;">7</td>
    <td style="text-align:center;">0</td>
</tr>
`;
const XSS =
  'Improper Neutralization of Input During Web Page Generation (&#x27;Cross-site Scripting&#x27;)';
// The page repeats the list below the table; the parser reads the table only.
const TOP25_LIST = `
<ol class="boxlist">
<li>
    <span class="list_entry">
        <span class="list_title">${XSS}</span>
        <br />
        <span class="list_id"><a href="/data/definitions/79.html" title="${XSS}" target="_blank" rel="noopener noreferrer">CWE-79</a></span>
`;
const top25 = (count: number): string =>
  `<html>${TOP25_HEAD}${Array.from({ length: count }, (_, i) =>
    i === 0 ? top25Row(1, 79, XSS) : top25Row(i + 1, 100 + i, `Name ${i + 1}`),
  ).join('')}</table>${TOP25_LIST}</html>`;

// The header and four rows of sources/asvs-4.0.3/…-en.csv (CRLF line ends, then one blank LF line).
const ASVS = [
  'chapter_id,chapter_name,section_id,section_name,req_id,req_description,level1,level2,level3,cwe,nist\r\n',
  'V5,"Validation, Sanitization and Encoding",V5.3,Output Encoding and Injection Prevention,V5.3.4,"Verify that data selection or database queries (e.g. SQL, HQL, ORM, NoSQL) use parameterized queries, ORMs, entity frameworks, or are otherwise protected from database injection attacks. ([C3](https://owasp.org/www-project-proactive-controls/#div-numbering))",✓,✓,✓,89,\r\n',
  'V5,"Validation, Sanitization and Encoding",V5.3,Output Encoding and Injection Prevention,V5.3.3,"Verify that context-aware, preferably automated - or at worst, manual - output escaping protects against reflected, stored, and DOM based XSS. ([C4](https://owasp.org/www-project-proactive-controls/#div-numbering))",✓,✓,✓,79,\r\n',
  'V2,Authentication,V2.1,Password Security,V2.1.1,Verify that user set passwords are at least 12 characters in length (after multiple spaces are combined). ([C6](https://owasp.org/www-project-proactive-controls/#div-numbering)),✓,✓,✓,521,5.1.1.2\r\n',
  'V10,Malicious Code,V10.1,Code Integrity,V10.1.1,"Verify that a code analysis tool is in use that can detect potentially malicious code, such as time functions, unsafe file operations and network connections.",,,✓,749,\r\n',
  '\n',
].join('');

describe('standards parsers (4E-1 §2.2)', () => {
  it('reads the mapped CWEs of an OWASP Top 10 2021 category page', () => {
    expect(parseOwaspTop10Markdown(OWASP_2021_A03, 'A03')).toEqual({
      id: 'A03',
      title: 'Injection',
      cwe: [20, 74, 89, 917],
    });
  });

  it('reads a 2025 page, whose title has no dash, up to the next heading', () => {
    expect(parseOwaspTop10Markdown(OWASP_2025_A05, 'A05')).toEqual({
      id: 'A05',
      title: 'Injection',
      cwe: [20, 89],
    });
  });

  it('refuses a page of another category or without mapped CWEs', () => {
    expect(() => parseOwaspTop10Markdown(OWASP_2021_A03, 'A04')).toThrow(/A03/);
    expect(() =>
      parseOwaspTop10Markdown(OWASP_2021_A03.replace('List of Mapped CWEs', 'References'), 'A03'),
    ).toThrow(/List of Mapped CWEs/);
  });

  it('reads 25 ranked CWE ids from the Top 25 table, not from the list below it', () => {
    const parsed = parseCweTop25Html(top25(25));
    expect(parsed).toHaveLength(25);
    expect(parsed[0]).toEqual({
      id: '1',
      title:
        "CWE-79 Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')",
      cwe: [79],
    });
    expect(parsed[24]).toEqual({ id: '25', title: 'CWE-124 Name 25', cwe: [124] });
  });

  it('refuses a Top 25 table that does not hold exactly 25 ranked rows', () => {
    expect(() => parseCweTop25Html(top25(24))).toThrow(/25/);
    expect(() => parseCweTop25Html(top25(26))).toThrow(/25/);
    expect(() => parseCweTop25Html('<html></html>')).toThrow(/table/);
  });

  it('groups ASVS 4.0.3 requirements by chapter, in chapter order, with their CWE ids', () => {
    expect(parseAsvsCsv(ASVS)).toEqual([
      { id: 'V2', title: 'Authentication', cwe: [521] },
      { id: 'V5', title: 'Validation, Sanitization and Encoding', cwe: [79, 89] },
      { id: 'V10', title: 'Malicious Code', cwe: [749] },
    ]);
  });

  it('reads quoted CSV fields with doubled quotes and line breaks', () => {
    const csv = 'chapter_id,chapter_name,cwe\nV1,"A ""quoted"",\r\nname",20\n';
    expect(parseAsvsCsv(csv)).toEqual([{ id: 'V1', title: 'A "quoted",\r\nname', cwe: [20] }]);
  });
});
