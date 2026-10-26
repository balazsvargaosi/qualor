import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NumberField } from './number-field';

/** A page's field: its label, the number field, and the hint that describes it. */
@Component({
  imports: [NumberField],
  templateUrl: './number-field.spec.html',
})
class Host {
  readonly label = 'Tokens per day';
  readonly hint = 'Up to 1,000,000,000 a day.';
  readonly value = signal('');
  readonly kind = signal<'whole' | 'money'>('whole');
  readonly unit = signal<string | null>('tokens');
  readonly prefix = signal<string | null>(null);
  readonly digits = signal<3 | 6 | 10>(10);
  readonly invalid = signal(false);
  readonly disabled = signal(false);
}

describe('NumberField', () => {
  async function render(set: (host: Host) => void = () => undefined) {
    const fixture = TestBed.createComponent(Host);
    set(fixture.componentInstance);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input#t')!;
    return { fixture, root, input, host: fixture.componentInstance };
  }

  function type(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }

  it('shows its unit inside the box and names it to screen readers', async () => {
    const { root, input } = await render();
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('numeric');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.labels?.[0]?.textContent).toBe('Tokens per day');
    const unit = root.querySelector('.affix .post')!;
    expect(unit.textContent!.trim()).toBe('tokens');
    expect(unit.id).toBe('t-unit');
    expect(input.getAttribute('aria-describedby')).toBe('hint t-unit');
    expect(root.querySelector('.affix .pre')).toBeNull();
  });

  it('is described by the page alone when it has no unit', async () => {
    const { root, input } = await render((host) => host.unit.set(null));
    expect(root.querySelector('.affix .post')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('hint');
  });

  it('groups a whole number once left, and leaves text it cannot read as typed', async () => {
    const { fixture, input, host } = await render();
    type(input, '2000000');
    await fixture.whenStable();
    // Nothing changes while typing.
    expect(input.value).toBe('2000000');
    expect(host.value()).toBe('2000000');
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.value).toBe('2,000,000');
    expect(host.value()).toBe('2,000,000');

    type(input, '2,00,000');
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.value).toBe('2,00,000');
    expect(host.value()).toBe('2,00,000');
  });

  it('shows the value the page sets', async () => {
    const { fixture, input, host } = await render((h) => h.value.set('300,000'));
    expect(input.value).toBe('300,000');
    host.value.set('1,000');
    await fixture.whenStable();
    expect(input.value).toBe('1,000');
  });

  it('takes money with its prefix and two decimals', async () => {
    const { fixture, root, input, host } = await render((h) => {
      h.kind.set('money');
      h.prefix.set('US$');
      h.unit.set(null);
    });
    expect(input.inputMode).toBe('decimal');
    const prefix = root.querySelector('.affix .pre')!;
    expect(prefix.textContent!.trim()).toBe('US$');
    expect(prefix.id).toBe('t-prefix');
    // The prefix comes before the digits, inside the same box.
    expect(prefix.nextElementSibling).toBe(input);
    type(input, '20');
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.value).toBe('20.00');
    expect(host.value()).toBe('20.00');
  });

  it('sizes the box for the digits it takes, and money for its amounts', async () => {
    const { fixture, root, host } = await render((h) => h.digits.set(3));
    const affix = root.querySelector<HTMLElement>('.affix')!;
    expect(affix.style.getPropertyValue('--w')).toBe('4.5rem');
    host.digits.set(6);
    await fixture.whenStable();
    expect(affix.style.getPropertyValue('--w')).toBe('6.5rem');
    host.digits.set(10);
    await fixture.whenStable();
    expect(affix.style.getPropertyValue('--w')).toBe('8.5rem');
    host.kind.set('money');
    await fixture.whenStable();
    expect(affix.style.getPropertyValue('--w')).toBe('5rem');
  });

  it('marks a refused value', async () => {
    const { fixture, root, input, host } = await render();
    const affix = root.querySelector('.affix')!;
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(affix.classList).not.toContain('invalid');
    host.invalid.set(true);
    await fixture.whenStable();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('.affix.invalid')).not.toBeNull();
  });

  it('is disabled when the page says so', async () => {
    const { root, input } = await render((h) => h.disabled.set(true));
    expect(input.disabled).toBe(true);
    expect(root.querySelector('.affix.disabled')).not.toBeNull();
  });
});
