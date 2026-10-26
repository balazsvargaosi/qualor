import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { Icon } from './icon';

/** Where a missing setting is changed: the settings page that holds it. */
export type RequirementPlace = 'ai-provider' | 'org-ai' | 'repositories' | 'gitlab' | 'github';

/**
 * A place's page and its name as the navigation shows it. `opens` says whether the viewer can
 * open the page: instance admins the AI provider, organisation admins (by permission) the rest.
 */
interface Place {
  route: string;
  label: () => string;
  opens: (session: SessionStore, org: OrgContext) => boolean;
}

const PLACES: Record<RequirementPlace, Place> = {
  'ai-provider': {
    route: '/settings/ai',
    label: () => $localize`:@@requirement.aiProvider:Settings → AI provider`,
    opens: (session) => session.user()?.isInstanceAdmin === true,
  },
  'org-ai': {
    route: '/settings/ai-review',
    label: () => $localize`:@@requirement.orgAi:Settings → AI`,
    opens: (_, org) => org.can('org.ai.manage'),
  },
  repositories: {
    route: '/settings/repositories',
    label: () => $localize`:@@requirement.repositories:Settings → Repositories`,
    opens: (_, org) => org.can('org.scm.manage'),
  },
  gitlab: {
    route: '/settings/gitlab',
    label: () => $localize`:@@requirement.gitlab:Settings → GitLab`,
    opens: (_, org) => org.can('org.scm.manage'),
  },
  github: {
    route: '/settings/github',
    label: () => $localize`:@@requirement.github:Settings → GitHub`,
    opens: (_, org) => org.can('org.scm.manage'),
  },
};

/** A place as a viewer sees it: its page, its name, and whether it is a link for them. */
export interface PlaceView {
  route: string;
  label: string;
  link: boolean;
}

/** A place for the viewer: a link when they can open its page, else its name only. */
export function placeView(
  name: RequirementPlace,
  session: SessionStore,
  org: OrgContext,
): PlaceView {
  const place = PLACES[name];
  return { route: place.route, label: place.label(), link: place.opens(session, org) };
}

/**
 * `q-requirement` (spec §3.3, §7.5): why a control cannot work, in one sentence, directly above
 * the control it disables, which points at the note (`aria-describedby` = `noteId`). `text` names
 * what is missing and who changes it, and ends where the place goes: "Needs Suggest a fix for
 * Acme, which an instance admin turns on in" + " Settings → AI provider." The place is a link for
 * a viewer who can open it, else its name only. Without a place, `text` is the whole sentence.
 */
@Component({
  selector: 'q-requirement',
  imports: [Icon, RouterLink],
  templateUrl: './requirement.html',
  styleUrl: './requirement.css',
})
export class Requirement {
  private readonly session = inject(SessionStore);
  private readonly org = inject(OrgContext);

  readonly noteId = input.required<string>();
  readonly text = input.required<string>();
  readonly place = input<RequirementPlace | null>(null);

  protected readonly where = computed(() => {
    const name = this.place();
    return name === null ? null : placeView(name, this.session, this.org);
  });
}
