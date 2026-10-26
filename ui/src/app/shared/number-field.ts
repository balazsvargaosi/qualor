import { Component, computed, inject, input, LOCALE_ID, model } from '@angular/core';
import { inputValue } from './forms';
import { formatMoney, formatWhole, parseMoney, parseWhole } from './numbers';

/** The box's width for the most digits a whole number has (spec §7.4); money takes 5rem. */
const WIDTHS = { 3: '4.5rem', 6: '6.5rem', 10: '8.5rem' } as const;
const MONEY_WIDTH = '5rem';

/**
 * `q-number-field` (spec §7.4): a number as a text field, right-aligned in tabular figures, with
 * its unit inside the box after the digits ("tokens", "seconds") or a currency before them
 * ("US$"). The page owns the label (`for` = `inputId`), the hint or error (`describedBy`) and the
 * check of the value: it parses `value` with `parseWhole` or `parseMoney` when it saves.
 *
 * - Nothing is reformatted while typing. Once the field is left, a value it can read is shown
 *   again grouped as the page's locale writes it ("2,000,000", "20.00"); text it cannot read stays
 *   as typed, for the page's refusal to point at.
 * - A screen reader hears the unit after the page's description (`aria-describedby`).
 */
@Component({
  selector: 'q-number-field',
  templateUrl: './number-field.html',
  styleUrl: './number-field.css',
})
export class NumberField {
  private readonly locale = inject(LOCALE_ID);

  /** The input's id, which the page's `<label for>` names. */
  readonly inputId = input.required<string>();
  /** The text in the field, as typed. */
  readonly value = model.required<string>();
  readonly kind = input<'whole' | 'money'>('whole');
  /** The unit after the digits ("tokens"). */
  readonly unit = input<string | null>(null);
  /** What stands before the digits ("US$"). */
  readonly prefix = input<string | null>(null);
  /** The most digits a whole number takes, which sizes the box. */
  readonly digits = input<3 | 6 | 10>(6);
  /** The page refused the value: the field is marked invalid. */
  readonly invalid = input(false);
  /** The id of the page's hint or error that describes the field, if any. */
  readonly describedBy = input<string | null>(null);
  readonly disabled = input(false);

  protected readonly width = computed(() =>
    this.kind() === 'money' ? MONEY_WIDTH : WIDTHS[this.digits()],
  );
  protected readonly unitId = computed(() => `${this.inputId()}-unit`);
  protected readonly prefixId = computed(() => `${this.inputId()}-prefix`);
  /** The page's description first, then the unit. */
  protected readonly describedByIds = computed(() => {
    const ids = [this.describedBy(), this.unit() ? this.unitId() : null].filter((id) => !!id);
    return ids.length > 0 ? ids.join(' ') : null;
  });

  protected onInput(event: Event): void {
    this.value.set(inputValue(event));
  }

  /** The field was left: a value it can read is shown again as the locale writes it. */
  protected onBlur(): void {
    const text = this.value();
    if (this.kind() === 'money') {
      const amount = parseMoney(text, Number.MAX_SAFE_INTEGER);
      if (amount !== null) this.value.set(formatMoney(amount, this.locale));
    } else {
      const whole = parseWhole(text, 0, Number.MAX_SAFE_INTEGER);
      if (whole !== null) this.value.set(formatWhole(whole, this.locale));
    }
  }
}
