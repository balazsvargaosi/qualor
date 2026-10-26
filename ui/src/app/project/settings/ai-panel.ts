import {
  Component,
  computed,
  inject,
  input,
  LOCALE_ID,
  linkedSignal,
  output,
  resource,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../../api/api';
import { ApiError, problemMessage } from '../../api/errors';
import { SessionStore } from '../../auth/session';
import { OrgContext } from '../../org/org-context';
import type { OrgAi } from '../../settings/ai-review';
import { autoFixNotLicensed } from '../../settings/auto-fix';
import { isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import type { IconName } from '../../shared/icons';
import {
  type PlaceView,
  placeView,
  Requirement,
  type RequirementPlace,
} from '../../shared/requirement';
import { type StatusTone, TONE_CHIPS } from '../../shared/status-list';
import type { ProjectDto } from '../current-project';

type Feature = keyof OrgAi['features'];

const FEATURES: readonly Feature[] = ['explain', 'triage', 'fix'];
/** The switch's help, and the requirement that stands above it while the project is not linked. */
const FIX_HELP = 'project-ai-fix-help';
const FIX_NOT_LINKED = 'project-ai-fix-not-linked';

/** A line's state chip (an icon and a word), then one sentence; with a place, it ends there. */
interface StateLine {
  badge: string;
  icon: IconName;
  state: string;
  text: string | null;
  where: PlaceView | null;
}

/**
 * `q-project-ai-panel` (spec §3.6): Project → Settings → AI, for `project.settings`. It says what
 * AI does for the project, line by line, and why not, with who changes it and where (a link for a
 * viewer who can open the place):
 *
 * - **AI review**: whether the project's merge requests are reviewed, else the first reason they
 *   are not (`aiReview.reason`). The organisation's admins choose the projects; nothing here
 *   changes that.
 * - **Assistant**: the features on for the project's issues, from the organisation's assistant
 *   (`GET /organizations/{id}/ai`, read once per organisation).
 * - **Fixes** (Enterprise, `autoFix.available`): the switch that opts the project out of the
 *   organisation's automatic fix suggestions, or back in. It saves at once; a refusal flips it
 *   back and says why. `saved` tells the page to read the project again.
 *
 * A project an instance admin excluded from AI says so on every line, whatever the organisation
 * has on: nothing of it is sent.
 */
@Component({
  selector: 'q-project-ai-panel',
  imports: [Icon, Requirement, RouterLink],
  templateUrl: './ai-panel.html',
  styleUrl: './ai-panel.css',
})
export class ProjectAiPanel {
  private readonly api = inject(Api);
  private readonly session = inject(SessionStore);
  private readonly org = inject(OrgContext);
  private readonly locale = inject(LOCALE_ID);

  readonly project = input.required<ProjectDto>();
  /** The fix suggestions switch was saved: the project changed. */
  readonly saved = output();

  protected readonly texts = {
    title: $localize`:@@project.settings.ai:AI`,
    review: $localize`:@@projectAi.review:AI review`,
    assistant: $localize`:@@projectAi.assistant:Assistant`,
    fixes: $localize`:@@projectAi.fixes:Fixes`,
    excluded: $localize`:@@projectAi.state.excluded:Excluded from AI`,
    notMapped: $localize`:@@projectAi.reason.notMapped:This project is not linked to a GitLab or GitHub repository, where reviews are posted. An organization admin links it in`,
    fixNotLinked: $localize`:@@projectAi.fix.notLinked:Fix suggestions are posted on merge requests, so they wait until the project is linked to its repository.`,
    saved: $localize`:@@projectAi.fix.saved:Saved.`,
  };
  private readonly states = {
    reviewed: $localize`:@@projectAi.state.reviewed:Reviewed`,
    notReviewed: $localize`:@@projectAi.state.notReviewed:Not reviewed`,
    paused: $localize`:@@projectAi.state.paused:Paused`,
    off: $localize`:@@projectAi.state.off:Off`,
    available: $localize`:@@projectAi.state.available:Available`,
    notAvailable: $localize`:@@projectAi.state.notAvailable:Not available`,
  };
  private readonly featureNames: Record<Feature, string> = {
    explain: $localize`:@@orgAi.feature.explain:Explain`,
    triage: $localize`:@@orgAi.feature.triage:Suggest triage`,
    fix: $localize`:@@orgAi.feature.fix:Suggest a fix`,
  };
  protected readonly fixHelpId = FIX_HELP;
  protected readonly fixNotLinkedId = FIX_NOT_LINKED;

  private readonly projectId = computed(() => this.project().id);
  /** A string: the project read again in the same organisation asks nothing again. */
  private readonly organizationId = computed(() => this.project().organizationId);
  /** An instance admin excluded the project from AI: every line says so. */
  protected readonly excluded = computed(() => this.project().autoFix.excludedFromAi);
  private readonly reason = computed(() => this.project().aiReview.reason);

  /** The organisation's assistant, read once per organisation. */
  private readonly assistant = resource({
    params: () => this.organizationId(),
    loader: ({ params: id }) =>
      ok(this.api.client.GET('/api/v0/organizations/{id}/ai', { params: { path: { id } } })),
  });
  private readonly orgAi = computed(() =>
    this.assistant.hasValue() ? this.assistant.value() : null,
  );
  protected readonly assistantError = computed(() => {
    const error = this.assistant.error();
    return error ? problemMessage(error) : null;
  });

  /** The project's organisation by name: the session's memberships, else the organisations listed. */
  private readonly orgName = computed(() => {
    const id = this.organizationId();
    return (
      this.session.me()?.memberships.find((m) => m.organizationId === id)?.organizationName ??
      this.org.orgs().find((o) => o.id === id)?.name ??
      $localize`:@@projectAi.orgFallback:The organization`
    );
  });
  protected readonly reviewWho = computed(
    () =>
      $localize`:@@projectAi.review.who:${this.orgName()}:org:'s organization admins choose the projects.`,
  );

  /** The AI review line, in the order the server checks why a project is not reviewed. */
  protected readonly reviewLine = computed<StateLine>(() => {
    if (this.excluded()) {
      return this.line(
        'off',
        this.states.off,
        $localize`:@@projectAi.reason.excluded:An instance admin excluded this project from AI, so nothing of it is sent.`,
      );
    }
    const org = this.orgName();
    switch (this.reason()) {
      case null: {
        const host = this.orgAi()?.provider?.host;
        return this.line(
          'ok',
          this.states.reviewed,
          host === undefined
            ? null
            : $localize`:@@projectAi.reason.reviewed:Reviews this project's merge requests, with ${host}:host:.`,
        );
      }
      case 'not_mapped':
        return this.line(
          'attention',
          this.states.notReviewed,
          $localize`:@@projectAi.reason.notMappedLine:Selected, but not reviewed.`,
        );
      case 'project_not_selected':
        return this.line(
          'off',
          this.states.off,
          $localize`:@@projectAi.reason.notSelected:${org}:org: reviews selected projects only, and this is not one of them. An organization admin adds it in`,
          'org-ai',
        );
      case 'consent_outdated':
        return this.line(
          'attention',
          this.states.paused,
          $localize`:@@projectAi.reason.paused:Paused until an organization admin confirms the new AI provider in`,
          'org-ai',
        );
      case 'review_disabled':
        return this.line(
          'off',
          this.states.off,
          $localize`:@@projectAi.reason.reviewOff:${org}:org: has not switched on AI review. An organization admin switches it on in`,
          'org-ai',
        );
      case 'organization_disabled':
        return this.line(
          'off',
          this.states.off,
          $localize`:@@projectAi.reason.orgOff:${org}:org: may not use AI. An instance admin allows it in`,
          'ai-provider',
        );
      case 'no_provider':
        return this.line(
          'off',
          this.states.off,
          $localize`:@@projectAi.reason.noProvider:AI isn't set up on this server. An instance admin connects a provider in`,
          'ai-provider',
        );
    }
  });
  /** Reviewed: the CI must scan merge requests with the full history. */
  protected readonly reviewed = computed(() => !this.excluded() && this.reason() === null);
  /** Selected, but not linked to a repository: who links it, and where. */
  protected readonly notMapped = computed(() => !this.excluded() && this.reason() === 'not_mapped');

  /** The Assistant line: the features on, else the first reason none is; null until it is read. */
  protected readonly assistantLine = computed<StateLine | null>(() => {
    const notAvailable = this.states.notAvailable;
    if (this.excluded()) {
      return this.line(
        'off',
        notAvailable,
        $localize`:@@projectAi.assistant.excluded:For the same reason: its issues are never sent.`,
      );
    }
    const assistant = this.orgAi();
    if (assistant === null) return null;
    // No provider, or an organisation that may not use AI, is the AI review line's reason too
    // (the server checks them first): that line already says who changes it, and where.
    if (assistant.provider === null || !assistant.enabled) {
      return this.line(
        'off',
        notAvailable,
        $localize`:@@projectAi.assistant.sameReason:For the same reason.`,
      );
    }
    const org = this.orgName();
    const on = FEATURES.filter((f) => assistant.features[f]).map((f) => this.featureNames[f]);
    if (on.length === 0) {
      return this.line(
        'off',
        notAvailable,
        $localize`:@@projectAi.assistant.none:${org}:org: has none of Explain, Suggest triage and Suggest a fix on.`,
      );
    }
    const features = new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(on);
    return this.line(
      'ok',
      this.states.available,
      $localize`:@@projectAi.assistant.on:${features}:features: on this project's issues.`,
    );
  });

  /**
   * The Fixes line, shown with the Enterprise feature only: the excluded state, the organisation
   * having them off (no switch), or the switch.
   */
  protected readonly fixes = computed<'excluded' | 'organizationOff' | 'switch' | null>(() => {
    const autoFix = this.project().autoFix;
    if (!autoFix.available) return null;
    if (autoFix.excludedFromAi) return 'excluded';
    return autoFix.organizationEnabled ? 'switch' : 'organizationOff';
  });
  protected readonly fixesExcludedLine = computed(() =>
    this.line(
      'off',
      this.states.off,
      $localize`:@@projectAi.fix.excluded:Not for a project excluded from AI.`,
    ),
  );
  protected readonly fixOrganizationOff = computed(
    () =>
      $localize`:@@projectAi.fix.orgOff:${this.orgName()}:org: has automatic fix suggestions off. An organization admin switches them on in`,
  );
  /** Not linked to a repository: the suggestions wait for it, and the switch still works. */
  protected readonly notLinked = computed(() => this.project().scmConnectionId === null);
  protected readonly fixHelp = computed(
    () =>
      $localize`:@@projectAi.fix.help:${this.orgName()}:org: posts them for new findings, as its organization admins set. Switch it off to keep them for a person to ask for.`,
  );
  /** The switch is read with its help, then what it waits for. */
  protected readonly fixDescribedBy = computed(() =>
    this.notLinked() ? `${FIX_HELP} ${FIX_NOT_LINKED}` : FIX_HELP,
  );

  /** The saved choice: a primitive, so reading the project again unchanged keeps the switch. */
  private readonly stored = computed(() => this.project().autoFix.enabled);
  protected readonly fixOn = linkedSignal(() => this.stored());
  protected readonly busy = signal(false);
  /** The last save's outcome, under the switch's help; another project starts without one. */
  protected readonly fixSaved = linkedSignal({ source: this.projectId, computation: () => false });
  protected readonly fixError = linkedSignal<string, string | null>({
    source: this.projectId,
    computation: () => null,
  });

  /**
   * The switch moved: saved at once. While a save is on its way, it stays as it is. The box is set
   * by hand when it goes back: a refusal may come before the moved state was ever rendered, and
   * the binding would then see no change to write.
   */
  protected async setFix(event: Event): Promise<void> {
    const box = event.target instanceof HTMLInputElement ? event.target : null;
    if (this.busy()) {
      if (box) box.checked = this.fixOn();
      return;
    }
    const enabled = isChecked(event);
    const id = this.projectId();
    this.fixOn.set(enabled);
    this.fixSaved.set(false);
    this.fixError.set(null);
    this.busy.set(true);
    try {
      await ok(
        this.api.client.PUT('/api/v0/projects/{id}/ai/auto-fix', {
          params: { path: { id } },
          body: { enabled },
        }),
      );
      if (id !== this.projectId()) return;
      this.fixSaved.set(true);
      this.saved.emit();
    } catch (err) {
      if (id !== this.projectId()) return;
      this.fixOn.set(!enabled);
      if (box) box.checked = !enabled;
      this.fixError.set(fixRefusal(err));
    } finally {
      this.busy.set(false);
    }
  }

  private line(
    tone: StatusTone,
    state: string,
    text: string | null,
    place: RequirementPlace | null = null,
  ): StateLine {
    const chip = TONE_CHIPS[tone];
    return {
      badge: chip.badge,
      icon: chip.icon,
      state,
      text,
      where: place === null ? null : placeView(place, this.session, this.org),
    };
  }
}

/** Why the switch was refused, in the words the project's settings have always used. */
function fixRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === 'AUTO_FIX_OPT_OUT_LIMIT_REACHED') {
    return $localize`:@@autoFix.project.limit:This organisation already has 1 000 projects opted out. Switch one back on first.`;
  }
  if (err instanceof ApiError && err.code === 'FEATURE_NOT_LICENSED') return autoFixNotLicensed();
  return problemMessage(err);
}
