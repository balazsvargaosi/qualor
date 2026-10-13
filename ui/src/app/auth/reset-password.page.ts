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
import { AuthLayout } from '../shared/auth-layout';
import { inputValue } from '../shared/forms';
import { AuthService } from './auth.service';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './change-password.page';
import { takeLinkToken } from './fragment-token';
import { newPasswordProblem } from './new-password';

/**
 * Mail E2: `/reset-password#token=…`. Takes the token out of the address bar (and the router's
 * URL) at once, posts it in the body with the new password, then opens the sign-in page with the
 * username (A5: no sign-in).
 */
@Component({
  selector: 'q-reset-password-page',
  imports: [AuthLayout, RouterLink],
  templateUrl: './reset-password.page.html',
})
export class ResetPasswordPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly token = takeLinkToken();
  /** No token in the link, or the server said it expired or was used. */
  protected readonly invalid = signal(this.token === null);
  protected readonly next = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nextError = signal<string | null>(null);
  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly maxLength = PASSWORD_MAX_LENGTH;
  protected readonly inputValue = inputValue;
  private readonly invalidNote = viewChild<ElementRef<HTMLElement>>('invalidNote');

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
      if (err instanceof ApiError && err.code === 'TOKEN_INVALID') this.showInvalid();
      else if (fieldErrors(err)['body.newPassword']) {
        this.nextError.set(newPasswordProblem('', ''));
      } else this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The note replaces the form, which had focus: focus moves to the note, so it is read out. */
  private showInvalid(): void {
    this.invalid.set(true);
    afterNextRender(() => this.invalidNote()?.nativeElement.focus(), { injector: this.injector });
  }
}
