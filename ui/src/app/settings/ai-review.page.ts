import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  LOCALE_ID,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, ok } from '../api/api';
import { ApiError, fieldErrors, problemMessage } from '../api/errors';
import type { ItemOf } from '../api/types';
import { OrgContext } from '../org/org-context';
import { closeModal, openAfterRender } from '../shared/dialog';
import { keepFocus } from '../shared/focus';
import { inputValue, isChecked } from '../shared/forms';
import { KeysetList } from '../shared/keyset';
import {
  AI_REVIEW_BUDGET_FIELDS,
  AI_REVIEW_BUDGET_INPUT,
  type AiReviewBody,
  type AiReviewBudgetErrors,
  type AiReviewBudgetField,
  type AiReviewBudgetsDraft,
  type AiReviewProvider,
  type AiReviewScope,
  aiReviewRefusal,
  budgetFieldOfPath,
  budgetRefusal,
  budgetsDraftOf,
  DEFAULT_AI_REVIEW_BUDGETS,
  type OrgAiReview,
  parseBudgets,
  unavailableText,
} from './ai-review';

type Project = ItemOf<'/api/v0/projects'>;

/**
 * What the data-sharing dialog shows: the provider and the notice of the settings as they were
 * read, which a Confirm acknowledges (R10, amended: the provider the admin was shown, not "yes").
 * `changed` marks a dialog opened again because the provider changed under it.
 */
interface Consent extends AiReviewProvider {
  notice: string;
  changed: boolean;
}

/**
 * Settings → AI review (6I-2, spec C1, D4, R10), for the organisation's admins (`org.ai.manage`),
 * in every edition: the organisation chosen in the header switches AI review on, chooses the
 * projects it covers and sets its budgets. The provider and the organisation's enablement stay
 * the instance admin's (Settings → AI assistant).
 *
 * Switching it on sends repository code to the instance's AI provider, so the switch opens a
 * dialog with the server's notice, word for word, and the `PUT` that follows acknowledges the
 * provider the dialog showed: `acknowledgeDataSharing: { host, model }`. A provider switched
 * meanwhile is a 409 AI_REVIEW_PROVIDER_CHANGED; an acknowledgement the server wanted and did not
 * get is a 409 AI_REVIEW_CONSENT_REQUIRED. Both read the settings again, keep the form and open
 * the dialog again with the provider now. A review switched on whose consent names another
 * provider shows a warning with a button for the same dialog. The consent's base URL is never
 * shown: only the host and the model are.
 *
 * Without a provider, or with the organisation not enabled for the AI assistant, the page names
 * the reason and the form is disabled.
 */
