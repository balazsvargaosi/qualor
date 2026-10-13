import type { RenderedMail } from '../payload';
import { oneLine } from '../text';
import { html } from './html';
import { renderLayout } from './layout';
import {
  branchLabel,
  branchLinks,
  failingConditions,
  gateFacts,
  gateIntro,
  newCodeCounts,
  paragraph,
  subjectLine,
  watchFooterLinks,
  watchReason,
  type GateMailInput,
} from './notify-common';

/** mail E3 N2 `gate.failed`: a watched branch's gate became failed. */
export function renderGateFailed(input: GateMailInput): RenderedMail {
  const label = branchLabel(input.branch);
  const urls = branchLinks(input);
  const conditions = failingConditions(input.gate);
  const counts = newCodeCounts(input.measures);
  const { html: body, text } = renderLayout({
    preheader: oneLine(`${input.project.name}: the quality gate failed on ${label}.`),
    title: oneLine(`The quality gate failed on ${label}`),
    badge: { text: 'Failed', tone: 'bad' },
    intro: gateIntro(input, 'failed'),
    facts: gateFacts(input),
    cta: {
      label: oneLine(`Open ${label}`),
      url: urls.branch,
      fallbackText: oneLine(
        `Open ${input.project.name} in Qualor, then ${label} under Branches and merge requests.`,
      ),
    },
    after: html`${conditions ?? ''}${counts === null ? '' : paragraph(html`<strong>New code:</strong> ${counts}`)}${urls.newIssues === null ? '' : paragraph(html`<a href="${urls.newIssues}" style="color:#1f5fbf">New issues</a>`)}`,
    reason: watchReason(input.project.name),
    footerLinks: watchFooterLinks(input.links),
    instanceHost: input.links.instanceHost,
  });
  return {
    subject: subjectLine(`${input.project.name}: quality gate failed on ${label}`),
    html: body,
    text,
  };
}
