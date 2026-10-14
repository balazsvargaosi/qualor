import { Injectable, computed, inject, resource, signal } from '@angular/core';
import { Api, ok } from '../api/api';
import { SessionStore } from '../auth/session';

/** The release whose banner an admin dismissed, per browser. */
export const DISMISS_KEY = 'qualor.update-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * The server's update check (telemetry.md "Update check") for instance admins: `GET
 * /api/v0/system/version` once per admin; other users never ask. `latest` is null while loading,
 * after a failure, or when the server knows of nothing newer (telemetry off included).
 */
@Injectable({ providedIn: 'root' })
export class UpdateNotice {
  private readonly api = inject(Api);
  private readonly session = inject(SessionStore);
  private readonly resource = resource({
    params: () => {
      const user = this.session.user();
      return user?.isInstanceAdmin ? user.id : undefined;
    },
    loader: () => ok(this.api.client.GET('/api/v0/system/version')),
  });
  private readonly value = computed(() =>
    this.resource.hasValue() ? this.resource.value() : null,
  );
  /** Kept here too, so Dismiss works for this page load even when storage is blocked. */
  private readonly dismissedVersion = signal<string | null>(readDismissed());

  readonly version = computed(() => this.value()?.version ?? null);
  readonly latest = computed(() => this.value()?.latest ?? null);
  readonly dismissed = computed(() => {
    const latest = this.latest();
    return latest !== null && this.dismissedVersion() === latest;
  });

  dismiss(): void {
    const latest = this.latest();
    if (latest === null) return;
    this.dismissedVersion.set(latest);
    try {
      localStorage.setItem(DISMISS_KEY, latest);
    } catch {
      // Blocked storage: hidden until the next load only.
    }
  }
}
