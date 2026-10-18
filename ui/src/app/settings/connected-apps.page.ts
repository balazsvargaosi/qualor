import { Component, type ElementRef, inject, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, done, ok } from '../api/api';
import { SessionStore } from '../auth/session';
import { type GrantSource, OAuthGrants } from './oauth-grants';

/**
 * Settings → Connected apps (spec §8), every user: the MCP clients you allowed on the consent
 * screen (`GET /me/oauth-grants`, not paged), each with a Disconnect that revokes its grant, so its
 * tokens stop at once. With none, the page says how to connect one.
 */
@Component({
  selector: 'q-connected-apps-page',
  imports: [OAuthGrants, RouterLink],
  templateUrl: './connected-apps.page.html',
})
export class ConnectedAppsPage {
  private readonly api = inject(Api);
  /** The read-only demo cannot disconnect (the server refuses it). */
  protected readonly demo = inject(SessionStore).demo;
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  protected readonly headingFocus = () => this.heading().nativeElement;
  protected readonly source: GrantSource = {
    list: async () => (await ok(this.api.client.GET('/api/v0/me/oauth-grants'))).items,
    revoke: (grant) =>
      done(
        this.api.client.DELETE('/api/v0/me/oauth-grants/{id}', {
          params: { path: { id: grant.id } },
        }),
      ),
    question: (grant) =>
      $localize`:@@connectedApps.confirmDisconnect:Disconnect ${grant.client.name}:app:? It can no longer use Qualor until you connect it again.`,
  };
}
