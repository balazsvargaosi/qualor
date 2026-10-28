import type { ItemOf } from '../../api/types';
import { formatWhole } from '../../shared/numbers';
import type { AiReviewScope } from '../ai-review';

type Project = ItemOf<'/api/v0/projects'>;

/**
 * What AI review does with a project it was given: reviews its merge requests, cannot until the
 * project is linked to a repository, or never, because an instance admin excluded it from AI.
 */
export type ChosenState = 'reviewed' | 'not_linked' | 'excluded';

/** A chosen project's state. Excluded comes first: linking an excluded project changes nothing. */
export function chosenState(p: Pick<Project, 'scmConnectionId' | 'autoFix'>): ChosenState {
  if (p.autoFix.excludedFromAi) return 'excluded';
  return p.scmConnectionId === null ? 'not_linked' : 'reviewed';
}

/** The projects a scope and selection give AI review, counted by what it does with them. */
export interface SelectionSummary {
  total: number;
  reviewable: number;
  notLinked: number;
  excluded: number;
}

/**
 * Counts the projects AI review would be given: every project of the list for `all`, else the
 * selected ones the list holds, each once (an id it does not hold is no project to count).
 */
export function selectionSummary(
  projects: readonly Project[],
  scope: AiReviewScope,
  selected: readonly string[],
): SelectionSummary {
  let chosen: readonly Project[] = projects;
  if (scope === 'selected') {
    const ids = new Set(selected);
    chosen = projects.filter((p) => ids.has(p.id));
  }
  const summary: SelectionSummary = { total: 0, reviewable: 0, notLinked: 0, excluded: 0 };
  for (const project of chosen) {
    summary.total++;
    const state = chosenState(project);
    if (state === 'reviewed') summary.reviewable++;
    else if (state === 'not_linked') summary.notLinked++;
    else summary.excluded++;
  }
  return summary;
}

/** The sentence for a selection that can be reviewed whole. */
function allReviewableText(
  s: SelectionSummary,
  scope: AiReviewScope,
  organization: string,
  total: string,
): string {
  if (scope === 'all') {
    return s.total === 1
      ? $localize`:@@orgAi.summary.allProjectsOne:The 1 project of ${organization}:org: will be reviewed.`
      : $localize`:@@orgAi.summary.allProjects:All ${total}:count: projects of ${organization}:org: will be reviewed.`;
  }
  return s.total === 1
    ? $localize`:@@orgAi.summary.allSelectedOne:1 selected project will be reviewed.`
    : $localize`:@@orgAi.summary.allSelected:${total}:count: selected projects will be reviewed.`;
}

/** What keeps some projects from being reviewed, as a list of counts: not linked, excluded. */
function notReviewableParts(
  s: SelectionSummary,
  n: (count: number) => string,
  locale: string,
): string {
  return new Intl.ListFormat(locale, { type: 'unit', style: 'long' }).format([
    ...(s.notLinked > 0
      ? [
          s.notLinked === 1
            ? $localize`:@@orgAi.summary.notLinkedOne:1 not linked to a repository`
            : $localize`:@@orgAi.summary.notLinked:${n(s.notLinked)}:count: not linked to a repository`,
        ]
      : []),
    ...(s.excluded > 0
      ? [
          s.excluded === 1
            ? $localize`:@@orgAi.summary.excludedOne:1 excluded from AI`
            : $localize`:@@orgAi.summary.excluded:${n(s.excluded)}:count: excluded from AI`,
        ]
      : []),
  ]);
}

/**
 * The summary in one sentence, in counts rather than names so it reads the same for any number
 * of projects: "1 of 3 selected projects can be reviewed: 1 not linked to a repository, 1 excluded
 * from AI." The counts are grouped as `locale` writes numbers.
 */
export function summaryText(
  s: SelectionSummary,
  scope: AiReviewScope,
  organization: string,
  locale = 'en-US',
): string {
  const n = (count: number) => formatWhole(count, locale);
  const total = n(s.total);
  const reviewable = n(s.reviewable);
  if (s.total === 0) {
    return scope === 'all'
      ? $localize`:@@orgAi.summary.noProjects:${organization}:org: has no project yet.`
      : $localize`:@@orgAi.summary.none:No project is selected yet: choose projects below first.`;
  }
  if (s.reviewable === s.total) return allReviewableText(s, scope, organization, total);
  const parts = notReviewableParts(s, n, locale);
  if (scope === 'all') {
    return s.total === 1
      ? $localize`:@@orgAi.summary.someAllOne:${reviewable}:reviewable: of the 1 project of ${organization}:org: can be reviewed: ${parts}:parts:.`
      : $localize`:@@orgAi.summary.someAll:${reviewable}:reviewable: of the ${total}:total: projects of ${organization}:org: can be reviewed: ${parts}:parts:.`;
  }
  return s.total === 1
    ? $localize`:@@orgAi.summary.someOne:${reviewable}:reviewable: of 1 selected project can be reviewed: ${parts}:parts:.`
    : $localize`:@@orgAi.summary.some:${reviewable}:reviewable: of ${total}:total: selected projects can be reviewed: ${parts}:parts:.`;
}

/**
 * The summary as the switch-on dialog says it: as `summaryText`, except with no project selected,
 * where it says what that means rather than pointing to the picker, which is not in the dialog.
 */
export function dialogSummaryText(
  s: SelectionSummary,
  scope: AiReviewScope,
  organization: string,
  locale = 'en-US',
): string {
  return s.total === 0 && scope === 'selected'
    ? $localize`:@@orgAi.dialog.none:No project is selected yet, so nothing is reviewed until you select some.`
    : summaryText(s, scope, organization, locale);
}
