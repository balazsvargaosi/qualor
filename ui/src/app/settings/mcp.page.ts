import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, ok } from '../api/api';
import { fieldErrors, problemMessage } from '../api/errors';
import type { ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { inputValue, isChecked } from '../shared/forms';
import { CopyValue } from './copy-value';

type McpSettings = ResponseBody<'/api/v0/system/mcp', 'get'>;

/** The server's bounds on the allow-list (oauth/policy.ts): 100 entries, no spaces. */
const MAX_ENTRIES = 100;
const ENTRY = /^\S{1,2048}$/;

/** The allow-list's lines, trimmed, without empty ones; null when a line cannot be an entry. */
export function parseAllowList(text: string): string[] | null {
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return entries.length <= MAX_ENTRIES && entries.every((e) => ENTRY.test(e)) ? entries : null;
}

function allowListRefusal(): string {
  return $localize`:@@mcp.allowedInvalid:One client id or URL prefix per line, without spaces, at most ${MAX_ENTRIES}:max: lines.`;
}

/**
 * Settings → MCP (6N spec §9), for instance admins: the endpoint's URL to copy into an MCP client
 * (or, while QUALOR_PUBLIC_URL is unset, how to turn it on), and which OAuth clients may connect:
 * apps that register themselves (dynamic registration), apps identified by a metadata URL (CIMD),
 * and an allow-list of client ids or URL prefixes ending in `/` (empty lets every app in). Saved
 * with `PUT /system/mcp`.
 */
@Component({
  selector: 'q-mcp-page',
  imports: [CopyValue],
  templateUrl: './mcp.page.html',
  styleUrl: './mcp.page.css',
})
export class McpPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly session = inject(SessionStore);
  protected readonly instanceAdmin = computed(() => this.session.user()?.isInstanceAdmin === true);

  protected readonly current = signal<McpSettings | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly dcr = signal(true);
  protected readonly cimd = signal(true);
  protected readonly allowed = signal('');
  protected readonly allowedError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly busy = signal(false);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  constructor() {
    effect(() => {
      const admin = this.instanceAdmin();
      untracked(() => {
        if (admin) void this.load();
      });
    });
  }

  protected setDcr(event: Event): void {
    this.dcr.set(isChecked(event));
    this.announcement.set(null);
  }

  protected setCimd(event: Event): void {
    this.cimd.set(isChecked(event));
    this.announcement.set(null);
  }

  protected setAllowed(event: Event): void {
    this.allowed.set(inputValue(event));
    this.allowedError.set(null);
    this.announcement.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.current()) return;
    const allowedClients = parseAllowList(this.allowed());
    if (allowedClients === null) {
      this.refuseAllowList();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      const saved = await ok(
        this.api.client.PUT('/api/v0/system/mcp', {
          body: { dcr: this.dcr(), cimd: this.cimd(), allowedClients },
        }),
      );
      this.show(saved);
      this.announcement.set($localize`:@@mcp.saved:The MCP settings were saved.`);
    } catch (err) {
      if (Object.keys(fieldErrors(err)).some((path) => path.startsWith('body.allowedClients'))) {
        this.refuseAllowList();
        return;
      }
      this.error.set(problemMessage(err));
      this.heading().nativeElement.focus();
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loadError.set(null);
    try {
      this.show(await ok(this.api.client.GET('/api/v0/system/mcp')));
    } catch (err) {
      this.loadError.set(problemMessage(err));
    }
  }

  private show(settings: McpSettings): void {
    this.current.set(settings);
    this.dcr.set(settings.policy.dcr);
    this.cimd.set(settings.policy.cimd);
    this.allowed.set(settings.policy.allowedClients.join('\n'));
    this.allowedError.set(null);
  }

  private refuseAllowList(): void {
    this.allowedError.set(allowListRefusal());
    afterNextRender(() => this.document.getElementById('mcp-allowed')?.focus(), {
      injector: this.injector,
    });
  }
}
