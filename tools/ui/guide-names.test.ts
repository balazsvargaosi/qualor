import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The guide names the screens as they are (AGENTS.md rule 9). A name the redesign removed must not
 * survive anywhere in it, however the Markdown wraps it: each page is read with its emphasis
 * dropped and its line breaks folded into spaces (UI redesign, step 8 review).
 */
const REMOVED = [
  // Step 8: the form under Settings → Users became "Reset password" on the user's row.
  'Settings → Users → Reset a password',
  // Step 9: SCIM tokens are made in the "New token" dialog of the connection's panel.
  "in the connection's section, give a Token name",
  // Step 11: the mapping of projects to repositories moved from the GitLab page to Repositories.
  'Projects table of Settings → GitLab',
  'Projects table on the same page',
  'Settings → GitLab also sets it',
  'has a test action per project',
  'The test on Settings → GitLab says which',
  'map it in Settings → GitLab or GitHub',
  // Step 11: organisations are created in Settings → Organizations.
  'creates more organisations through the API',
  // Step 10: Change password is in the user menu, under the name at the top right.
  'Change password at the top right',
  // Steps 6 and 7: Copy is a button of the row (and of a gate's band).
  'Quality gates → copy',
  'Quality profiles → copy',
  // Step 11: the UI calls them "Rules it does not set" (the list) and "Not set here" (a profile).
  'Unknown rules, meaning',
];

/**
 * The names the AI settings redesign removed. The READMEs walk through these pages too, so they are
 * held to them as well as the guide.
 */
const AI_SETTINGS_REMOVED = [
  // AI settings redesign (2026-10-26): the instance's page is Settings → AI provider.
  'Settings → AI assistant',
  // AI settings redesign (2026-10-26): AI review and automatic fix suggestions are sections of the
  // organisation's page, Settings → AI.
  'Settings → AI review',
  'Settings → Automatic fixes',
  // AI settings redesign (2026-10-26): a project's two panels are one, Project → Settings → AI.
  'Project → Settings → AI review',
  'Project → Settings → Automatic fix suggestions',
  // AI settings redesign (2026-10-26): the provider's kind is the choice "Provider".
  'Kind | OpenAI-compatible',
  // AI settings redesign (2026-10-26): an organisation is not enabled but allowed ("Allow AI in
  // Acme"), and the instance page says "This organization may not use AI."
  'enable the organisation',
  'enables the organisation',
  'enabled the organisation',
  'The AI assistant is not enabled for this organisation',
  // AI settings redesign (2026-10-26): organisations are allowed to use AI, never enabled.
  'enabled organisations',
  'enable organisations',
  // AI settings redesign (2026-10-26): Remove the key is a button, not a box to check.
  'check Remove the key',
  // AI settings redesign (2026-10-26): an organisation's excluded projects are "Never sent to the
  // provider".
  'Never send issues of these projects',
  // AI settings redesign (2026-10-26): the instance's budgets are the section Limits, and the
  // organisation's AI review budgets the fold Budgets.
  'Budgets per organisation and day (UTC)',
  'Budgets per day (UTC)',
  // AI settings redesign (2026-10-26): the ceiling is the switch "Cap the tokens an organization
  // may give AI review".
  'AI review: most tokens per organisation per day',
  // AI settings redesign (2026-10-26): "Asks per person and hour".
  'Requests per person',
  // AI settings redesign (2026-10-26): "Keep a copy of what is sent", and "Keep for".
  'Store the prompts sent',
  'Days to keep them',
  // AI settings redesign (2026-10-26): "Output limit parameter".
  'Output limit field',
  // AI settings redesign (2026-10-26): the provider's Test is "Save and test", then "Test again",
  // and its lines say "can call tools" or "cannot call tools, so AI review would fail".
  'Test in Settings → AI',
  'Tool calling (needed by AI review)',
  'choose Responses below',
  'give its workspace ID below',
  // AI settings redesign (2026-10-26): AI review is switched on with "Switch on AI review…" and
  // confirmed again with "Review and confirm…".
  'Review merge requests with AI',
  'Confirm again',
];

/** A Markdown file as the checks read it: its emphasis dropped, its line breaks folded. */
const read = (url: URL): string =>
  readFileSync(url, 'utf8').replaceAll('**', '').replace(/\s+/g, ' ');

const guide = new URL('../../docs/guide/', import.meta.url);
const pages = readdirSync(guide)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, text: read(new URL(name, guide)) }));
const root = new URL('../../', import.meta.url);
const readmes = ['README.md', 'deploy/README.md'].map((name) => ({
  name,
  text: read(new URL(name, root)),
}));

describe('the user guide', () => {
  it('has pages to read', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const removed of [...REMOVED, ...AI_SETTINGS_REMOVED]) {
    it(`never names "${removed}"`, () => {
      expect(pages.filter((page) => page.text.includes(removed)).map((page) => page.name)).toEqual(
        [],
      );
    });
  }
});

describe('the READMEs', () => {
  for (const removed of AI_SETTINGS_REMOVED) {
    it(`never name "${removed}"`, () => {
      expect(
        readmes.filter((file) => file.text.includes(removed)).map((file) => file.name),
      ).toEqual([]);
    });
  }
});
