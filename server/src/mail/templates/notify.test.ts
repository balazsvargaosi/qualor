import { allMetricKeys } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { renderAnalysisFailed } from './notify-analysis-failed';
import { metricLabel } from './notify-common';
import { renderGateFailed } from './notify-gate-failed';
import { renderGateRecovered } from './notify-gate-recovered';
import {
  NO_LINKS,
  SAMPLE_ANALYSIS_FAILED,
  SAMPLE_GATE_FAILED,
  SAMPLE_GATE_FAILED_MR,
  SAMPLE_GATE_RECOVERED,
} from './notify-samples';

const BRANCH_URL =
  'https://qualor.example.com/projects/0190a6c2-0000-7000-8000-0000000000b1/branches/0190a6c2-0000-7000-8000-0000000000c1';
// E1 wraps the text part at 76 columns: sentences are asserted on the unwrapped text.
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('project notification templates (mail E3)', () => {
  it.each([
    ['gate failed', () => renderGateFailed(SAMPLE_GATE_FAILED)],
    ['gate failed on a merge request', () => renderGateFailed(SAMPLE_GATE_FAILED_MR)],
    ['gate recovered', () => renderGateRecovered(SAMPLE_GATE_RECOVERED)],
    ['analysis failed', () => renderAnalysisFailed(SAMPLE_ANALYSIS_FAILED)],
  ])(
    '%s: HTML and text under 90 KB, with the watch reason and both footer links',
    (_name, render) => {
      const mail = render();
      expect(Buffer.byteLength(mail.html)).toBeLessThan(90 * 1024);
      for (const part of [mail.html, mail.text]) {
        expect(flat(part)).toContain('You get this because you watch Payments API in Qualor.');
        expect(part).toContain('https://qualor.example.com/unsubscribe#t=sample.token');
        expect(part).toContain('https://qualor.example.com/settings/notifications');
      }
      // E1's footer links: escaped cobalt links in the HTML, `Label: URL` lines in the text part.
      expect(mail.html).toContain('>Stop watching this project</a> · <a ');
      expect(mail.text).toContain(
        'Stop watching this project: https://qualor.example.com/unsubscribe#t=sample.token\nNotification settings: https://qualor.example.com/settings/notifications\n',
      );
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.headers).toBeUndefined();
    },
  );

  it('without a public URL: no link to the instance, and the text says where to go', () => {
    for (const mail of [
      renderGateFailed({ ...SAMPLE_GATE_FAILED, links: NO_LINKS }),
      renderGateRecovered({ ...SAMPLE_GATE_RECOVERED, links: NO_LINKS }),
      renderAnalysisFailed({ ...SAMPLE_ANALYSIS_FAILED, links: NO_LINKS }),
    ]) {
      for (const part of [mail.html, mail.text]) {
        expect(part).not.toContain('qualor.example.com');
        expect(part).not.toContain('/unsubscribe');
        expect(part).not.toContain('Stop watching this project');
        expect(part).toContain('in Qualor');
      }
    }
  });

  it('gate failed: subject, badge, facts, the failing conditions in words, and new-code counts', () => {
    const mail = renderGateFailed(SAMPLE_GATE_FAILED);
    expect(mail.subject).toBe('Payments API: quality gate failed on main');
    expect(mail.html).toContain('The quality gate failed on main');
    expect(mail.html).toContain('Failed');
    expect(mail.html).toContain('Qualor way');
    expect(mail.html).toContain('a1b2c3d');
    expect(mail.html).not.toContain('a1b2c3d4');
    expect(mail.html).toContain(BRANCH_URL);
    expect(mail.html).toContain('inNewCode=true');
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Failing conditions');
      expect(part).toContain('Issues on new code');
      expect(part).toContain('greater than 0');
      expect(part).toContain('Coverage on new code');
      expect(part).toContain('45.5%');
      expect(part).toContain('less than 80%');
      expect(part).toContain('Security rating');
      expect(part).toContain('worse than A');
      // A condition that passed is not listed.
      expect(part).not.toContain('Duplicated lines (%) on new code');
      // `new_low_issues` is null: left out, the others in severity order.
      expect(part).toContain('Blocker 0 · High 1 · Medium 2 · Info 0');
    }
    // E1's text part keeps table cells apart and a link's URL.
    expect(mail.text).toContain('Coverage on new code · 45.5% · less than 80%');
    const newIssues = `${BRANCH_URL.replace(/\/branches\/.*/, '')}/issues?branch=0190a6c2-0000-7000-8000-0000000000c1&inNewCode=true`;
    expect(mail.text).toContain(`(${newIssues})`);
  });

  it('names a merge request, its title and target, and says a re-evaluation changed issues', () => {
    const mail = renderGateFailed(SAMPLE_GATE_FAILED_MR);
    expect(mail.subject).toBe('Payments API: quality gate failed on !42');
    expect(mail.text).toContain('Merge request');
    expect(mail.text).toContain('Refund limits');
    expect(flat(mail.text)).toContain('targets main');
    expect(flat(mail.text)).toContain('after issues were changed');
    expect(flat(renderGateFailed(SAMPLE_GATE_FAILED).text)).not.toContain(
      'after issues were changed',
    );
  });

  it('leaves the new-code line out when no count is known', () => {
    const mail = renderGateFailed({ ...SAMPLE_GATE_FAILED, measures: {} });
    expect(mail.text).not.toContain('New code:');
  });

  it('gate recovered: ok badge, "passes again", and no conditions table', () => {
    const mail = renderGateRecovered(SAMPLE_GATE_RECOVERED);
    expect(mail.subject).toBe('Payments API: quality gate passes again on main');
    expect(mail.html).toContain('The quality gate passes again on main');
    expect(mail.html).toContain('Passed');
    expect(mail.html).not.toContain('Failing conditions');
    expect(mail.html).toContain(BRANCH_URL);
  });

  it('analysis failed: the branch or Unknown, the scanner, and the error clipped to 500 characters', () => {
    const named = renderAnalysisFailed(SAMPLE_ANALYSIS_FAILED);
    expect(named.subject).toBe('Payments API: an analysis of feature/refunds failed');
    expect(named.html).toContain('An analysis of Payments API failed');
    expect(named.html).toContain('Analysis failed');
    expect(named.text).toContain('feature/refunds');
    expect(named.text).toContain('0.7.1');
    expect(named.text).toContain('REPORT_INVALID');
    expect(named.html).toContain(
      'https://qualor.example.com/projects/0190a6c2-0000-7000-8000-0000000000b1',
    );
    const unknown = renderAnalysisFailed({
      ...SAMPLE_ANALYSIS_FAILED,
      branch: null,
      revision: null,
      error: { code: 'PROCESSING_ERROR', message: 'x'.repeat(2000) },
    });
    expect(unknown.subject).toBe('Payments API: an analysis failed');
    expect(unknown.text).toContain('Unknown');
    expect(unknown.text).toContain('PROCESSING_ERROR');
    expect(unknown.text).not.toContain('x'.repeat(501));
  });

  it('escapes names in HTML, and keeps the subject one line of at most 300 characters', () => {
    const mail = renderGateFailed({
      ...SAMPLE_GATE_FAILED,
      project: {
        ...SAMPLE_GATE_FAILED.project,
        name: '<img src=x onerror=alert(1)>\r\nBcc: x@example.com',
      },
      branch: { ...SAMPLE_GATE_FAILED.branch, name: 'b'.repeat(400) },
    });
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject.length).toBeLessThanOrEqual(300);
  });

  it('labels every metric a gate condition may use', () => {
    for (const key of allMetricKeys()) expect(metricLabel(key), key).not.toBe(key);
    expect(metricLabel('new_coverage')).toBe('Coverage on new code');
    expect(metricLabel('coverage')).toBe('Coverage');
  });
});
