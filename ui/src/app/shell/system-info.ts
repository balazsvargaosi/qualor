import { Injectable, computed, inject, resource } from '@angular/core';
import { Api, ok } from '../api/api';
import type { ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';

export type SystemInfoDto = ResponseBody<'/api/v0/system/info', 'get'>;
export type UiExtension = SystemInfoDto['extensions'][number];

/**
 * The feature each known enterprise entry needs (rbac-audit.md §17, sso-scim.md §18, 4E-1 §4,
 * 4E-2 §4): `compliance` is both a settings entry and a project tab; `portfolio` a main-menu entry.
 */
const EXTENSION_FEATURES: Readonly<Record<string, string>> = {
  'audit-log': 'audit-log',
  'audit-settings': 'audit-log',
  'linked-accounts': 'sso',
  sso: 'sso',
  'sign-in': 'sso',
  scim: 'scim',
  compliance: 'compliance-export',
  portfolio: 'portfolio',
};

/**
 * `GET /api/v0/system/info` once per signed-in user: the edition, the active features and the UI
 * extension points of the loaded plugins (enterprise.md §7.3, §10.4). Null while it loads or when
 * it failed; nothing reads `value()` in the error state, which throws.
 */
@Injectable({ providedIn: 'root' })
export class SystemInfo {
  private readonly api = inject(Api);
  private readonly session = inject(SessionStore);
  private readonly resource = resource({
    params: () => this.session.user()?.id,
    loader: async () => ok(this.api.client.GET('/api/v0/system/info')),
  });

  readonly info = computed<SystemInfoDto | null>(() =>
    this.resource.hasValue() ? this.resource.value() : null,
  );
  /**
   * The plugins' entries of every point. An entry for a known enterprise screen appears only while
   * its feature is active (rbac-audit.md §17: no audit link without `audit-log`).
   */
  private readonly active = computed<UiExtension[]>(() =>
    (this.info()?.extensions ?? []).filter((e) => {
      const feature = EXTENSION_FEATURES[e.id];
      return feature === undefined || this.features().includes(feature);
    }),
  );
  /** The plugins' settings entries (`settings.nav`); never a project tab. */
  readonly extensions = computed<UiExtension[]>(() =>
    this.active().filter((e) => e.point === 'settings.nav'),
  );
  /** The plugins' project tabs (`project.tab`, 4E-1 §4); never a settings entry. */
  readonly projectTabs = computed<UiExtension[]>(() =>
    this.active().filter((e) => e.point === 'project.tab'),
  );
  /** The plugins' main-menu entries (`main.nav`, 4E-2 §4); never a settings entry or a tab. */
  readonly mainNav = computed<UiExtension[]>(() =>
    this.active().filter((e) => e.point === 'main.nav'),
  );
  /** The active enterprise features (`audit-log`, `sso`, …); none while loading or after a failure. */
  readonly features = computed<readonly string[]>(() => this.info()?.features ?? []);
  /** The failure of the last load, or null; a page that depends on the answer says so. */
  readonly error = computed<unknown>(() =>
    this.resource.status() === 'error' ? (this.resource.error() ?? null) : null,
  );

  reload(): void {
    this.resource.reload();
  }
}
