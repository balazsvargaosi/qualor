import type { RenderedMail } from '../payload';
import { oneLine } from '../text';
import { html } from './html';
import { renderLayout } from './layout';
import {
  branchLabel,
  clip,
  subjectLine,
  watchFooterLinks,
  watchReason,
  type AnalysisFailedMailInput,
} from './notify-common';
import { publicLink } from './text';

/** mail E3 N2 `analysis.failed`: Qualor could not process an analysis of a watched project. */
export function renderAnalysisFailed(input: AnalysisFailedMailInput): RenderedMail {
  const where = input.branch === null ? null : branchLabel(input.branch);
  const error =
    input.error === null ? 'Unknown' : clip(`${input.error.code}: ${input.error.message}`, 500);
  const { html: body, text } = renderLayout({
    preheader: oneLine(`An analysis of ${input.project.name} failed.`),
    title: oneLine(`An analysis of ${input.project.name} failed`),
    badge: { text: 'Analysis failed', tone: 'bad' },
    intro: html`Qualor could not process an analysis of <strong>${input.project.name}</strong>${where === null ? '' : html` on <strong>${where}</strong>`}. The error below says why; the project keeps the results of its last good analysis.`,
    facts: [
      [input.branch?.kind === 'merge_request' ? 'Merge request' : 'Branch', where ?? 'Unknown'],
      ['Revision', input.revision === null ? 'Unknown' : input.revision.slice(0, 7)],
      ['Scanner version', input.scannerVersion ?? 'Unknown'],
      ['Error', error],
    ],
    cta: {
      label: 'Open project',
      url: publicLink(input.links.publicUrl, `/projects/${input.project.id}`),
      fallbackText: oneLine(`Open ${input.project.name} in Qualor.`),
    },
    reason: watchReason(input.project.name),
    footerLinks: watchFooterLinks(input.links),
    instanceHost: input.links.instanceHost,
  });
  return {
    subject: subjectLine(
      where === null
        ? `${input.project.name}: an analysis failed`
        : `${input.project.name}: an analysis of ${where} failed`,
    ),
    html: body,
    text,
  };
}
