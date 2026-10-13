import {
  afterNextRender,
  Component,
  type ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../api/api';
import { ApiError, problemMessage } from '../api/errors';
import { AuthLayout } from '../shared/auth-layout';
import { takeLinkToken } from './fragment-token';

type State = 'ask' | 'busy' | 'done' | 'invalid' | 'missing' | 'error';

/**
 * The "Stop watching this project" link of a notification email (mail E3 N5):
 * `/unsubscribe#t=<token>`. The token is in the fragment, so it never reaches a server log; the
 * page removes it from the address bar at once. Opening the page changes nothing (a link scanner
 * must not unsubscribe anyone): one button posts the token. No sign-in needed.
 */
@Component({
  selector: 'q-unsubscribe-page',
  imports: [AuthLayout, RouterLink],
  templateUrl: './unsubscribe.page.html',
})
export class UnsubscribePage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  /** E2's helper: reads `#t=…`, takes it out of the address bar and the router's URL. */
  private readonly token: string | null = ((t) => (t !== null && t.length <= 512 ? t : null))(
    takeLinkToken('t'),
  );
  protected readonly state = signal<State>(this.token === null ? 'missing' : 'ask');
  protected readonly projectName = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  protected async confirm(): Promise<void> {
    if (this.token === null || this.state() === 'busy') return;
    this.state.set('busy');
    this.error.set(null);
    try {
      const result = await ok(
        this.api.client.POST('/api/v0/notifications/unsubscribe', {
          params: { query: { t: this.token } },
        }),
      );
      this.projectName.set(result.project?.name ?? null);
      this.showResult('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        this.showResult('invalid');
      } else {
        this.error.set(problemMessage(err));
        this.state.set('error');
      }
    }
  }

  /** The answer replaces the button, which had focus: focus moves to its heading, so it is read out. */
  private showResult(state: 'done' | 'invalid'): void {
    this.state.set(state);
    afterNextRender(() => this.result()?.nativeElement.focus(), { injector: this.injector });
  }
}
