import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, ok } from '../api/api';
import { ApiError, problemMessage } from '../api/errors';
import type { ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { AuthLayout } from '../shared/auth-layout';
import { keepFocus } from '../shared/focus';
import { isChecked } from '../shared/forms';
import { LEAVE_APP } from '../shared/leave-app';

type Pending = ResponseBody<'/api/v0/oauth/requests/{id}', 'get'>;
type Scope = Pending['scopes'][number];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The redirect URI, unless it is https (then its host says enough). */
function unlessHttps(uri: string): string | null {
  return uri.startsWith('https://') ? null : uri;
}

/**
 * Where the browser goes back to, in our words: an https address by its host, a loopback one as
 * "this computer", anything else (a custom scheme) as written. The server's `redirectTarget` says
 * the same in English; the screen never shows server text.
 */
function redirectLabel(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }
  if (url.protocol === 'https:') return url.host;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return $localize`:@@consent.thisComputer:this computer`;
  }
  return uri;
}

/**
 * Spec §6 step 6: an MCP client asks for access as the signed-in user (`/oauth/consent?request=`,
 * where `/oauth/authorize` sends the browser). Reading the request binds it to this user. The
 * answer goes through fetch with the CSRF header, never a form post (the CSP's `form-action 'self'`
 * blocks a form whose redirect leaves this origin); the browser then follows `redirectTo`. A
 * request a live grant already covers is approved at once. The client's logo is never loaded (the
 * CSP's `img-src 'self' data:`): its initial stands in. A 404 (expired, already answered, or
 * another user's) and 403 `CLIENT_NOT_ALLOWED` have their own messages; the read-only demo gets no
 * buttons, since the server refuses its answer.
 */
@Component({
  selector: 'q-consent-page',
  imports: [AuthLayout],
  templateUrl: './consent.page.html',
  styleUrl: './consent.page.css',
})
export class ConsentPage {
  private readonly api = inject(Api);
  private readonly leave = inject(LEAVE_APP);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly session = inject(SessionStore);
  protected readonly username = computed(() => this.session.user()?.username ?? '');
  protected readonly demo = this.session.demo;
  /** `?request=` (router input binding). */
  readonly request = input<string>();
  protected readonly pending = signal<Pending | null>(null);
  /** The "change issue statuses" box, when the client asked for `mcp:write`. */
  protected readonly write = signal(false);
  protected readonly asksWrite = computed(
    () => this.pending()?.scopes.includes('mcp:write') === true,
  );
  /** A grant covers the request and its approval is on its way: no form. */
  protected readonly automatic = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The server does not know the request (any more): expired, answered or someone else's. */
  protected readonly gone = signal(false);
  /** The instance's client policy refuses this app (403 `CLIENT_NOT_ALLOWED`): only Deny is left. */
  protected readonly refused = signal(false);
  /** Answered: the browser is leaving for the client. */
  protected readonly left = signal(false);
  protected readonly target = computed(() => {
    const uri = this.pending()?.client.redirectUri;
    return uri === undefined ? '' : redirectLabel(uri);
  });
  /** The first character as a whole code point (a name may start with an emoji). */
  protected readonly initial = computed(
    () => Array.from(this.pending()?.client.name ?? '')[0] ?? '',
  );
  /** CIMD only: the client id is an https address, whose host identifies the app better than its name. */
  protected readonly identifiedBy = computed(() => {
    const client = this.pending()?.client;
    if (client?.source !== 'cimd') return null;
    try {
      return new URL(client.clientId).host;
    } catch {
      return null;
    }
  });
  protected readonly fullRedirect = computed(() => {
    const uri = this.pending()?.client.redirectUri;
    return uri === undefined ? null : unlessHttps(uri);
  });
  private readonly gonePanel = viewChild<ElementRef<HTMLElement>>('gonePanel');
  private readonly denyButton = viewChild<ElementRef<HTMLElement>>('denyButton');

  constructor() {
    effect(() => {
      const id = this.request();
      untracked(() => {
        this.pending.set(null);
        this.gone.set(false);
        this.refused.set(false);
        this.error.set(null);
        this.left.set(false);
        this.busy.set(false);
        this.automatic.set(false);
        this.write.set(false);
        if (id) void this.start(id);
        else this.showGone();
      });
    });
  }

  protected setWrite(event: Event): void {
    this.write.set(isChecked(event));
  }

  private async start(id: string): Promise<void> {
    let p: Pending;
    try {
      p = await ok(
        this.api.client.GET('/api/v0/oauth/requests/{id}', { params: { path: { id } } }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) this.showGone();
      else this.error.set(problemMessage(err));
      return;
    }
    this.pending.set(p);
    this.write.set(p.scopes.includes('mcp:write'));
    if (p.coveredByGrant && !this.demo()) {
      this.automatic.set(true);
      await this.answer('approve');
      this.automatic.set(false);
    }
  }

  protected async answer(decision: 'approve' | 'deny'): Promise<void> {
    const p = this.pending();
    if (!p || this.busy() || this.left()) return;
    if (decision === 'approve' && this.refused()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const scopes: Scope[] = this.write() ? ['mcp:read', 'mcp:write'] : ['mcp:read'];
      const { redirectTo } = await ok(
        this.api.client.POST('/api/v0/oauth/requests/{id}/decision', {
          params: { path: { id: p.id } },
          body: decision === 'approve' ? { decision, scopes } : { decision },
        }),
      );
      this.left.set(true);
      this.leave(redirectTo);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) this.showGone();
      else if (err instanceof ApiError && err.code === 'CLIENT_NOT_ALLOWED') {
        this.refused.set(true);
        this.error.set(
          $localize`:@@consent.notAllowed:The administrator of this server does not allow this app.`,
        );
        // Allow, which had focus, is gone: Deny is what is left to press.
        keepFocus(this.injector, this.document, () => this.denyButton()?.nativeElement);
      } else this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The form, which may have had focus, is replaced by the note: focus moves to the note. */
  private showGone(): void {
    this.gone.set(true);
    this.pending.set(null);
    afterNextRender(() => this.gonePanel()?.nativeElement.focus(), { injector: this.injector });
  }
}
