import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, ok } from '../api/api';
import { fieldErrors, problemMessage } from '../api/errors';
import { label } from '../i18n/labels';
import { OrgContext } from '../org/org-context';
import { inputValue, isChecked } from '../shared/forms';
import {
  AUTO_FIX_SEVERITIES,
  type AutoFixSeverity,
  autoFixNotLicensed,
  autoFixRefusal,
  isAutoFixSeverity,
  MAX_AUTO_FIX_PER_ANALYSIS,
  maxPerAnalysisRefusal,
  type OrgAutoFix,
  parseMaxPerAnalysis,
} from './auto-fix';

/**
 * Settings → Automatic fixes (4E-3a §2, §4), for the organisation's admins (`org.ai.manage`): the
 * organisation chosen in the header gets AI fix suggestions for the new findings of its merge
 * requests posted without a click, at or above a severity and at most so many per analysis. Only
 * this block is changed here; the assistant, its features and budgets stay the instance admin's.
 * Without the enterprise feature `llm.auto-fix` the server answers `available: false` and the page
 * shows the Enterprise note in place of the controls. Refusals are shown in the page's own words.
 */
@Component({
  selector: 'q-auto-fix-page',
  templateUrl: './auto-fix.page.html',
  styleUrl: './auto-fix.page.css',
})
export class AutoFixPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  protected readonly org = inject(OrgContext);

  protected readonly allowed = computed(
    () => this.org.currentId() !== null && this.org.can('org.ai.manage'),
  );
  protected readonly current = signal<OrgAutoFix | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly enabled = signal(false);
  protected readonly minSeverity = signal<AutoFixSeverity>('high');
  protected readonly maxPerAnalysis = signal('10');
  protected readonly maxError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly severities = AUTO_FIX_SEVERITIES;
  protected readonly maxAllowed = MAX_AUTO_FIX_PER_ANALYSIS;
  protected readonly notLicensed = autoFixNotLicensed();
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  /** Counts the organisations read: an answer for an earlier one is dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const id = this.org.currentId();
      const allowed = this.allowed();
      untracked(() => {
        this.generation++;
        this.current.set(null);
        this.error.set(null);
        this.announcement.set(null);
        this.maxError.set(null);
        if (allowed && id) void this.load(id, this.generation);
      });
    });
  }

  protected severityLabel(severity: AutoFixSeverity): string {
    return label('severity', severity);
  }

  protected setEnabled(event: Event): void {
    this.enabled.set(isChecked(event));
    this.announcement.set(null);
  }

  protected setMinSeverity(event: Event): void {
    const value = inputValue(event);
    if (isAutoFixSeverity(value)) this.minSeverity.set(value);
    this.announcement.set(null);
  }

  protected setMaxPerAnalysis(event: Event): void {
    this.maxPerAnalysis.set(inputValue(event));
    this.maxError.set(null);
    this.announcement.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.org.currentId();
    if (this.busy() || !id || !this.current()?.available) return;
    const maxPerAnalysis = parseMaxPerAnalysis(this.maxPerAnalysis());
    if (maxPerAnalysis === null) {
      this.maxError.set(maxPerAnalysisRefusal());
      this.focus('auto-fix-max');
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      const saved = await ok(
        this.api.client.PUT('/api/v0/organizations/{id}/ai/auto-fix', {
          params: { path: { id } },
          body: { enabled: this.enabled(), minSeverity: this.minSeverity(), maxPerAnalysis },
        }),
      );
      if (generation !== this.generation) return;
      this.show(saved);
      this.announcement.set($localize`:@@autoFix.saved:The automatic fix suggestions were saved.`);
    } catch (err) {
      if (generation !== this.generation) return;
      if ('body.maxPerAnalysis' in fieldErrors(err)) {
        this.maxError.set(maxPerAnalysisRefusal());
        this.focus('auto-fix-max');
        return;
      }
      this.error.set(autoFixRefusal(err) ?? problemMessage(err));
      this.heading().nativeElement.focus();
    } finally {
      this.busy.set(false);
    }
  }

  private async load(id: string, generation: number): Promise<void> {
    this.loadError.set(null);
    try {
      const settings = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/auto-fix', {
          params: { path: { id } },
        }),
      );
      if (generation === this.generation) this.show(settings);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  private show(settings: OrgAutoFix): void {
    this.current.set(settings);
    this.enabled.set(settings.enabled);
    this.minSeverity.set(settings.minSeverity);
    this.maxPerAnalysis.set(String(settings.maxPerAnalysis));
    this.maxError.set(null);
  }

  private focus(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}
