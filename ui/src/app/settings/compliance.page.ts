import { Component, computed, inject } from '@angular/core';
import { problemMessage } from '../api/errors';
import { ComplianceReportsComponent } from '../compliance/compliance-reports.component';
import { OrgContext } from '../org/org-context';
import { SystemInfo } from '../shell/system-info';

/**
 * Settings → Compliance reports (4E-1 §4, feature `compliance-export`): the reports of the
 * current organisation (the header's choice), and **Create report** for a holder of
 * `org.compliance.manage`. The server lists them to the organisation's members only; anyone else
 * is told so. Without the feature the page says so and asks the enterprise API nothing.
 */
@Component({
  selector: 'q-settings-compliance-page',
  imports: [ComplianceReportsComponent],
  templateUrl: './compliance.page.html',
})
export class SettingsCompliancePage {
  private readonly info = inject(SystemInfo);
  protected readonly org = inject(OrgContext);

  protected readonly licensed = computed(() => this.info.features().includes('compliance-export'));
  protected readonly infoLoaded = computed(() => this.info.info() !== null);
  /** A failed `GET /system/info`, shown instead of an empty page. */
  protected readonly infoError = computed(() => {
    const err = this.info.error();
    return err === null ? null : problemMessage(err);
  });
  protected readonly scope = computed(() => {
    const organizationId = this.org.currentId();
    return organizationId ? { organizationId } : null;
  });
  /** rbac-audit.md §17: the control shows for those whose role may create the report. */
  protected readonly canCreate = computed(() => this.org.canChange('org.compliance.manage'));
}
