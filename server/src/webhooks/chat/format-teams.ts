import { branchUrl, issueUrl, projectsUrl, projectUrl, type ChatLinks } from './format';
import type { ChatDigestMessage, ChatGateMessage, ChatMessage, ChatTestMessage } from './messages';
import {
  conditionText,
  digestGateLabel,
  gateTitle,
  localDate,
  newCodeText,
  severityCounts,
  severityLabel,
  shortRevision,
  displayZone,
  teamsText,
  utcTime,
} from './text';

type Element =
  | {
      type: 'TextBlock';
      text: string;
      wrap: true;
      weight?: 'Bolder';
      size?: 'Medium';
      color?: 'Attention' | 'Good';
      spacing?: 'Medium';
    }
  | { type: 'FactSet'; facts: { title: string; value: string }[] };
interface Card {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  type: 'AdaptiveCard';
  version: '1.4';
  msteams: { width: 'Full' };
  body: Element[];
  actions?: { type: 'Action.OpenUrl'; title: string; url: string }[];
}
export interface TeamsBody {
  type: 'message';
  attachments: [
    { contentType: 'application/vnd.microsoft.card.adaptive'; contentUrl: null; content: Card },
  ];
}

const block = (
  text: string,
  extra: Partial<Extract<Element, { type: 'TextBlock' }>> = {},
): Element => ({
  type: 'TextBlock',
  text,
  ...extra,
  wrap: true,
});
const heading = (text: string): Element => block(text, { weight: 'Bolder', spacing: 'Medium' });
/** `[text](url)` with links, else the text. */
const link = (url: string | null, text: string): string =>
  url === null ? text : `[${text}](${url})`;

function message(body: Element[], url: string | null): TeamsBody {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          ...(url === null
            ? {}
            : { actions: [{ type: 'Action.OpenUrl' as const, title: 'Open in Qualor', url }] }),
        },
      },
    ],
  };
}

function gate(m: ChatGateMessage, links: ChatLinks): TeamsBody {
  const failed = m.event === 'gate.failed';
  const counts = newCodeText(m);
  const body: Element[] = [
    block(gateTitle(m, teamsText), {
      weight: 'Bolder',
      size: 'Medium',
      color: failed ? 'Attention' : 'Good',
    }),
  ];
  if (failed) {
    body.push(
      heading('Failing conditions'),
      block(
        [
          ...m.failed.map((c) => `- ${conditionText(c, teamsText)}`),
          ...(m.failedCount > m.failed.length
            ? [`- …and ${m.failedCount - m.failed.length} more`]
            : []),
        ].join('\n'),
      ),
    );
  } else {
    body.push(
      block(
        m.cause === 'reevaluation'
          ? 'All conditions pass after issues were changed.'
          : 'All conditions pass.',
      ),
    );
  }
  body.push({
    type: 'FactSet',
    facts: [
      ...(counts === null ? [] : [{ title: 'New code', value: counts }]),
      ...(m.gate.name === null ? [] : [{ title: 'Gate', value: teamsText(m.gate.name) }]),
      ...(shortRevision(m.revision) === null
        ? []
        : [{ title: 'Commit', value: shortRevision(m.revision) ?? '' }]),
      { title: 'Time', value: utcTime(m.at) },
    ],
  });
  return message(body, branchUrl(links, m.project.id, m.branch.id));
}

function digest(m: ChatDigestMessage, links: ChatLinks): TeamsBody {
  const scopeName = m.scope.project?.name ?? m.scope.organization.name;
  const t = m.totals;
  const zone = displayZone(m.timezone);
  const rows = m.rows.map((r) => {
    const name = link(projectUrl(links, r.projectId), teamsText(r.name, 50));
    const sev = r.newSecurity > 0 ? ` (${severityCounts(r.newBySeverity)})` : '';
    return `- ${name} — ${digestGateLabel(r.gate)} · ${r.newSecurity} new${sev} · ${r.openSecurity} open`;
  });
  const tail = [
    ...(m.moreProjects > 0 ? [`- …and ${m.moreProjects} more projects`] : []),
    ...(m.quietProjects > 0
      ? [
          `- ${m.quietProjects} ${m.rows.length + m.moreProjects > 0 ? 'more ' : ''}project${m.quietProjects === 1 ? '' : 's'}: no new security issues, gate passed`,
        ]
      : []),
  ];
  const top = m.top.map((i) => {
    const where =
      i.path === null ? '' : ` — ${teamsText(i.path + (i.line === null ? '' : `:${i.line}`), 120)}`;
    const rule = link(issueUrl(links, i.projectId, i.id), teamsText(i.ruleName, 80));
    return `- ${severityLabel(i.severity)} · ${teamsText(i.projectName, 50)} · ${rule}${where}`;
  });
  const body: Element[] = [
    block(`Weekly security digest — ${teamsText(scopeName)}`, { weight: 'Bolder', size: 'Medium' }),
    block(
      `Last 7 days · ${localDate(m.since, m.timezone)} – ${localDate(m.until, m.timezone)} (${zone})`,
    ),
    {
      type: 'FactSet',
      facts: [
        { title: 'New security issues', value: String(t.newSecurity) },
        { title: 'New by severity', value: severityCounts(t.newBySeverity) },
        { title: 'Failing quality gates', value: String(t.failing) },
        { title: 'Open security issues', value: String(t.openSecurity) },
      ],
    },
    ...(rows.length + tail.length > 0
      ? [heading('Projects'), block([...rows, ...tail].join('\n'))]
      : []),
    ...(top.length > 0 ? [heading('Top new issues'), block(top.join('\n'))] : []),
    block(`Sent every Monday at 09:00 ${zone}`),
  ];
  const url = m.scope.project === null ? projectsUrl(links) : projectUrl(links, m.scope.project.id);
  return message(body, url);
}

function test(m: ChatTestMessage): TeamsBody {
  const scope =
    m.project === null
      ? `every project of ${teamsText(m.organization.name)}`
      : `the project ${teamsText(m.project.name)}`;
  return message(
    [
      block('Qualor is connected', { weight: 'Bolder', size: 'Medium' }),
      block(
        `This channel will get quality gate failures and recoveries on the main branch, and the weekly security digest, for ${scope}.`,
      ),
    ],
    null,
  );
}

export function formatTeams(m: ChatMessage, links: ChatLinks): TeamsBody {
  switch (m.type) {
    case 'gate':
      return gate(m, links);
    case 'digest':
      return digest(m, links);
    case 'test':
      return test(m);
  }
}
