import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Meter } from '../charts/meter';
import { Icon } from './icon';
import type { IconName } from './icons';

/** What a line says about its thing (spec §7.8): works, off, set up but stopped, or broken. */
export type StatusTone = 'ok' | 'off' | 'attention' | 'broken';

/** A use against its budget, drawn as `q-meter`; a note replaces the budget's own notes. */
export interface StatusMeter {
  label: string;
  value: number;
  max: number | null;
  unit?: 'count' | 'usd';
  note?: string | null;
}

/**
 * A line's one action: a link (`link`, with an optional `fragment`) or a button that emits `id`.
 * `ariaLabel` names its object when the visible words do not ("Open" → "Open Acme's AI page").
 */
export interface StatusAction {
  id: string;
  label: string;
  primary?: boolean;
  link?: string | null;
  fragment?: string | null;
  ariaLabel?: string;
}

/**
 * One line of a page's Status card: its label, its state as a chip (an icon and a word), one
 * sentence, a muted sub, tags, meters and at most one action. A line of meters only (Today) has
 * no state: its `state` is empty, and it draws no chip.
 */
export interface StatusLine {
  key: string;
  label: string;
  tone: StatusTone;
  state: string;
  text?: string | null;
  sub?: string | null;
  tags?: readonly string[];
  meters?: readonly StatusMeter[];
  action?: StatusAction | null;
}

const TONES: Record<StatusTone, { badge: string; icon: IconName }> = {
  ok: { badge: 'badge-passed', icon: 'check' },
  off: { badge: 'badge-none', icon: 'minus' },
  attention: { badge: 'badge-warn', icon: 'alert' },
  broken: { badge: 'badge-failed', icon: 'cross' },
};

/**
 * `q-status-list` (spec §3.3, §7.2): the Status card a settings page opens with, computed by the
 * page from what is saved, never from an unsaved form. Each state is an icon and a word, never
 * colour alone. A button action emits its id through `act`; a link action navigates.
 */
@Component({
  selector: 'q-status-list',
  imports: [Icon, Meter, RouterLink],
  templateUrl: './status-list.html',
  styleUrl: './status-list.css',
})
export class StatusList {
  readonly lines = input.required<readonly StatusLine[]>();
  /** The id of the button action that was pressed. */
  readonly act = output<string>();

  protected readonly rows = computed(() =>
    this.lines().map((line) => ({ line, chip: TONES[line.tone] })),
  );
}
