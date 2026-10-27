import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type FootOutcome, SectionFoot } from './section-foot';

/** A section with a field, and its foot with a projected Cancel before Save. */
@Component({
  imports: [SectionFoot],
  templateUrl: './section-foot.spec.html',
})
class Host {
  readonly cancel = 'Cancel';
  readonly outcome = signal<FootOutcome>({ kind: 'clean' });
  readonly saves = signal(0);
}

describe('SectionFoot', () => {
  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const status = () => root.querySelector<HTMLElement>('.setting-actions [role="status"]')!;
    const save = () =>
      root.querySelector<HTMLButtonElement>('.setting-actions > button:last-child')!;
    /** Save says it has nothing to save (`aria-disabled`); it is never `disabled`. */
    const unavailable = () => save().getAttribute('aria-disabled') === 'true' && !save().disabled;
    const show = async (outcome: FootOutcome) => {
      fixture.componentInstance.outcome.set(outcome);
      await fixture.whenStable();
    };
    return { fixture, root, status, save, unavailable, show, host: fixture.componentInstance };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  it('says what is pending, saved or refused in a polite live region beside its Save', async () => {
    const { root, status, save, unavailable, show } = await render();
    // The status first, then the projected buttons, then Save.
    const foot = root.querySelector('.setting-actions')!;
    expect([...foot.children].map((c) => c.id || c.className)).toEqual([
      'foot-status',
      'cancel',
      expect.stringContaining('btn'),
    ]);
    expect(status().classList).toContain('foot-status');

    await show({ kind: 'pending', count: 1 });
    expect(text(status())).toBe('1 unsaved change');
    expect(status().classList).toContain('pending');
    expect(save().type).toBe('button');
    expect(text(save())).toBe('Save limits');
    expect(unavailable()).toBe(false);
    expect(save().classList).toContain('btn-primary');

    await show({ kind: 'pending', count: 2 });
    expect(text(status())).toBe('2 unsaved changes');

    await show({ kind: 'clean' });
    expect(text(status())).toBe('No unsaved changes');
    expect(status().classList).not.toContain('pending');
    expect(unavailable()).toBe(true);
    expect(save().classList).not.toContain('btn-primary');

    await show({ kind: 'saving' });
    expect(text(status())).toBe('Saving…');
    expect(unavailable()).toBe(true);

    await show({ kind: 'saved', at: new Date('2026-10-26T14:05:00Z') });
    expect(text(status())).toBe('Saved at 2:05 PM UTC.');
    expect(status().classList).toContain('ok');
    expect(status().querySelector('q-icon svg')).not.toBeNull();
    expect(unavailable()).toBe(true);

    await show({
      kind: 'refused',
      fields: [
        { id: 'ai-budget-tokens', label: 'Tokens per day' },
        { id: 'ai-budget-cost', label: 'Cost per day' },
      ],
    });
    expect(text(status())).toBe('2 fields need attention: Tokens per day and Cost per day');
    expect(status().classList).toContain('bad');
    expect(text(status().querySelector('a[href="#ai-budget-tokens"]'))).toBe('Tokens per day');
    expect(text(status().querySelector('a[href="#ai-budget-cost"]'))).toBe('Cost per day');
    expect(unavailable()).toBe(true);

    await show({ kind: 'refused', fields: [{ id: 'ai-budget-tokens', label: 'Tokens per day' }] });
    expect(text(status())).toBe('1 field needs attention: Tokens per day');

    // The locale's own commas, each right after its field.
    await show({
      kind: 'refused',
      fields: [
        { id: 'ai-budget-explain', label: 'Explanations per day' },
        { id: 'ai-budget-tokens', label: 'Tokens per day' },
        { id: 'ai-budget-cost', label: 'Cost per day' },
      ],
    });
    expect(text(status())).toBe(
      '3 fields need attention: Explanations per day, Tokens per day, and Cost per day',
    );

    await show({ kind: 'error', text: 'The server could not be reached.' });
    expect(text(status())).toBe('The server could not be reached.');
    expect(status().classList).toContain('bad');
    expect(unavailable()).toBe(false);
  });

  it('takes the reader to a refused field', async () => {
    const { root, status, show } = await render();
    await show({ kind: 'refused', fields: [{ id: 'ai-budget-tokens', label: 'Tokens per day' }] });
    const link = status().querySelector<HTMLAnchorElement>('a[href="#ai-budget-tokens"]')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    // The page's own address stays: the link moves the focus, it does not navigate.
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('#ai-budget-tokens'));
  });

  it('emits save only while there is something to save', async () => {
    const { fixture, save, unavailable, show, host } = await render();
    await show({ kind: 'pending', count: 1 });
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
    await show({ kind: 'clean' });
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
    // A refused field is put right first: saving it as it is would be refused again.
    await show({ kind: 'refused', fields: [{ id: 'ai-budget-tokens', label: 'Tokens per day' }] });
    expect(unavailable()).toBe(true);
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
  });

  it('lets a failed save be tried again, without another edit', async () => {
    const { fixture, save, unavailable, show, host } = await render();
    await show({ kind: 'error', text: 'The server could not be reached.' });
    expect(unavailable()).toBe(false);
    expect(save().classList).toContain('btn-primary');
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
    // While that save is on its way, and once it is saved, there is nothing to save again.
    await show({ kind: 'saving' });
    expect(unavailable()).toBe(true);
    await show({ kind: 'saved', at: new Date('2026-10-26T14:05:00Z') });
    expect(unavailable()).toBe(true);
  });

  it('keeps the focus on Save through its save: nothing to save makes it unavailable, never disabled', async () => {
    const { fixture, save, show, host } = await render();
    await show({ kind: 'pending', count: 1 });
    save().focus();
    expect(document.activeElement).toBe(save());
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
    // A disabled button would drop the focus to the page's body.
    for (const outcome of [
      { kind: 'saving' },
      { kind: 'saved', at: new Date('2026-10-26T14:05:00Z') },
    ] satisfies FootOutcome[]) {
      await show(outcome);
      expect(save().disabled).toBe(false);
      expect(save().getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(save());
      // Pressed again, it saves nothing.
      save().click();
      await fixture.whenStable();
      expect(host.saves()).toBe(1);
    }
    // Tab still reaches it.
    save().blur();
    save().focus();
    expect(document.activeElement).toBe(save());
  });

  it('keeps one live region, rendered while it says nothing new', async () => {
    const { status, show } = await render();
    const region = status();
    expect(region.getAttribute('role')).toBe('status');
    await show({ kind: 'pending', count: 1 });
    await show({ kind: 'saved', at: new Date('2026-10-26T14:05:00Z') });
    expect(status()).toBe(region);
  });
});
