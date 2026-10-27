import {
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  LOCALE_ID,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, ok } from '../api/api';
import { problemMessage } from '../api/errors';
import type { Organization } from '../api/types';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { formatDate } from '../shared/date-time.pipe';
import { LeaveConfirm } from '../shared/leave-confirm';
import { formatWhole } from '../shared/numbers';
import { type StatusLine, StatusList } from '../shared/status-list';
import { type LeaveGuarded, LeaveGuards, whileDirty } from '../shared/unsaved-changes';
import { SystemInfo } from '../shell/system-info';
import { consentFields } from './ai/consent-impact';
import { DataSection, type SaveData } from './ai/data-section';
import { LimitsSection, type SaveLimits } from './ai/limits-section';
import { bodyFrom, type LlmSettings, type SectionChange } from './ai/llm-body';
import { namesOf } from './ai/names';
import { OrganizationsSection, type SaveEntry } from './ai/organizations-section';
import { ProviderSection, type SaveProvider } from './ai/provider-section';
import { AUTO_FIX_FEATURE } from './auto-fix';

/** The organisations an instance admin sees, read page by page up to this bound. */
const ORG_PAGES = 10;
const ORG_PAGE_SIZE = 100;

/** A section on the page: whether it has unsaved changes, and its name for the question. */
interface Guarded {
  dirty(): boolean;
  readonly dirtyLabel: string;
}

/**
 * Settings → AI provider (spec §3.4), for instance admins: the one provider the instance's AI
 * features use, which organisations may use it, what they may spend, and what leaves the server.
 *
 * - **Status** first, computed from what is saved (`instanceStatusLines`).
 * - **Provider** (`q-ai-provider-section`), then, once a provider is saved, **Organizations**,
 *   **Limits** and **Data and privacy**, with an index under the head that leads to them; before
 *   that, one line names them.
 * - Each section saves on its own. The `PUT` replaces the whole settings, so a save sends the
 *   settings as last saved with that section's change (`bodyFrom`), and the answer becomes the
 *   settings every section is given; a section with unsaved changes keeps them. Saves go one at a
 *   time: each is built on the answer to the one before, so none undoes another.
 * - The page reads every organisation (ten pages of a hundred), never every project: the status
 *   counts them, and the provider's question before a change names those it pauses.
 *
 * Leaving it with unsaved changes in any section asks first, once, naming them: Open of an
 * organisation, which switches the header's organisation and leaves, asks once for both.
 */
