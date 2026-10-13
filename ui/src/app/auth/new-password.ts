import { PASSWORD_MIN_LENGTH } from './change-password.page';

/** The client-side checks of a new password and its confirmation (api.md §2: at least 12). */
export function newPasswordProblem(next: string, confirm: string): string | null {
  if (next.length < PASSWORD_MIN_LENGTH) {
    return $localize`:@@password.tooShort:Use at least ${PASSWORD_MIN_LENGTH}:min: characters.`;
  }
  if (next !== confirm) return $localize`:@@password.mismatch:The two new passwords differ.`;
  return null;
}
