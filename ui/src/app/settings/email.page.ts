import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../api/api';
import { ApiError, fieldErrors } from '../api/errors';
import type { RequestBody, ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { DateTimePipe } from '../shared/date-time.pipe';
import { inputValue } from '../shared/forms';
import { KeysetList } from '../shared/keyset';
import {
  fieldRefusal,
  mailProblemText,
  messageKindText,
  messageStatusBadge,
  messageStatusText,
  securityHint,
  type Field,
  type MailMessage,
  type Security,
} from './email-text';

type MailSettings = ResponseBody<'/api/v0/system/mail', 'get'>;
type MailBody = RequestBody<'/api/v0/system/mail', 'put'>;
type Alert = keyof MailSettings['alerts'];
type TextField = Exclude<Field, 'password' | 'test-to'>;
type TestResult =
  { ok: true; response: string; ms: number } | { ok: false; message: string; reply: string | null };

/** The server's 422 paths and the field each one refuses. */
const SERVER_PATHS: readonly (readonly [string, Field])[] = [
  ['body.server.host', 'host'],
  ['body.server.port', 'port'],
  ['body.server.username', 'username'],
  ['body.server.password', 'password'],
  ['body.server.fromName', 'from-name'],
  ['body.server.fromAddress', 'from-address'],
  ['body.server.replyTo', 'reply-to'],
  ['body.to', 'test-to'],
];
const DEFAULT_PORTS = new Set(['587', '465', '25']);
const DEFAULT_PORT: Readonly<Record<Security, string>> = {
  starttls: '587',
  tls: '465',
  none: '25',
};
const MESSAGES_PER_PAGE = 20;

/** The password part of a save: removed, replaced by the one typed, or else left as stored. */
function passwordChange(remove: boolean, typed: string): { password?: string | null } {
  if (remove) return { password: null };
  return typed === '' ? {} : { password: typed };
}

/**
 * Settings → Email (E1 spec), for instance admins: the state, the SMTP server (read-only when
 * QUALOR_SMTP_URL sets it; the password write-only: read from its field at a save that goes out,
 * emptied once stored, never kept in the page's state, never shown), a test message, the two
 * alerts for administrators (saved at once), and the recent messages with their status.
 */
@Component({
  selector: 'q-email-settings-page',
  imports: [DateTimePipe, RouterLink],
  templateUrl: './email.page.html',
  styleUrl: './email.page.css',
})
export class EmailSettingsPage {
  private readonly api = inject(Api);
  private readonly session = inject(SessionStore);
  protected readonly instanceAdmin = computed(() => this.session.user()?.isInstanceAdmin === true);

  protected readonly settings = signal<MailSettings | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly values: Readonly<Record<TextField, WritableSignal<string>>> = {
    host: signal(''),
    port: signal('587'),
    username: signal(''),
    'from-name': signal('Qualor'),
    'from-address': signal(''),
    'reply-to': signal(''),
  };
  protected readonly security = signal<Security>('starttls');
  /** The password input shows: no password is stored, or Replace was pressed. */
  protected readonly replacingPassword = signal(true);
  protected readonly removePassword = signal(false);
  protected readonly errors = signal<Partial<Record<Field, string>>>({});
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly testTo = signal('');
  protected readonly testing = signal(false);
  protected readonly testResult = signal<TestResult | null>(null);
  protected readonly alertsError = signal<string | null>(null);
  protected readonly messages = new KeysetList<MailMessage, number>((limit, cursor) =>
    ok(
      this.api.client.GET('/api/v0/system/mail/messages', {
        params: { query: { limit, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );

  protected readonly securities: readonly { id: Security; label: string }[] = [
    { id: 'starttls', label: $localize`:@@email.security.starttls:STARTTLS` },
    { id: 'tls', label: $localize`:@@email.security.tls:TLS` },
    { id: 'none', label: $localize`:@@email.security.none:None` },
  ];
  protected readonly server = computed(() => this.settings()?.server ?? null);
  protected readonly fromEnvironment = computed(() => this.settings()?.source === 'environment');
  protected readonly state = computed<'off' | 'on' | 'failing'>(() => {
    const s = this.settings();
    if (!s?.server) return 'off';
    return s.lastMessage?.status === 'failed' ? 'failing' : 'on';
  });
  protected readonly securityHint = computed(() => securityHint(this.security()));
  protected readonly kindText = messageKindText;
  protected readonly statusText = messageStatusText;
  protected readonly statusBadge = messageStatusBadge;
  private readonly passwordField = viewChild<ElementRef<HTMLInputElement>>('passwordField');

  constructor() {
    effect(() => {
      const admin = this.instanceAdmin();
      untracked(() => {
        if (admin) void this.load();
      });
    });
  }

  private async load(): Promise<void> {
    try {
      this.apply(await ok(this.api.client.GET('/api/v0/system/mail')));
      this.testTo.set(this.session.user()?.email ?? '');
      void this.messages.reset(MESSAGES_PER_PAGE);
    } catch (err) {
      this.loadError.set(mailProblemText(err));
    }
  }

  private apply(s: MailSettings): void {
    this.settings.set(s);
    const server = s.server;
    this.values.host.set(server?.host ?? '');
    this.values.port.set(String(server?.port ?? 587));
    this.values.username.set(server?.username ?? '');
    this.values['from-name'].set(server?.fromName ?? 'Qualor');
    this.values['from-address'].set(server?.fromAddress ?? '');
    this.values['reply-to'].set(server?.replyTo ?? '');
    this.security.set(server?.security ?? 'starttls');
    this.replacingPassword.set(!server?.passwordSet);
    this.removePassword.set(false);
  }

  protected fieldError(field: Field): string | null {
    return this.errors()[field] ?? null;
  }

  protected describedBy(field: Field, hint = false): string | null {
    const ids = [
      this.fieldError(field) ? `email-${field}-error` : null,
      hint ? `email-${field}-hint` : null,
    ].filter((id) => id !== null);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected clearError(field: Field): void {
    if (this.errors()[field] === undefined) return;
    this.errors.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
    );
  }

  protected edit(field: TextField, event: Event): void {
    this.values[field].set(inputValue(event));
    this.clearError(field);
  }

  protected editTestTo(event: Event): void {
    this.testTo.set(inputValue(event));
    this.clearError('test-to');
  }

  /** A default port follows the security; a port typed by hand stays. */
  protected setSecurity(security: Security): void {
    this.security.set(security);
    if (DEFAULT_PORTS.has(this.values.port())) this.values.port.set(DEFAULT_PORT[security]);
  }

  protected replacePassword(): void {
    this.removePassword.set(false);
    this.replacingPassword.set(true);
  }

  protected toggleRemovePassword(): void {
    this.removePassword.update((remove) => !remove);
  }

  private localRefusals(host: string): Partial<Record<Field, string>> {
    const refused: Partial<Record<Field, string>> = {};
    if (host === '') return refused;
    const port = Number(this.values.port());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) refused.port = fieldRefusal('port');
    if (this.values['from-name']().trim() === '') refused['from-name'] = fieldRefusal('from-name');
    if (this.values['from-address']().trim() === '') {
      refused['from-address'] = fieldRefusal('from-address');
    }
    return refused;
  }

  private serverRefusals(err: unknown): Partial<Record<Field, string>> {
    const refused: Partial<Record<Field, string>> = {};
    for (const path of Object.keys(fieldErrors(err))) {
      const match = SERVER_PATHS.find(
        ([prefix]) => path === prefix || path.startsWith(`${prefix}.`),
      );
      if (match && refused[match[1]] === undefined) refused[match[1]] = fieldRefusal(match[1]);
    }
    return refused;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving() || this.fromEnvironment()) return;
    const host = this.values.host().trim();
    const refused = this.localRefusals(host);
    this.errors.set(refused);
    // A refused save keeps what was typed, the password too: it is read only for a save that goes
    // out, and its field is emptied once the server has stored it.
    if (Object.keys(refused).length > 0) return;
    const field = this.passwordField()?.nativeElement;
    const typed = field?.value ?? '';
    const body: MailBody = {
      server:
        host === ''
          ? null
          : {
              host,
              port: Number(this.values.port()),
              security: this.security(),
              username: this.values.username().trim() || null,
              fromName: this.values['from-name']().trim(),
              fromAddress: this.values['from-address']().trim(),
              replyTo: this.values['reply-to']().trim() || null,
              ...passwordChange(this.removePassword(), typed),
            },
    };
    this.saving.set(true);
    this.saveError.set(null);
    this.announcement.set(null);
    try {
      const saved = await ok(this.api.client.PUT('/api/v0/system/mail', { body }));
      if (field) field.value = '';
      this.apply(saved);
      this.announcement.set($localize`:@@email.saved:Saved.`);
    } catch (err) {
      const fields = this.serverRefusals(err);
      this.errors.set(fields);
      this.saveError.set(Object.keys(fields).length > 0 ? null : mailProblemText(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async sendTest(event: Event): Promise<void> {
    event.preventDefault();
    if (this.testing()) return;
    const to = this.testTo().trim();
    if (to === '') {
      this.errors.update((errors) => ({ ...errors, 'test-to': fieldRefusal('test-to') }));
      return;
    }
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const answer = await ok(this.api.client.POST('/api/v0/system/mail/test', { body: { to } }));
      this.testResult.set({ ok: true, response: answer.response, ms: answer.ms });
    } catch (err) {
      const fields = this.serverRefusals(err);
      if (fields['test-to'] !== undefined) {
        this.errors.update((errors) => ({ ...errors, ...fields }));
      } else {
        const reply =
          err instanceof ApiError && err.code === 'MAIL_SEND_FAILED'
            ? (err.problem?.detail ?? null)
            : null;
        this.testResult.set({ ok: false, message: mailProblemText(err), reply });
      }
    } finally {
      this.testing.set(false);
      void this.messages.reload();
      void this.refreshState();
    }
  }

  /** The state line after a test: only `lastMessage`, so the form keeps what was typed. */
  private async refreshState(): Promise<void> {
    try {
      const s = await ok(this.api.client.GET('/api/v0/system/mail'));
      this.settings.update((current) =>
        current === null ? s : { ...current, lastMessage: s.lastMessage },
      );
    } catch {
      // The state line keeps what it said; the next visit reads it again.
    }
  }

  protected async setAlert(alert: Alert, event: Event): Promise<void> {
    const box = event.target as HTMLInputElement;
    const value = box.checked;
    this.alertsError.set(null);
    try {
      const s = await ok(
        this.api.client.PUT('/api/v0/system/mail', {
          body: {
            alerts:
              alert === 'licenseExpiry' ? { licenseExpiry: value } : { webhookFailures: value },
          },
        }),
      );
      this.settings.update((current) => (current === null ? s : { ...current, alerts: s.alerts }));
    } catch (err) {
      box.checked = !value;
      this.alertsError.set(mailProblemText(err));
    }
  }
}