@Component({
  selector: 'q-ai-settings-page',
  imports: [
    DataSection,
    LeaveConfirm,
    LimitsSection,
    OrganizationsSection,
    ProviderSection,
    RouterLink,
    StatusList,
  ],
  // Its parts are the shared ones of styles.css (.settings-head, .page-index, .ai-sections).
  templateUrl: './ai.page.html',
})
export class AiSettingsPage implements LeaveGuarded {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly session = inject(SessionStore);
  private readonly info = inject(SystemInfo);
  private readonly org = inject(OrgContext);
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment, { initialValue: null });

  protected readonly instanceAdmin = computed(() => this.session.user()?.isInstanceAdmin === true);
  /** The settings as the server last answered: what the status says and the sections are given. */
  protected readonly saved = signal<LlmSettings | null>(null);
  /** Every organisation, in the server's order. */
  protected readonly organizations = signal<readonly Organization[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly organizationsFailed = signal(false);
  /** The automatic fix suggestions are licensed (`llm.auto-fix`). */
  protected readonly autoFixAvailable = computed(() =>
    this.info.features().includes(AUTO_FIX_FEATURE),
  );
  /** The host the data go to: the saved provider's. */
  protected readonly providerHost = computed(() => {
    const provider = this.saved()?.provider;
    return provider ? consentFields(provider).host : null;
  });
  protected readonly statusLines = computed(() => {
    const settings = this.saved();
    return settings === null
      ? []
      : instanceStatusLines(settings, this.organizations(), this.locale);
  });
  /** The sections, in the page's order, as the index leads to them. */
  protected readonly index: readonly { id: string; label: string }[] = [
    { id: 'provider', label: $localize`:@@aiProvider.provider.title:Provider` },
    { id: 'organizations', label: $localize`:@@aiProvider.orgs.title:Organizations` },
    { id: 'limits', label: $localize`:@@aiProvider.limits.title:Limits` },
    { id: 'data', label: $localize`:@@aiProvider.data.title:Data and privacy` },
  ];

  /** Stores the provider and its prices. */
  readonly saveProvider: SaveProvider = (change) =>
    this.put({ section: 'provider', provider: change.provider, pricing: change.pricing });
  /** Stores one organisation's entry. */
  readonly saveEntry: SaveEntry = async (id, entry) => {
    await this.put({ section: 'organization', id, entry });
  };
  readonly saveLimits: SaveLimits = (budgets) => this.put({ section: 'limits', budgets });
  readonly saveData: SaveData = (data) => this.put({ section: 'data', ...data });

  private readonly providerSection = viewChild(ProviderSection);
  private readonly organizationsSection = viewChild(OrganizationsSection);
  private readonly limitsSection = viewChild(LimitsSection);
  private readonly dataSection = viewChild(DataSection);
  private readonly leaveConfirm = viewChild.required(LeaveConfirm);

  /** The sections with unsaved changes, by their headings, in the page's order. */
  private readonly unsavedSections = computed(() => {
    const sections: (Guarded | undefined)[] = [
      this.providerSection(),
      this.organizationsSection(),
      this.limitsSection(),
      this.dataSection(),
    ];
    return sections.flatMap((section) => (section?.dirty() ? [section.dirtyLabel] : []));
  });
  /** The last request to `/system/llm`, settled: the next waits for it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Open was confirmed: the switch of the organisation and the navigation ask nothing more. */
  private leaving = false;
  /** The section the address named was scrolled to, or the index was used: not again. */
  private revealed = false;

  constructor() {
    whileDirty(() => this.unsavedSections().length > 0);
    // Open switches the header's organisation, which asks the pages on screen first.
    inject(LeaveGuards).register(this);
    effect(() => {
      const admin = this.instanceAdmin();
      untracked(() => {
        if (admin) void this.load();
      });
    });
    // An address that names a section: scroll to it once it has rendered.
    afterRenderEffect(() => {
      const fragment = this.fragment();
      if (this.revealed || fragment === null || this.saved() === null) return;
      if (this.reveal(fragment)) this.revealed = true;
    });
  }

  /** Leaving with unsaved changes asks first (the route's `canDeactivate`), naming their sections. */
  canLeave(): boolean | Promise<boolean> {
    if (this.leaving) return true;
    const sections = this.unsavedSections();
    return sections.length > 0 ? this.leaveConfirm().ask(sections) : true;
  }

  /**
   * Open of an organisation: asks once, when changes are unsaved, then makes the organisation the
   * header's and goes to its AI page; neither the switch nor the navigation asks again.
   */
  protected async openOrganization(organizationId: string): Promise<void> {
    if (!(await this.canLeave())) return;
    this.leaving = true;
    try {
      if (await this.org.switchTo(organizationId)) {
        await this.router.navigate(['/settings/ai-review']);
      }
    } finally {
      this.leaving = false;
    }
  }

  /** A status line's action: Test again, Manage the organisations, Enter prices. */
  protected onAct(id: string): void {
    switch (id) {
      case 'test':
        void this.providerSection()?.test();
        return;
      case 'manage':
        this.reveal('organizations');
        return;
      case 'prices':
        // The prices' switch, in the Provider section.
        this.reveal('provider');
        this.document.getElementById('ai-prices')?.focus();
        return;
    }
  }

  /**
   * An index link's plain click: its `routerLink` puts the section in the address, and this
   * scrolls to it and focuses its heading. A click that opens the link elsewhere (the middle
   * button, Ctrl, ⌘ or Shift) is the browser's, and leaves this page as it is.
   */
  protected go(id: string, event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    this.revealed = true;
    this.reveal(id);
  }

  /** A Test answered: the server keeps it as the last Test, which the status says. */
  protected reload(): void {
    this.queue = this.queue.then(async () => {
      try {
        this.saved.set(await ok(this.api.client.GET('/api/v0/system/llm')));
      } catch {
        // The status keeps the Test it knew; the provider shows this one.
      }
    });
  }

  /**
   * Stores one section's change: once the request before it is answered, the settings as then
   * saved with the change go to the server, whose answer becomes the settings. Rejects with the
   * refusal, which the section shows. Nothing of the change (a key typed) stays after it.
   */
  private put(change: SectionChange): Promise<LlmSettings> {
    const request = this.queue.then(() => this.send(change));
    this.queue = request.catch(() => undefined);
    return request;
  }

  private async send(change: SectionChange): Promise<LlmSettings> {
    const saved = this.saved();
    // The sections show only once the settings are read.
    if (saved === null) throw new Error('The AI provider settings are not read yet.');
    const answer = await ok(
      this.api.client.PUT('/api/v0/system/llm', { body: bodyFrom(saved, change) }),
    );
    this.saved.set(answer);
    return answer;
  }

  private async load(): Promise<void> {
    this.loadError.set(null);
    this.organizationsFailed.set(false);
    const [settings, organizations] = await Promise.allSettled([
      ok(this.api.client.GET('/api/v0/system/llm')),
      this.allOrganizations(),
    ]);
    if (settings.status === 'rejected') {
      this.loadError.set(problemMessage(settings.reason));
    } else if (organizations.status === 'rejected') {
      this.organizationsFailed.set(true);
    } else {
      this.organizations.set(organizations.value);
      this.saved.set(settings.value);
    }
  }

  private async allOrganizations(): Promise<Organization[]> {
    const all: Organization[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < ORG_PAGES; i++) {
      const answer: { items: Organization[]; nextCursor: string | null } = await ok(
        this.api.client.GET('/api/v0/organizations', {
          params: { query: { limit: ORG_PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
        }),
      );
      all.push(...answer.items);
      if (answer.nextCursor === null || answer.nextCursor === cursor) break;
      cursor = answer.nextCursor;
    }
    return all;
  }

  /** Scrolls to the page's section `id` and focuses its heading; false while it is not there. */
  private reveal(id: string): boolean {
    // By id, not by a selector: the address may hold any text.
    const section = this.document.getElementById(id);
    if (section?.tagName !== 'SECTION' || !this.element.nativeElement.contains(section)) {
      return false;
    }
    section.scrollIntoView();
    section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    return true;
  }
}

/**
 * The instance's AI as its Status card says it (spec §3.4 M-I3, Appendix A), from what is saved:
 *
 * - the provider: connected, or failing its last Test; its kind, host and models; what that Test
 *   found, which is kept until the provider changes;
 * - the organisations that may use AI, by name up to three;
 * - where AI review runs, or is paused until an organisation's admins confirm the provider now:
 *   on only with a provider, in an organisation allowed to use AI whose admins switched it on and
 *   confirmed (the server's order of reasons); an organisation the settings lack has it off;
 * - once a provider is saved, the limits and the prices.
 */
export function instanceStatusLines(
  saved: LlmSettings,
  organizations: readonly Organization[],
  locale: string,
): StatusLine[] {
  const lines = [
    providerLine(saved, locale),
    organizationsLine(saved, organizations, locale),
    reviewLine(saved, organizations, locale),
  ];
  if (saved.provider !== null) lines.push(limitsLine(saved, locale), pricesLine(saved, locale));
  return lines;
}

function providerLine(saved: LlmSettings, locale: string): StatusLine {
  const label = $localize`:@@aiProvider.status.provider:Provider`;
  const provider = saved.provider;
  if (provider === null) {
    return {
      key: 'provider',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.notConnected:Not connected`,
      action: null,
    };
  }
  const kind =
    provider.kind === 'openai'
      ? $localize`:@@aiProvider.status.kindOpenai:OpenAI-compatible`
      : $localize`:@@aiProvider.status.kindAnthropic:Anthropic`;
  const { host, models } = consentFields(provider);
  const count = models.length;
  const n = formatWhole(count, locale);
  const test = saved.lastTest;
  const failed = test?.models.filter((m) => !m.ok || m.problemCode !== null) ?? [];
  return {
    key: 'provider',
    label,
    tone: failed.length > 0 ? 'broken' : 'ok',
    state:
      failed.length > 0
        ? $localize`:@@aiProvider.status.testFailed:Test failed`
        : $localize`:@@aiProvider.status.connected:Connected`,
    text:
      count === 1
        ? $localize`:@@aiProvider.status.providerTextOne:${kind}:kind: at ${host}:host: · 1 model`
        : $localize`:@@aiProvider.status.providerText:${kind}:kind: at ${host}:host: · ${n}:n: models`,
    sub: testedText(test, locale),
    action: { id: 'test', label: $localize`:@@aiProvider.testAgain:Test again` },
  };
}

/** What the last Test found, in a sentence: failures first, then models that cannot call tools. */
function testedText(test: LlmSettings['lastTest'], locale: string): string {
  if (test === null) {
    return $localize`:@@aiProvider.status.notTested:Not tested since the provider changed.`;
  }
  const date = formatDate(test.at, locale);
  const list = (models: readonly string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(models);
  const failed = test.models.filter((m) => !m.ok || m.problemCode !== null).map((m) => m.model);
  if (failed.length > 0) {
    const models = list(failed);
    return $localize`:@@aiProvider.status.testedFailed:Tested ${date}:date:: the test failed for ${models}:models:.`;
  }
  const noTools = test.models.filter((m) => m.toolCalling === 'not_supported').map((m) => m.model);
  if (noTools.length > 0) {
    const models = list(noTools);
    return $localize`:@@aiProvider.status.testedNoTools:Tested ${date}:date:: ${models}:models: cannot call tools.`;
  }
  const count = test.models.length;
  const n = formatWhole(count, locale);
  if (test.models.some((m) => m.toolCalling === 'not_checked')) {
    return count === 1
      ? $localize`:@@aiProvider.status.testedConnectsOne:Tested ${date}:date:: the model connects.`
      : $localize`:@@aiProvider.status.testedConnects:Tested ${date}:date:: all ${n}:n: models connect.`;
  }
  return count === 1
    ? $localize`:@@aiProvider.status.testedOne:Tested ${date}:date:: the model connects and can call tools.`
    : $localize`:@@aiProvider.status.tested:Tested ${date}:date:: all ${n}:n: models connect and can call tools.`;
}

function organizationsLine(
  saved: LlmSettings,
  organizations: readonly Organization[],
  locale: string,
): StatusLine {
  const label = $localize`:@@aiProvider.status.organizations:Organizations`;
  const allowed = organizations.filter((o) => saved.organizations[o.id]?.enabled === true);
  const action = { id: 'manage', label: $localize`:@@aiProvider.status.manage:Manage` };
  if (allowed.length === 0) {
    return {
      key: 'organizations',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.noneAllowed:None may use AI`,
      sub: null,
      action: saved.provider === null ? null : action,
    };
  }
  const a = formatWhole(allowed.length, locale);
  const t = formatWhole(organizations.length, locale);
  return {
    key: 'organizations',
    label,
    tone: 'ok',
    state: $localize`:@@aiProvider.status.allowed:${a}:allowed: of ${t}:total: may use AI`,
    sub: namesOf(
      allowed.map((o) => o.name),
      locale,
    ),
    action,
  };
}

function reviewLine(
  saved: LlmSettings,
  organizations: readonly Organization[],
  locale: string,
): StatusLine {
  const label = $localize`:@@aiProvider.status.review:AI review`;
  // The server's reasons, in its order: a provider, the organisation allowed, the switch, the
  // consent. Only the last leaves AI review paused, which its admins can resume.
  const switchedOn =
    saved.provider === null
      ? []
      : organizations.filter((o) => {
          const stored = saved.organizations[o.id];
          return stored?.enabled === true && stored.reviewStatus.enabled;
        });
  const current = (o: Organization) => saved.organizations[o.id]?.reviewStatus.consentCurrent;
  const on = switchedOn.filter((o) => current(o)).map((o) => o.name);
  const paused = switchedOn.filter((o) => !current(o)).map((o) => o.name);
  const onText = (names: readonly string[]) => {
    const list = namesOf(names, locale);
    return $localize`:@@aiProvider.status.reviewOn:On in ${list}:names:`;
  };
  if (paused.length > 0) {
    const list = namesOf(paused, locale);
    return {
      key: 'review',
      label,
      tone: 'attention',
      state: $localize`:@@aiProvider.status.reviewPaused:Paused in ${list}:names:`,
      text: on.length > 0 ? onText(on) : null,
    };
  }
  if (on.length > 0) return { key: 'review', label, tone: 'ok', state: onText(on) };
  return {
    key: 'review',
    label,
    tone: 'off',
    state: $localize`:@@aiProvider.status.reviewOff:Off everywhere`,
  };
}

function limitsLine(saved: LlmSettings, locale: string): StatusLine {
  const tokens = formatWhole(saved.budgets.tokensPerDay, locale);
  const ceiling = saved.budgets.reviewTokensPerOrganizationPerDay;
  const cap = ceiling === null ? null : formatWhole(ceiling, locale);
  return {
    key: 'limits',
    label: $localize`:@@aiProvider.status.limits:Limits`,
    tone: 'ok',
    state: $localize`:@@aiProvider.limits.chip:Set`,
    text:
      cap === null
        ? $localize`:@@aiProvider.status.limitsNoCap:Assistant: ${tokens}:tokens: tokens a day per organization · AI review: no cap (each organization admin may set up to 1,000,000,000 a day)`
        : $localize`:@@aiProvider.status.limitsCap:Assistant: ${tokens}:tokens: tokens a day per organization · AI review: capped at ${cap}:cap: tokens a day per organization`,
  };
}

function pricesLine(saved: LlmSettings, locale: string): StatusLine {
  const label = $localize`:@@aiProvider.status.prices:Prices`;
  const pricing = saved.pricing;
  if (pricing === null) {
    return {
      key: 'prices',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.pricesNotSet:Not set`,
      sub: $localize`:@@aiProvider.status.pricesNotSetSub:Costs are not counted, and cost limits count nothing.`,
      action: { id: 'prices', label: $localize`:@@aiProvider.status.enterPrices:Enter prices` },
    };
  }
  const count = 1 + (pricing.strong === null ? 0 : 1) + (pricing.fast === null ? 0 : 1);
  const n = formatWhole(count, locale);
  return {
    key: 'prices',
    label,
    tone: 'ok',
    state:
      count === 1
        ? $localize`:@@aiProvider.status.pricesSetOne:Set for 1 model`
        : $localize`:@@aiProvider.status.pricesSet:Set for ${n}:n: models`,
    sub: null,
    action: null,
  };
}
