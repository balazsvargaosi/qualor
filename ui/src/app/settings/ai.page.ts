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
import { LeaveConfirm } from '../shared/leave-confirm';
import { StatusList } from '../shared/status-list';
import { type LeaveGuarded, LeaveGuards, whileDirty } from '../shared/unsaved-changes';
import { SystemInfo } from '../shell/system-info';
import { consentFields } from './ai/consent-impact';
import { DataSection, type SaveData } from './ai/data-section';
import { LimitsSection, type SaveLimits } from './ai/limits-section';
import { instanceStatusLines } from './ai/instance-status';
import { bodyFrom, type LlmSettings, type SectionChange } from './ai/llm-body';
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
 *   counts them, and the provider's question before a change names those it pauses. Without
 *   them the page works on: what needs them counts what the settings hold, and the Organizations
 *   section offers to read them again.
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
  /** Every organisation, in the server's order; none while they could not be read. */
  protected readonly organizations = signal<readonly Organization[]>([]);
  protected readonly loadError = signal<string | null>(null);
  /**
   * The organisations could not be read: the page works on, the Organizations section says so in
   * place of its table and offers to read them again, and what needs them counts the settings'.
   */
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
      : instanceStatusLines(
          settings,
          this.organizationsFailed() ? null : this.organizations(),
          this.locale,
        );
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
  /** The organisations are being read: Try again waits for it. */
  private readingOrganizations = false;
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

  /** Try again, for the organisations that could not be read. */
  protected async retryOrganizations(): Promise<void> {
    if (this.readingOrganizations) return;
    await this.readOrganizations();
  }

  private async load(): Promise<void> {
    this.loadError.set(null);
    const [settings] = await Promise.allSettled([
      ok(this.api.client.GET('/api/v0/system/llm')),
      this.readOrganizations(),
    ]);
    if (settings.status === 'rejected') this.loadError.set(problemMessage(settings.reason));
    else this.saved.set(settings.value);
  }

  /** Reads every organisation; a failure leaves none, and says so. */
  private async readOrganizations(): Promise<void> {
    this.readingOrganizations = true;
    try {
      this.organizations.set(await this.allOrganizations());
      this.organizationsFailed.set(false);
    } catch {
      this.organizations.set([]);
      this.organizationsFailed.set(true);
    } finally {
      this.readingOrganizations = false;
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
