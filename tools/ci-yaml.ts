import { parse, type Tags } from 'yaml';

/** GitLab's `!reference [job, key]` tag, kept as { reference: [...] } so it can be asserted on. */
const GITLAB_TAGS: Tags = [
  {
    tag: '!reference',
    collection: 'seq',
    default: false,
    resolve: (seq) => ({ reference: seq.toJSON() as unknown }),
  },
];

/**
 * A CI file, GitLab's or GitHub's, parsed with GitLab's own `!reference` tag. Plain YAML does not
 * know the tag, and the parser warns about each use of it in .gitlab-ci.yml.
 */
export function parseCiYaml(src: string): unknown {
  return parse(src, { customTags: GITLAB_TAGS });
}
