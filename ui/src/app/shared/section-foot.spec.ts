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
    const show = async (outcome: FootOutcome) => {
      fixture.componentInstance.outcome.set(outcome);
      await fixture.whenStable();
    };
    return { fixture, root, status, save, show, host: fixture.componentInstance };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  it('says what is pending, saved or refused in a polite live region beside its Save', async () => {
    const { root, status, save, show } = await render();
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
    expect(save().disabled).toBe(false);
    expect(save().classList).toContain('btn-primary');

    await show({ kind: 'pending', count: 2 });
    expect(text(status())).toBe('2 unsaved changes');

    await show({ kind: 'clean' });
    expect(text(status())).toBe('No unsaved changes');
    expect(status().classList).not.toContain('pending');
    expect(save().disabled).toBe(true);
    expect(save().classList).not.toContain('btn-primary');

    await show({ kind: 'saving' });
    expect(text(status())).toBe('Saving…');
    expect(save().disabled).toBe(true);

    await show({ kind: 'saved', at: new Date('2026-10-26T14:05:00Z') });
    expect(text(status())).toBe('Saved at 2:05 PM UTC.');
    expect(status().classList).toContain('ok');
    expect(status().querySelector('q-icon svg')).not.toBeNull();
    expect(save().disabled).toBe(true);

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
    expect(save().disabled).toBe(true);

    await show({ kind: 'refused', fields: [{ id: 'ai-budget-tokens', label: 'Tokens per day' }] });
    expect(text(status())).toBe('1 field needs attention: Tokens per day');

    await show({ kind: 'error', text: 'The server could not be reached.' });
    expect(text(status())).toBe('The server could not be reached.');
    expect(status().classList).toContain('bad');
    expect(save().disabled).toBe(false);
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
    const { fixture, save, show, host } = await render();
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
    expect(save().disabled).toBe(true);
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
  });

  it('lets a failed save be tried again, without another edit', async () => {
    const { fixture, save, show, host } = await render();
    await show({ kind: 'error', text: 'The server could not be reached.' });
    expect(save().disabled).toBe(false);
    expect(save().classList).toContain('btn-primary');
    save().click();
    await fixture.whenStable();
    expect(host.saves()).toBe(1);
    // While that save is on its way, and once it is saved, there is nothing to save again.
    await show({ kind: 'saving' });
    expect(save().disabled).toBe(true);
    await show({ kind: 'saved', at: new Date('2026-10-26T14:05:00Z') });
    expect(save().disabled).toBe(true);
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
