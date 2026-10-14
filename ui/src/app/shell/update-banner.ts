import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UpdateNotice } from './update-notice';

/**
 * A bar under the header for instance admins when the server's update check found a newer
 * release (telemetry.md "Update check"), with the release notes and the upgrade steps. Dismissed
 * per release. A `status` region only while it has something to say, like the licence banner.
 */
@Component({
  selector: 'q-update-banner',
  imports: [RouterLink],
  templateUrl: './update-banner.html',
})
export class UpdateBanner {
  protected readonly notice = inject(UpdateNotice);
  protected readonly visible = computed(
    () => this.notice.latest() !== null && !this.notice.dismissed(),
  );
  protected readonly notesUrl = computed(
    () => `https://github.com/qualor-dev/qualor/releases/tag/v${this.notice.latest()}`,
  );
}