@Component({
  selector: 'q-ai-review-page',
  templateUrl: './ai-review.page.html',
  styleUrl: './ai-review.page.css',
})
export class AiReviewPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);
  private readonly numbers = new Intl.NumberFormat(this.locale);
  protected readonly org = inject(OrgContext);

  protected readonly allowed = computed(
    () => this.org.currentId() !== null && this.org.can('org.ai.manage'),
  );
  /** The settings as the server last answered; the form below is the draft of them. */
  protected readonly current = signal<OrgAiReview | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly enabled = signal(false);
  protected readonly scope = signal<AiReviewScope>('selected');
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly budgets = signal<AiReviewBudgetsDraft>(
    budgetsDraftOf(DEFAULT_AI_REVIEW_BUDGETS),
  );
  protected readonly budgetErrors = signal<AiReviewBudgetErrors>({});
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** The dialog's question while it is open; null while it is closed. */
  protected readonly consent = signal<Consent | null>(null);
  /** The organisation's projects, every page (the scope `selected` ticks among them). */
  protected readonly projects = new KeysetList<Project, string>((organizationId, cursor) =>
    ok(
      this.api.client.GET('/api/v0/projects', {
        params: { query: { organizationId, limit: 100, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );

  /** The form is disabled while the review cannot be switched on (no provider, org not enabled). */
  protected readonly locked = computed(() => this.current()?.available !== true);
  protected readonly unavailable = computed(() => {
    const settings = this.current();
    return settings === null ? null : unavailableText(settings);
  });
  /** A review that is on, whose consent names another provider than the one configured now. */
  protected readonly outdated = computed(() => {
    const settings = this.current();
    return settings !== null && settings.available && settings.enabled && !settings.consentCurrent;
  });
  /** The form asks for the acknowledgement: it switches on, or confirms again after a change. */
  private readonly needsConsent = computed(() => {
    const settings = this.current();
    return settings !== null && this.enabled() && (!settings.enabled || !settings.consentCurrent);
  });
  private readonly selectedSet = computed(() => new Set(this.selected()));
  protected readonly selectedCount = computed(() => this.selected().length);
  /** The instance's ceiling on the organisation's tokens per day, in the page's figures. */
  protected readonly ceiling = computed(() => {
    const tokens = this.current()?.instanceCeiling.tokensPerDay;
    return tokens === undefined || tokens === null ? null : this.numbers.format(tokens);
  });
  /**
   * What the organisation's reviews have used today, against the tokens the day allows them: the
   * organisation's own budget, or the instance ceiling when that is smaller. Both are those of the
   * last answer, not of what is typed in the form. The cost follows when the instance sets prices.
   */
  protected readonly usageText = computed(() => {
    const settings = this.current();
    if (settings === null) return null;
    const { tokensToday, costTodayUsd, reviewsToday } = settings.usage;
    const ceiling = settings.instanceCeiling.tokensPerDay;
    const allowed =
      ceiling === null
        ? settings.budgets.tokensPerDay
        : Math.min(settings.budgets.tokensPerDay, ceiling);
    const reviews =
      reviewsToday === 1
        ? $localize`:@@aiReview.usageReviewsOne:1 review`
        : $localize`:@@aiReview.usageReviews:${this.numbers.format(reviewsToday)}:count: reviews`;
    const line = $localize`:@@aiReview.usage:Today: ${this.numbers.format(tokensToday)}:tokens: of ${this.numbers.format(allowed)}:budget: tokens · ${reviews}:reviews:`;
    if (costTodayUsd === null) return line;
    const cost = new Intl.NumberFormat(this.locale, { style: 'currency', currency: 'USD' }).format(
      costTodayUsd,
    );
    return $localize`:@@aiReview.usageCost:${line}:usage: · ${cost}:cost:`;
  });

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly switchField = viewChild<ElementRef<HTMLInputElement>>('switchField');
  private readonly consentDialog = viewChild<ElementRef<HTMLDialogElement>>('consentDialog');
  /** Counts the organisations read: an answer for an earlier one is dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const id = this.org.currentId();
      const allowed = this.allowed();
      untracked(() => {
        this.generation++;
        // A dialog left open for the organisation we are leaving closes with nothing sent.
        this.consent.set(null);
        this.closeDialog();
        this.current.set(null);
        this.loadError.set(null);
        this.error.set(null);
        this.announcement.set(null);
        this.budgetErrors.set({});
        this.projects.clear();
        if (allowed && id) {
          void this.load(id, this.generation);
          void this.loadProjects(id, this.generation);
        }
      });
    });
  }

  protected isSelected(projectId: string): boolean {
    return this.selectedSet().has(projectId);
  }

  protected setScope(scope: AiReviewScope): void {
    this.scope.set(scope);
    this.announcement.set(null);
  }

  protected toggleProject(projectId: string, event: Event): void {
    const on = isChecked(event);
    this.selected.update((ids) => [
      ...ids.filter((id) => id !== projectId),
      ...(on ? [projectId] : []),
    ]);
    this.announcement.set(null);
  }

  protected setBudget(field: AiReviewBudgetField, event: Event): void {
    const value = inputValue(event);
    this.budgets.update((all) => ({ ...all, [field]: value }));
    if (this.budgetErrors()[field] !== undefined) {
      this.budgetErrors.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
      );
    }
    this.announcement.set(null);
  }

  /** The ids the input of a budget points at: its refusal first, its hint, the ceiling beside tokens. */
  protected describedBy(field: AiReviewBudgetField): string {
    const input = AI_REVIEW_BUDGET_INPUT[field];
    return [
      this.budgetErrors()[field] !== undefined ? `${input}-error` : null,
      `${input}-hint`,
      field === 'tokensPerDay' && this.ceiling() !== null ? 'ai-review-ceiling' : null,
    ]
      .filter((id) => id !== null)
      .join(' ');
  }

  /** The switch: checking it asks for the acknowledgement first (nothing is sent before it). */
  protected setEnabled(event: Event): void {
    this.announcement.set(null);
    this.error.set(null);
    this.setSwitch(isChecked(event));
    if (this.enabled() && this.needsConsent()) this.askConsent(false);
  }

  /** The warning's button: the same dialog, for the provider as it is now. */
  protected confirmAgain(): void {
    if (this.busy()) return;
    this.announcement.set(null);
    this.error.set(null);
    // Confirming is keeping review on, even if the box was unchecked meanwhile.
    this.setSwitch(true);
    this.askConsent(false);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.locked()) return;
    this.announcement.set(null);
    this.error.set(null);
    // A save the server would refuse for want of the acknowledgement asks for it instead.
    if (this.needsConsent()) {
      this.askConsent(false);
      return;
    }
    await this.put(null);
  }

  /** Confirm: acknowledges the provider the dialog showed, and saves the form with it. */
  protected async confirmConsent(): Promise<void> {
    const asked = this.consent();
    if (!asked || this.busy()) return;
    // Cleared first: the dialog's close event then finds nothing to cancel.
    this.consent.set(null);
    this.closeDialog();
    await this.put({ host: asked.host, model: asked.model });
  }

  /** Cancel, Escape or the dialog closing otherwise: nothing is sent and the box is as it was. */
  protected cancelConsent(): void {
    const asked = this.consent();
    this.consent.set(null);
    this.closeDialog();
    if (asked) this.setSwitch(this.current()?.enabled ?? false);
  }

  /**
   * Opens the dialog with the provider and notice of the settings as read, unless the form could
   * not be sent anyway: refused budgets are shown first, with the box back as it was stored.
   */
  private askConsent(changed: boolean): void {
    const settings = this.current();
    if (
      settings === null ||
      !settings.available ||
      !settings.provider ||
      settings.notice === null
    ) {
      this.setSwitch(settings?.enabled ?? false);
      return;
    }
    const parsed = parseBudgets(this.budgets());
    if ('errors' in parsed) {
      this.budgetErrors.set(parsed.errors);
      this.focusFirstInvalid(parsed.errors);
      this.setSwitch(settings.enabled);
      return;
    }
    this.budgetErrors.set({});
    this.consent.set({
      host: settings.provider.host,
      model: settings.provider.model,
      notice: settings.notice,
      changed,
    });
    openAfterRender(
      this.injector,
      () => this.consentDialog()?.nativeElement,
      () => this.consent() !== null,
    );
  }

  /** The whole `PUT`; `acknowledged` is the provider of the dialog that was just confirmed. */
  private async put(acknowledged: AiReviewProvider | null): Promise<void> {
    const id = this.org.currentId();
    if (!id) return;
    const body = this.body(acknowledged);
    if (!body) return;
    const generation = this.generation;
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      const saved = await ok(
        this.api.client.PUT('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
          body,
        }),
      );
      if (generation !== this.generation) return;
      this.show(saved);
      this.announcement.set($localize`:@@aiReview.saved:The AI review settings were saved.`);
      // The warning's button went with the warning: focus stays in the page.
      keepFocus(this.injector, this.document, () => this.heading().nativeElement);
    } catch (err) {
      if (generation !== this.generation) return;
      await this.refused(err, id, generation);
    } finally {
      this.busy.set(false);
    }
  }

  /** The `PUT` body from the form, or null with the refused budgets shown. */
  private body(acknowledged: AiReviewProvider | null): AiReviewBody | null {
    const parsed = parseBudgets(this.budgets());
    if ('errors' in parsed) {
      this.budgetErrors.set(parsed.errors);
      this.focusFirstInvalid(parsed.errors);
      return null;
    }
    this.budgetErrors.set({});
    return {
      enabled: this.enabled(),
      scope: this.scope(),
      projectIds: [...this.selected()],
      budgets: parsed.budgets,
      ...(acknowledged
        ? { acknowledgeDataSharing: { host: acknowledged.host, model: acknowledged.model } }
        : {}),
    };
  }

  /** What a refused `PUT` does: asks again, names the budget, or says why in the page's words. */
  private async refused(err: unknown, id: string, generation: number): Promise<void> {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'AI_REVIEW_CONSENT_REQUIRED' || err.code === 'AI_REVIEW_PROVIDER_CHANGED') {
        // The settings are read again (the form is kept), and the dialog shows the provider now.
        const fresh = await this.reread(id, generation);
        if (generation !== this.generation) return;
        if (fresh?.available && fresh.provider) {
          this.askConsent(err.code === 'AI_REVIEW_PROVIDER_CHANGED');
        } else {
          this.setSwitch(this.current()?.enabled ?? false);
        }
        return;
      }
      if (err.code === 'AI_DISABLED') {
        await this.reread(id, generation);
        if (generation !== this.generation) return;
        this.error.set(aiReviewRefusal(err));
        this.setSwitch(this.current()?.enabled ?? false);
        this.heading().nativeElement.focus();
        return;
      }
    }
    const refusedBudgets: AiReviewBudgetErrors = {};
    for (const path of Object.keys(fieldErrors(err))) {
      const field = budgetFieldOfPath(path);
      if (field !== null) refusedBudgets[field] = budgetRefusal(field);
    }
    if (Object.keys(refusedBudgets).length > 0) {
      this.budgetErrors.set(refusedBudgets);
      this.focusFirstInvalid(refusedBudgets);
      return;
    }
    this.error.set(aiReviewRefusal(err) ?? problemMessage(err));
    this.heading().nativeElement.focus();
  }

  private async load(id: string, generation: number): Promise<void> {
    this.loadError.set(null);
    try {
      const settings = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
        }),
      );
      if (generation === this.generation) this.show(settings);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  /** Reads the settings again and keeps the form; null when the read failed or the page moved on. */
  private async reread(id: string, generation: number): Promise<OrgAiReview | null> {
    try {
      const fresh = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
        }),
      );
      if (generation !== this.generation) return null;
      this.current.set(fresh);
      return fresh;
    } catch (err) {
      if (generation === this.generation) this.error.set(problemMessage(err));
      return null;
    }
  }

  private async loadProjects(organizationId: string, generation: number): Promise<void> {
    await this.projects.reset(organizationId);
    await this.projects.loadRest(() => generation === this.generation);
  }

  /** Puts settings into the form: as read, or as saved. */
  private show(settings: OrgAiReview): void {
    this.current.set(settings);
    this.setSwitch(settings.enabled);
    this.scope.set(settings.scope);
    this.selected.set([...settings.projectIds]);
    this.budgets.set(budgetsDraftOf(settings.budgets));
    this.budgetErrors.set({});
  }

  /**
   * Sets the switch in the signal and in the field. The `[checked]` binding alone cannot take a
   * box back that went on and off again before a change detection ran.
   */
  private setSwitch(on: boolean): void {
    this.enabled.set(on);
    const field = this.switchField()?.nativeElement;
    if (field) field.checked = on;
  }

  private closeDialog(): void {
    const dialog = this.consentDialog()?.nativeElement;
    if (dialog?.open) closeModal(dialog);
  }

  private focusFirstInvalid(errors: AiReviewBudgetErrors): void {
    const first = AI_REVIEW_BUDGET_FIELDS.find((field) => errors[field] !== undefined);
    if (first === undefined) return;
    afterNextRender(() => this.document.getElementById(AI_REVIEW_BUDGET_INPUT[first])?.focus(), {
      injector: this.injector,
    });
  }
}
