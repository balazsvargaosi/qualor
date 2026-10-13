import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../../api/api';
import { ApiError, problemMessage } from '../../api/errors';
import { autoFixNotLicensed } from '../../settings/auto-fix';
import { isChecked } from '../../shared/forms';
import type { ProjectDto } from '../current-project';

/**
 * Project → Settings → Automatic fix suggestions (4E-3a §2, §4), for `project.settings`: opts the
 * project out of its organisation's automatic fix suggestions, or back in. Three ways: without the
 * enterprise feature `llm.auto-fix` (`autoFix.available`) the Enterprise note; while the
 * organisation has them off (`autoFix.organizationEnabled`) an explanation pointing to Settings →
 * Automatic fixes; else the switch. `saved` tells the page to read the project again.
 */
@Component({
  selector: 'q-auto-fix-panel',
  imports: [RouterLink],
  templateUrl: './auto-fix-panel.html',
  styleUrl: './auto-fix-panel.css',
})
export class AutoFixPanel {
  private readonly api = inject(Api);
  readonly project = input.required<ProjectDto>();
  readonly saved = output();

  protected readonly available = computed(() => this.project().autoFix.available);
  protected readonly organizationEnabled = computed(
    () => this.project().autoFix.organizationEnabled,
  );
  /** The saved choice: a primitive, so reading the project again unchanged keeps the field. */
  private readonly stored = computed(() => this.project().autoFix.enabled);
  protected readonly enabled = linkedSignal(() => this.stored());
  protected readonly dirty = computed(() => this.enabled() !== this.stored());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly notLicensed = autoFixNotLicensed();

  protected setEnabled(event: Event): void {
    this.enabled.set(isChecked(event));
    this.announcement.set(null);
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    if (this.busy() || !this.dirty()) return;
    const enabled = this.enabled();
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      await ok(
        this.api.client.PUT('/api/v0/projects/{id}/ai/auto-fix', {
          params: { path: { id: this.project().id } },
          body: { enabled },
        }),
      );
      this.announcement.set(
        enabled
          ? $localize`:@@autoFix.project.on:Automatic fix suggestions are on for this project while the organisation has them on.`
          : $localize`:@@autoFix.project.off:Automatic fix suggestions are off for this project.`,
      );
      this.saved.emit();
    } catch (err) {
      this.error.set(saveError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

function saveError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'AUTO_FIX_OPT_OUT_LIMIT_REACHED') {
    return $localize`:@@autoFix.project.limit:This organisation already has 1 000 projects opted out. Switch one back on first.`;
  }
  if (err instanceof ApiError && err.code === 'FEATURE_NOT_LICENSED') return autoFixNotLicensed();
  return problemMessage(err);
}
