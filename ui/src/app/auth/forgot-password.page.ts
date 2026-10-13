import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { problemMessage } from '../api/errors';
import { AuthLayout } from '../shared/auth-layout';
import { inputValue } from '../shared/forms';
import { AuthService } from './auth.service';

/**
 * Mail E2 A3: asks for a reset link by username or email. The answer is the same whether or not an
 * account matches; without email on the server the page says to ask an administrator.
 */
@Component({
  selector: 'q-forgot-password-page',
  imports: [AuthLayout, RouterLink],
  templateUrl: './forgot-password.page.html',
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthService);
  /** `GET /auth/methods` `passwordReset`; undefined while it loads, false when it fails. */
  protected readonly available = signal<boolean | undefined>(undefined);
  protected readonly login = signal('');
  protected readonly sent = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly inputValue = inputValue;

  constructor() {
    this.auth.methods().then(
      (methods) => this.available.set(methods.passwordReset),
      () => this.available.set(false),
    );
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const login = this.login().trim();
    if (this.busy() || login === '') return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.requestPasswordReset(login);
      this.sent.set(true);
    } catch (err) {
      this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
