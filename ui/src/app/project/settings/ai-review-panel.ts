import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProjectDto } from '../current-project';

/**
 * Project → Settings → AI review (6I-2), for `project.settings`: whether AI review runs for the
 * project (`aiReview.enabled`), read-only. The organisation's admin chooses the projects in
 * Settings → AI review; while the organisation has it off (`aiReview.organizationEnabled`) the
 * panel says who switches it on and where. Nothing here changes anything, so it asks the server
 * nothing and emits nothing.
 */
@Component({
  selector: 'q-ai-review-panel',
  imports: [RouterLink],
  templateUrl: './ai-review-panel.html',
  styleUrl: './ai-review-panel.css',
})
export class AiReviewPanel {
  readonly project = input.required<ProjectDto>();

  protected readonly enabled = computed(() => this.project().aiReview.enabled);
  protected readonly organizationEnabled = computed(
    () => this.project().aiReview.organizationEnabled,
  );
}
