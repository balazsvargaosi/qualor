import { projectItem } from '../../../testing/fake-server';
import { chosenState, selectionSummary, summaryText } from './review-state';

// Payments is linked to a repository; Web Shop is not; an instance admin excluded Legacy.
const PAYMENTS = projectItem({
  id: 'p-payments',
  key: 'acme/payments',
  name: 'Payments',
  scmConnectionId: 'c1',
});
const SHOP = projectItem({ id: 'p-shop', key: 'acme/web-shop', name: 'Web Shop' });
const LEGACY = projectItem({
  id: 'p-legacy',
  key: 'acme/legacy',
  name: 'Legacy',
  autoFix: { excludedFromAi: true },
});
const PROJECTS = [PAYMENTS, SHOP, LEGACY];
const ALL_IDS = PROJECTS.map((p) => p.id);

/** The parts of a project the state reads. */
const state = (scmConnectionId: string | null, excludedFromAi: boolean) =>
  chosenState({
    scmConnectionId,
    autoFix: { available: true, enabled: true, organizationEnabled: true, excludedFromAi },
  });

describe('chosenState', () => {
  it('reviews a linked project, and not one without a repository', () => {
    expect(state('c1', false)).toBe('reviewed');
    expect(state(null, false)).toBe('not_linked');
  });

  it('says excluded before not linked: an excluded project is never reviewed, linked or not', () => {
    expect(state('c1', true)).toBe('excluded');
    expect(state(null, true)).toBe('excluded');
  });
});

describe('selectionSummary', () => {
  it('counts the selected projects by what review does with them', () => {
    expect(selectionSummary(PROJECTS, 'selected', ALL_IDS)).toEqual({
      total: 3,
      reviewable: 1,
      notLinked: 1,
      excluded: 1,
    });
    expect(selectionSummary(PROJECTS, 'selected', [SHOP.id])).toEqual({
      total: 1,
      reviewable: 0,
      notLinked: 1,
      excluded: 0,
    });
    expect(selectionSummary(PROJECTS, 'selected', [])).toEqual({
      total: 0,
      reviewable: 0,
      notLinked: 0,
      excluded: 0,
    });
  });

  it('counts only the selected projects the list holds, each once', () => {
    expect(selectionSummary(PROJECTS, 'selected', [PAYMENTS.id, 'p-gone', PAYMENTS.id])).toEqual({
      total: 1,
      reviewable: 1,
      notLinked: 0,
      excluded: 0,
    });
  });

  it('counts every project of the organisation for All, whatever is selected', () => {
    expect(selectionSummary(PROJECTS, 'all', [PAYMENTS.id])).toEqual({
      total: 3,
      reviewable: 1,
      notLinked: 1,
      excluded: 1,
    });
    expect(selectionSummary([], 'all', [PAYMENTS.id])).toEqual({
      total: 0,
      reviewable: 0,
      notLinked: 0,
      excluded: 0,
    });
  });
});

describe('summaryText', () => {
  const summary = (total: number, reviewable: number, notLinked = 0, excluded = 0) => ({
    total,
    reviewable,
    notLinked,
    excluded,
  });

  it('asks for projects while none is selected', () => {
    expect(summaryText(summary(0, 0), 'selected', 'Default')).toBe(
      'No project is selected yet: choose projects below first.',
    );
    expect(summaryText(summary(0, 0), 'all', 'Default')).toBe('Default has no project yet.');
  });

  it('says every project will be reviewed when each can be', () => {
    expect(summaryText(summary(3, 3), 'selected', 'Default')).toBe(
      '3 selected projects will be reviewed.',
    );
    expect(summaryText(summary(1, 1), 'selected', 'Default')).toBe(
      '1 selected project will be reviewed.',
    );
    expect(summaryText(summary(3, 3), 'all', 'Default')).toBe(
      'All 3 projects of Default will be reviewed.',
    );
    expect(summaryText(summary(1, 1), 'all', 'Default')).toBe(
      'The 1 project of Default will be reviewed.',
    );
  });

  it('counts the projects that can be reviewed, and why the others cannot', () => {
    expect(summaryText(summary(3, 1, 1, 1), 'selected', 'Default')).toBe(
      '1 of 3 selected projects can be reviewed: 1 not linked to a repository, 1 excluded from AI.',
    );
    expect(summaryText(summary(3, 1, 1, 1), 'all', 'Default')).toBe(
      '1 of the 3 projects of Default can be reviewed: 1 not linked to a repository, 1 excluded from AI.',
    );
    expect(summaryText(summary(2, 0, 2, 0), 'selected', 'Default')).toBe(
      '0 of 2 selected projects can be reviewed: 2 not linked to a repository.',
    );
    expect(summaryText(summary(4, 1, 0, 3), 'all', 'Default')).toBe(
      '1 of the 4 projects of Default can be reviewed: 3 excluded from AI.',
    );
    expect(summaryText(summary(1, 0, 0, 1), 'selected', 'Default')).toBe(
      '0 of 1 selected project can be reviewed: 1 excluded from AI.',
    );
    expect(summaryText(summary(1, 0, 1, 0), 'all', 'Default')).toBe(
      '0 of the 1 project of Default can be reviewed: 1 not linked to a repository.',
    );
  });

  it('groups the counts as the locale writes them', () => {
    expect(summaryText(summary(1_200, 1_200), 'all', 'Default', 'en-US')).toBe(
      'All 1,200 projects of Default will be reviewed.',
    );
    expect(summaryText(summary(2_500, 1_000, 1_500), 'selected', 'Default', 'en-US')).toBe(
      '1,000 of 2,500 selected projects can be reviewed: 1,500 not linked to a repository.',
    );
  });
});
