import type { RenderedMail } from '../payload';
import { oneLine } from '../text';
import { renderLayout } from './layout';
import {
  branchLabel,
  branchLinks,
  gateFacts,
  gateIntro,
  subjectLine,
  watchFooterLinks,
  watchReason,
  type GateMailInput,
} from './notify-common';

/** mail E3 N2 `gate.recovered`: a watched branch's gate went from failed to passed. */
export function renderGateRecovered(input: GateMailInput): RenderedMail {
  const label = branchLabel(input.branch);
  const { html: body, text } = renderLayout({
    preheader: oneLine(`${input.project.name}: the quality gate passes again on ${label}.`),
    title: oneLine(`The quality gate passes again on ${label}`),
    badge: { text: 'Passed', tone: 'ok' },
    intro: gateIntro(input, 'passes again'),
    facts: gateFacts(input),
    cta: {
      label: oneLine(`Open ${label}`),
      url: branchLinks(input).branch,
      fallbackText: oneLine(
        `Open ${input.project.name} in Qualor, then ${label} under Branches and merge requests.`,
      ),
    },
    reason: watchReason(input.project.name),
    footerLinks: watchFooterLinks(input.links),
    instanceHost: input.links.instanceHost,
  });
  return {
    subject: subjectLine(`${input.project.name}: quality gate passes again on ${label}`),
    html: body,
    text,
  };
}
