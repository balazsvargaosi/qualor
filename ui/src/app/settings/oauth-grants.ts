import { DOCUMENT } from '@angular/common';
import {
  Component,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { problemMessage } from '../api/errors';
import type { ItemOf } from '../api/types';
import { DateTimePipe } from '../shared/date-time.pipe';
import { closeModal, openAfterRender } from '../shared/dialog';
import { keepFocus, rowAt } from '../shared/focus';

export type OAuthGrant = ItemOf<'/api/v0/me/oauth-grants'>;

/** Whose connected apps a list shows: yours (`/me/oauth-grants`) or a user's (admins). */
export interface GrantSource {
  list(): Promise<OAuthGrant[]>;
  revoke(grant: OAuthGrant): Promise<void>;
  /** What the confirmation dialog asks before Disconnect. */
  question(grant: OAuthGrant): string;
}

export function grantScopeLabel(grant: OAuthGrant): string {
  return grant.scopes.includes('mcp:write')
    ? $localize`:@@oauthGrants.scope.write:Read and change issue statuses`
    : $localize`:@@oauthGrants.scope.read:Read`;
}

/**
 * A list of connected apps (OAuth grants of MCP clients, spec §8): the app, its access, when it
 * was connected and last used, and a quiet Disconnect that asks in the page's dialog first (as
 * Revoke does on the tokens page). Disconnecting revokes the grant: its tokens stop at once. An app
 * that registered itself (`dcr`) is marked as not verified, since anyone can give it any name. What
 * the list shows when it is empty is the content.
 */
@Component({
  selector: 'q-oauth-grants',
  imports: [DateTimePipe],
  templateUrl: './oauth-grants.html',
})
export class OAuthGrants {
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  readonly source = input.required<GrantSource>();
  /** The table's caption (visually hidden). */
  readonly caption = input.required<string>();
  /** The read-only demo: no Disconnect (the server refuses it). */
  readonly readOnly = input(false);
  /** Where focus goes when the disconnected row was the last one. */
  readonly fallbackFocus = input<() => HTMLElement | null | undefined>(() => null);

  protected readonly grants = signal<OAuthGrant[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly pending = signal<{ grant: OAuthGrant; question: string } | null>(null);
  protected readonly scopeLabel = grantScopeLabel;
  private readonly table = viewChild<ElementRef<HTMLElement>>('table');
  private readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');
  /** Counts the sources read: an answer for an earlier one is dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const source = this.source();
      untracked(() => {
        this.generation++;
        this.grants.set(null);
        this.error.set(null);
        this.announcement.set(null);
        void this.load(source, this.generation);
      });
    });
  }

  protected disconnectLabel(grant: OAuthGrant): string {
    return $localize`:@@oauthGrants.disconnectNamed:Disconnect ${grant.client.name}:app:`;
  }

  /** Asks in the page's dialog; nothing is sent until its Disconnect. */
  protected disconnect(grant: OAuthGrant): void {
    if (this.busy()) return;
    this.pending.set({ grant, question: this.source().question(grant) });
    openAfterRender(
      this.injector,
      () => this.confirmDialog()?.nativeElement,
      () => this.pending() !== null,
    );
  }

  protected async confirm(): Promise<void> {
    const pending = this.pending();
    if (!pending) return;
    // Cleared first: the dialog's close event then finds nothing to cancel.
    this.pending.set(null);
    const dialog = this.confirmDialog()?.nativeElement;
    if (dialog) closeModal(dialog);
    await this.apply(pending.grant);
  }

  /** Cancel, Escape or the dialog closing otherwise: nothing is disconnected. */
  protected cancel(): void {
    this.pending.set(null);
    const dialog = this.confirmDialog()?.nativeElement;
    if (dialog?.open) closeModal(dialog);
  }

  private async load(source: GrantSource, generation: number): Promise<void> {
    this.loadError.set(null);
    try {
      const grants = await source.list();
      if (generation === this.generation) this.grants.set(grants);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  private async apply(grant: OAuthGrant): Promise<void> {
    if (this.busy()) return;
    const source = this.source();
    const generation = this.generation;
    const index = (this.grants() ?? []).findIndex((g) => g.id === grant.id);
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      await source.revoke(grant);
      const grants = await source.list();
      if (generation !== this.generation) return;
      this.grants.set(grants);
      this.announcement.set(
        $localize`:@@oauthGrants.disconnected:${grant.client.name}:app: disconnected.`,
      );
    } catch (err) {
      if (generation === this.generation) this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
    keepFocus(
      this.injector,
      this.document,
      () => rowAt(this.table()?.nativeElement, index)?.querySelector('button'),
      () => this.fallbackFocus()(),
    );
  }
}
