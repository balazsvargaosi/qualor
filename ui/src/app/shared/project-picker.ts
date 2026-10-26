import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, ok } from '../api/api';
import { problemMessage } from '../api/errors';
import type { ItemOf } from '../api/types';
import { inputValue, isChecked } from './forms';
import { Icon } from './icon';
import { SEARCH_DELAY_MS } from './user-picker';

type Project = ItemOf<'/api/v0/projects'>;

/** A project the picker adds: what a list of chosen projects shows of it. */
export interface PickedProject {
  id: string;
  name: string;
  key: string;
}

/** The most projects one answer lists; typing narrows the rest (never the whole organisation). */
const LIMIT = 20;
/** `GET /projects` takes a search of at most 255 characters. */
const QUERY_MAX_LENGTH = 255;

type State = 'idle' | 'loading' | 'results' | 'empty' | 'error';

/** Numbers each picker, so the ids of two pickers on one page never meet. */
let pickers = 0;

/**
 * `q-project-picker` (spec §7.4, §7.11): "Add projects" for a list of chosen projects of one
 * organisation. Its button opens a panel in place under it (a popover would be clipped inside a
 * table or a scroll box): a search, the matching projects as checkboxes, then Cancel and Add.
 *
 * - Opening lists the organisation's first 20 projects; typing asks the server again
 *   (`GET /projects?organizationId=…&q=…&limit=20`) once it has paused for 250 ms. Only the answer
 *   to the latest request is shown.
 * - A project already chosen is ticked and disabled ("Already in the list"); one the page cannot
 *   take (`unavailable` gives its reason) is disabled with the reason as text.
 * - Add emits the ticked projects, in the order they were ticked. Add, Cancel and Escape close the
 *   panel and give the focus back to the button; it opens afresh each time.
 */
@Component({
  selector: 'q-project-picker',
  imports: [Icon],
  templateUrl: './project-picker.html',
  styleUrl: './project-picker.css',
  host: { '(keydown.escape)': 'escape($event)' },
})
export class ProjectPicker {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);

  readonly organizationId = input.required<string>();
  readonly buttonLabel = input.required<string>();
  /** The ids already in the page's list. */
  readonly chosen = input.required<readonly string[]>();
  /** Why the page cannot take a project, or null when it can. */
  readonly unavailable = input<(p: Project) => string | null>(() => null);
  readonly add = output<PickedProject[]>();

  private readonly uid = `project-picker-${++pickers}`;
  protected readonly buttonId = `${this.uid}-button`;
  protected readonly panelId = `${this.uid}-panel`;
  protected readonly searchId = `${this.uid}-search`;
  protected readonly queryMaxLength = QUERY_MAX_LENGTH;

  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly state = signal<State>('idle');
  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly errorText = signal('');
  /** The projects ticked so far, by id, in the order they were ticked. */
  protected readonly ticked = signal<ReadonlyMap<string, PickedProject>>(new Map());

  protected readonly options = computed(() => {
    const chosen = new Set(this.chosen());
    const unavailable = this.unavailable();
    const ticked = this.ticked();
    return this.projects().map((project) => {
      const listed = chosen.has(project.id);
      const reason = listed ? null : unavailable(project);
      return {
        project,
        listed,
        reason,
        disabled: listed || reason !== null,
        checked: listed || ticked.has(project.id),
      };
    });
  });

  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts requests (and cancellations): only the latest request's answer is shown. */
  private generation = 0;

  constructor() {
    // Another organisation: what was listed and ticked belongs to the previous one.
    effect(() => {
      this.organizationId();
      untracked(() => this.close(false));
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  protected onInput(event: Event): void {
    const text = inputValue(event);
    this.query.set(text);
    this.cancel();
    this.state.set('loading');
    this.timer = setTimeout(() => void this.fetch(text.trim()), SEARCH_DELAY_MS);
  }

  protected tick(project: Project, event: Event): void {
    const ticked = new Map(this.ticked());
    if (isChecked(event)) ticked.set(project.id, pickedOf(project));
    else ticked.delete(project.id);
    this.ticked.set(ticked);
  }

  protected addTicked(): void {
    const picked = [...this.ticked().values()];
    if (picked.length === 0) return;
    this.close();
    this.add.emit(picked);
  }

  /** Escape closes the open panel, and only it: a dialog around the picker stays open. */
  protected escape(event: Event): void {
    if (!this.open() || (event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  /** Closes the panel, forgetting the search and the ticks; `refocus` gives the button the focus. */
  protected close(refocus = true): void {
    if (!this.open()) return;
    this.cancel();
    this.open.set(false);
    this.query.set('');
    this.ticked.set(new Map());
    this.projects.set([]);
    this.errorText.set('');
    this.state.set('idle');
    if (refocus) this.button().nativeElement.focus();
  }

  private show(): void {
    this.open.set(true);
    void this.fetch('');
    afterNextRender(() => this.search().nativeElement.focus(), { injector: this.injector });
  }

  private async fetch(q: string): Promise<void> {
    this.cancel();
    const generation = this.generation;
    this.state.set('loading');
    try {
      const answer = await ok(
        this.api.client.GET('/api/v0/projects', {
          params: {
            query: { organizationId: this.organizationId(), limit: LIMIT, ...(q ? { q } : {}) },
          },
        }),
      );
      if (generation !== this.generation) return;
      this.projects.set(answer.items);
      this.errorText.set('');
      this.state.set(answer.items.length > 0 ? 'results' : 'empty');
    } catch (err) {
      if (generation !== this.generation) return;
      this.projects.set([]);
      this.errorText.set(problemMessage(err));
      this.state.set('error');
    }
  }

  /** Forgets the pending search and any answer still on its way. */
  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
  }
}

function pickedOf(project: Project): PickedProject {
  return { id: project.id, name: project.name, key: project.key };
}
