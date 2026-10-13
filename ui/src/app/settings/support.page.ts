import { Component, computed, inject } from '@angular/core';
import { problemMessage } from '../api/errors';
import { SessionStore } from '../auth/session';
import { SystemInfo } from '../shell/system-info';
import { CopyValue } from './copy-value';

/** 4E-3b §4: the feature that makes the bundle available. */
export const SUPPORT_FEATURE = 'support-bundle';
/** The feature whose audit log records each download (`support.bundle_downloaded`). */
export const AUDIT_LOG_FEATURE = 'audit-log';
/** Where the bundle is downloaded from (below the site's own origin, with the session cookie). */
export const SUPPORT_BUNDLE_URL = '/api/v0/ee/support/bundle';
/** 4E-3b §5: where to send it. */
export const SUPPORT_EMAIL = 'support@qualor.dev';
/** The command while the server runs: its configuration, licence and database are the server's. */
export const COMMAND_RUNNING =
  'docker compose exec -T server /usr/local/bin/node dist/main.js support-bundle > qualor-support.zip';
/** The command while the server is stopped: a one-off container with the same configuration. */
export const COMMAND_STOPPED =
  'docker compose run --rm -T server support-bundle > qualor-support.zip';

/**
 * Settings → Support (4E-3b §5, feature `support-bundle`, instance admins): what the support
 * bundle holds and never holds, the **Download support bundle** link (and, with the audit log,
 * that each download is recorded), the command for when the web UI cannot be reached and the
 * support address. The page asks the server nothing itself; the download is a plain link, and the
 * server checks the licence and the administrator again.
 */
@Component({
  selector: 'q-support-page',
  imports: [CopyValue],
  templateUrl: './support.page.html',
})
export class SupportPage {
  private readonly session = inject(SessionStore);
  private readonly info = inject(SystemInfo);

  protected readonly bundleUrl = SUPPORT_BUNDLE_URL;
  protected readonly email = SUPPORT_EMAIL;
  protected readonly commandRunning = COMMAND_RUNNING;
  protected readonly commandStopped = COMMAND_STOPPED;
  protected readonly licensed = computed(() => this.info.features().includes(SUPPORT_FEATURE));
  /** Only with the audit log active is the download recorded, so only then does the page say so. */
  protected readonly audited = computed(() => this.info.features().includes(AUDIT_LOG_FEATURE));
  protected readonly infoLoaded = computed(() => this.info.info() !== null);
  protected readonly infoError = computed(() => {
    const err = this.info.error();
    return err === null ? null : problemMessage(err);
  });
  protected readonly instanceAdmin = computed(() => this.session.user()?.isInstanceAdmin === true);
  protected readonly allowed = computed(() => this.licensed() && this.instanceAdmin());
}
