import {
  afterNextRender,
  Component,
  type ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError, fieldErrors, problemMessage } from '../api/errors';
import type { InvitationInfo } from '../api/types';
import { AuthLayout } from '../shared/auth-layout';
import { inputValue } from '../shared/forms';
import { AuthService } from './auth.service';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './change-password.page';
import { takeLinkToken } from './fragment-token';
import { newPasswordProblem } from './new-password';

/**
 * Mail E2: `/accept-invite#token=…`. Asks who the link is for (without using it up), then sets the
 * first password and opens the sign-in page with the username (A5: no sign-in).
 */
@Component({
  selector: 'q-accept-invite-page',
  imports: [AuthLayout, RouterLink],
  templateUrl: './accept-invite.page.html',
})
export class AcceptInvitePage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly token = takeLinkToken();
  /** undefined while asking; null when the link is missing, expired or used. */
  protected readonly invitation = signal<InvitationInfo | null | undefined>(undefined);
  /** The server could not answer (not a refusal of the link). */
  protected readonly loadError = signal<string | null>(null);
  protected readonly next = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nextError = signal<string | null>(null);
  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly maxLength = PASSWORD_MAX_LENGTH;
  protected readonly inputValue = inputValue;
  private readonly invalidNote = viewChild<ElementRef<HTMLElement>>('invalidNote');

  constructor() {
    const token = this.token;
    if (token === null) {
      this.invitation.set(null);
      return;
    }
    this.auth.inspectInvitation(token).then(
      (info) => this.invitation.set(info),
      (err: unknown) => {
        if (err instanceof ApiError && err.code === 'TOKEN_INVALID') this.showInvalid();
        else this.loadError.set(problemMessage(err));
      },
    );
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const token = this.token;
    if (this.busy() || token === null) return;
    this.error.set(null);
    this.nextError.set(newPasswordProblem(this.next(), this.confirm()));
    if (this.nextError()) return;
    this.busy.set(true);
    try {
      const username = await this.auth.acceptInvitation(token, this.next());
      await this.router.navigate(['/login'], { queryParams: { invite: 'done', username } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_INVALID') this.showInvalid();
      else if (fieldErrors(err)['body.newPassword']) {
        this.nextError.set(newPasswordProblem('', ''));
      } else this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The note replaces the form (or the wait), which had focus: focus moves to the note. */
  private showInvalid(): void {
    this.invitation.set(null);
    afterNextRender(() => this.invalidNote()?.nativeElement.focus(), { injector: this.injector });
  }
}
