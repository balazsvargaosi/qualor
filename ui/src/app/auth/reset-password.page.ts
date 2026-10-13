import { DOCUMENT } from '@angular/common';
import { afterNextRender, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError, fieldErrors, problemMessage } from '../api/errors';
import { AuthLayout } from '../shared/auth-layout';
import { inputValue } from '../shared/forms';
import { AuthService } from './auth.service';
import { PASSWORD_MIN_LENGTH } from './change-password.page';
import { takeFragmentToken } from './fragment-token';
import { newPasswordProblem } from './new-password';

/**
 * Mail E2: `/reset-password#token=…`. Takes the token out of the address bar at once, posts it in
 * the body with the new password, then opens the sign-in page with the username (A5: no sign-in).
 */
@Component({
  selector: 'q-reset-password-page',
  imports: [AuthLayout, RouterLink],
  templateUrl: './reset-password.page.html',
})
export class ResetPasswordPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly token = takeFragmentToken(this.document);
  /** No token in the link, or the server said it expired or was used. */
  protected readonly invalid = signal(this.token === null);
  protected readonly next = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nextError = signal<string | null>(null);
  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly inputValue = inputValue;

  constructor() {
    // The router writes the address it navigated to, fragment included, to the address bar. Today
    // it does so before it creates this page, but a write that lands after the field above read
    // the token would put it back: clear it once more after the first render (preflight M15).
    afterNextRender(() => takeFragmentToken(this.document));
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
      const username = await this.auth.completePasswordReset(token, this.next());
      await this.router.navigate(['/login'], { queryParams: { reset: 'done', username } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_INVALID') this.invalid.set(true);
      else if (fieldErrors(err)['body.newPassword']) {
        this.nextError.set(newPasswordProblem('', ''));
      } else this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
