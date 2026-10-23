# AI review

**This page is written in parts, and this is the first.** It covers what you set up and what
leaves your CI job and your server: who switches AI review on, the warning they confirm, the
**repository snapshot** the scanner uploads for each merge request, how secrets are masked in it,
how long the server keeps it, the budgets, the two server variables, and what your CI needs. **The
review itself** (what it looks for, where it posts its findings and how it answers replies) arrives
with the next part of this page. Until it does, switching AI review on uploads and stores the
snapshot, and nothing reads it yet.

AI review is meant to read a merge request or pull request the way a careful colleague would, on a
model you choose. It is part of the free community edition and **off by default**. It will use the
provider that an instance admin configured for the [AI assistant](./ai-assistant.md): a hosted
provider with your own key, or a local model on your own network.

## How it works

1. An **organisation admin** switches AI review on in **Settings → AI review**, confirms a warning
   that names the model's provider, and chooses the projects.
2. Your CI scans a merge request as usual. When AI review is on for the project, the scanner then
   uploads a **snapshot**: a copy of the repository as it is at the merge request's last commit,
   with the merge request's changes, and with secrets masked.
3. The server stores the snapshot, unpacks it, and keeps it for 14 days at most.
4. The review (next part of this page) will read the change and the repository from the snapshot
   with your model.

Only merge request scans send a snapshot. A scan of the main branch or of any other branch never
does, and neither does a project that AI review is not switched on for.

## Switch it on

### What has to be in place

- An **instance admin** has configured a model provider and enabled the organisation in
  **Settings → AI assistant** ([Configuration](./ai-assistant.md#configuration)). AI review uses
  the same provider and model. The AI assistant's three features (Explain, Suggest triage, Suggest a
  fix) do not have to be on. Without a provider, **Settings → AI review** says so and its form stays
  disabled.
- The project is mapped to its repository on GitLab or GitHub ([GitLab](./gitlab.md),
  [GitHub](./github.md)), because the review will be posted there.
- Your CI scans **merge requests** and has the full history ([What your CI needs](#what-your-ci-needs)).

### In Qualor

Organisation admins (the Organization admin role, permission `org.ai.manage`; instance admins hold
every permission) open **Settings → AI review** with the organisation chosen in the header:

1. Check **Review merge requests with AI**. A box opens with the warning below. Its button reads
   **Switch on and send code to** followed by your provider's host: press it to confirm, or press
   **Cancel** to leave AI review off.
2. Under **Projects to review**, choose **All projects** or **Selected projects** and tick the
   projects. The default is **Selected projects** with none ticked, so nothing is reviewed until you
   choose. A project that the instance admin excluded from the AI assistant is never reviewed,
   whatever you choose here.
3. Set the [budgets](#budgets-and-the-instance-ceiling) if the defaults do not suit you.
4. Press **Save**.

A project's settings (**Project → Settings → AI review**) show whether AI review is on for that
project. The panel only shows the state; the organisation admin changes it.

To switch AI review off, uncheck the box and save. No confirmation is needed. Snapshots that are
already stored stay until they expire ([How long the server keeps it](#how-long-the-server-keeps-it)).

### The warning

Whoever switches AI review on sees this text, and the API repeats it:

> AI review sends the merge request's diff and any repository file the model chooses to read to
> `<host>` (`<model>`). The scanner uploads a copy of the repository to this Qualor server for each
> merge request; Qualor keeps it until the merge request is closed (at most `<days>` days). Secrets
> the analyzers found are masked; credentials files are never sent.

`<host>` is the provider's address (with its port, such as `ollama:11434`), `<model>` its model, and
`<days>` the most days the server keeps a snapshot (14). Take it at its word: when the review runs,
the code of the projects you choose goes to that provider, so choose them with that in mind. No
masking finds every secret ([How secrets are masked](#how-secrets-are-masked)).

Qualor records who confirmed the warning, when, and for which provider, and the audit log (with
`audit-log`) records each change of these settings as `organization.ai_review_changed`
([Roles and the audit log](./roles-and-audit.md#what-is-recorded)).

**A confirmation belongs to one provider.** It names the provider's address, host and model. When
the instance admin changes any of them, the confirmation no longer covers the new provider:
AI review stops, and **Settings → AI review** shows "The AI provider changed; confirm again to keep
reviewing." with a **Confirm again** button that opens the new warning. A warning given for one
address never covers another. If the provider changes while you are looking at the box, saving is
refused and the box opens again with the new warning.

## What the scanner uploads

The snapshot is read from git, from the merge request's **last commit** (its head), not from the
working directory of the job. Files your CI generated or changed after the checkout are not in it.
It holds:

- **The text files of the repository** at that commit: up to 50 000 files of up to 1 MiB each.
- **The merge request's changes**: for every changed file, what happened to it (added, modified,
  renamed, deleted) and its diff against the point where the branch left the target branch (and,
  once there are reviews, which lines changed since the last one). A diff over 256 KiB is not sent.
- **The rules files `AGENTS.md`, `CLAUDE.md` and `REVIEW.md`** of the repository's root, when it
  has them (up to 64 KiB each), as they were where the merge request branched off the target
  branch, not as the merge request edits them, so a merge request cannot rewrite the rules it is
  judged by.
- **The merge request's title and description**, cut to 255 and 12 000 characters. GitLab passes
  only the first 2 700 characters of a description to the job.

**Left out, never sent** (the snapshot notes which files were left out, and why):

- files that the built-in excludes or your `sources.exclude` match (`node_modules`, `dist`, `build`,
  `vendor`, minified files and the rest of [Built-in excludes](./configuration.md#built-in-excludes)).
  To keep a file out of AI review, list it in `sources.exclude`. The AI assistant's **Never send
  these paths** list is a server setting that the scanner does not read;
- **credentials files**: the files the AI assistant never sends either, such as `.env` files, keys
  and certificates, `id_rsa`, `credentials*`, `.npmrc`, Docker and Kubernetes configs and Terraform
  variables and state ([What is sent, and where](./ai-assistant.md#what-is-sent-and-where)). A file
  renamed from one is left out too, and the diff of a credentials file is not sent;
- **binary files**, files that are not UTF-8, and files over 1 MiB (counted after masking);
- symbolic links and submodules;
- the scan's own Gitleaks configuration at the scan root: `.gitleaks.toml` and the other
  `.gitleaks.*` files, and `.gitleaksignore`. A merge request that edits one shows only that it
  changed, never its text or its diff;
- a path that cannot be stored safely: longer than 1 024 bytes, with a control character, a
  backslash, an empty segment (`//`) or a `.` or `..` segment in it, starting with `/`, not valid
  UTF-8, or holding a secret. The scan log counts them, never names them.

The snapshot is sent compressed. When it is over the server's limits ([below](#size-limits-and-the-two-server-variables)),
the scanner sends the changed files first and then the rest of the repository by nearness to the
changes (the same directory first), and marks the snapshot **partial**. If the changed files and
their diffs alone are over the limits, no snapshot is sent.

## How secrets are masked

Every text in the snapshot (files, diffs, the rules files, the title and the description) is
masked before it leaves the CI job:

1. **Secrets the scan found.** Whatever Gitleaks found in this scan, and the secret findings of
   OpenGrep or Semgrep and of [Qualor's own rules](./languages-and-analyzers.md), is replaced with
   `«redacted»` everywhere it appears, including a secret spread over several lines (each line of it
   in a diff too) and a private key block in full. The CI job's Qualor token is masked as well.
2. **Built-in patterns.** The same patterns the AI assistant uses ([What is sent, and
   where](./ai-assistant.md#what-is-sent-and-where)): private keys, cloud and SCM tokens, API keys,
   JSON Web Tokens, passwords in URLs, `Authorization` headers, and values assigned to names such as
   `password`, `secret`, `token` or `api_key`. These catch what no analyzer found, and they mask
   some ordinary text that only looks like a secret.
3. **Lines the merge request removed.** The scan reads the checkout, but a diff also shows the
   lines the merge request removed, and the rules files come from the target branch. So the scanner
   runs Gitleaks, with your configuration, over those older versions as well and masks what it
   finds. If it cannot (Gitleaks is switched off, or it cannot run over them as it ran in the scan),
   the removed lines are **not sent**: each run of them becomes one line such as
   `-[3 removed lines not sent]`, and the rules files are masked with the built-in patterns only.
4. **Files the scan did not see as they are.** In a GitLab merged-result pipeline and in GitHub's
   default pull request checkout, the job checks out a merge commit, not the merge request's last
   commit, and a CI step can edit files too. The scanner finds the files where the checkout differs
   from the last commit and runs Gitleaks over the last commit's versions of them.

No masking is complete: a secret that no analyzer found and that matches none of the patterns can
still be sent. Gitleaks accepts your own rules (`analyzers.gitleaks.configFile` in `qualor.yml`),
which both the scan and the snapshot use, so add rules for secret formats of your own.

### When the secret scan stops the snapshot

The secret scan is what masks your secrets, so the scanner sends no snapshot when it cannot trust
it. In the scan log you see `AI review: no snapshot sent, …` and the reason:

- **A secret scan that is switched on did not complete.** Gitleaks is on by default
  (`enabled: true`) and a failure of it ends the scan with exit code 3, which sends no snapshot.
  With `enabled: auto`, a Gitleaks that failed, timed out, is not installed, or was skipped because
  the `configFile` it was given does not exist or is not a regular file stops the snapshot too: it
  scanned nothing. The same holds for OpenGrep or Semgrep (`analyzers.semgrep`) and for Qualor's
  rules (`analyzers.qualor`), whose findings mask secrets as well, with one exception: an engine
  that had **nothing to run** does not hold the snapshot up. That is Semgrep on its defaults
  (`configs: [qualor-default]`; the scanner image ships no rule files, so it runs nothing), and
  Qualor's rules without their pack or without a file in their languages. Qualor's rules that
  have a pack and cannot run (OpenGrep is missing, the pack is damaged, the run failed, or
  `QUALOR_RULES_DIR` is wrong: a directory that does not exist, a relative path, or one inside the
  checkout) do hold it up: fix them, or set `analyzers.qualor.enabled: false`.
- **Rule files you named never ran.** Once `analyzers.semgrep.configs` names a file or directory
  of your own, a Semgrep that did not run holds the snapshot up: a path that does not exist or has
  a typo, `qualor-default` next to your file on a runner without the image's rules directory (the
  skip then drops your file too), neither OpenGrep nor Semgrep installed, or a run that failed.
  Fix the path or the tool, or switch Semgrep off with `analyzers.semgrep.enabled: false`.
- **The secret scan's output could not be read.**
- **The files that differ from the checkout could not be scanned** (item 4 above).

If you **switch Gitleaks off** on purpose (`analyzers.gitleaks.enabled: false` in `qualor.yml`),
the snapshot is still sent. Then the built-in patterns mask it, with any secrets that OpenGrep or
Qualor's rules reported in this scan if they ran (on their defaults they report none), and removed
lines are not sent. The scan log says "AI review: the secret scan is off in qualor.yml; only
built-in patterns mask secrets in the snapshot", which does not count those two engines' findings.
Switch Gitleaks off only for code you are content to send.

## How long the server keeps it

- The upload is stored as it was sent. A job on the server then unpacks it into one record per file,
  which takes seconds.
- A merge request keeps the snapshot of its **newest analysis** only: when the merge request's
  next analysis has been processed, the server deletes the older snapshots of that merge request.
- A daily job deletes every snapshot that is **more than 14 days old**, whatever its state. A
  snapshot the server refused (a damaged upload) is deleted after one day.
- The warning also says the snapshot is kept "until the merge request is closed". Deleting a
  snapshot the moment its merge request is merged or closed arrives with the review itself. Until
  then the rules above bound it.

The snapshot lives in Qualor's database, like the reports and the code snippets of issues. Qualor
does not encrypt it, and no page or API of Qualor shows it. Treat the database and its
[backups](./install-server.md#backups) as you treat the code.

Allow for its size. The copies take about the text of the repository, which PostgreSQL compresses,
for each open merge request with a recent push, plus the copies of failed or stale analyses until
the next successful analysis on the branch deletes them, or 14 days pass.

## Size limits and the two server variables

The scanner asks the server for these limits before it builds the snapshot. An operator sets them
with server variables ([Server settings](./install-server.md#server-settings)):

| Variable | Default | Meaning |
|---|---|---|
| `QUALOR_REVIEW_SNAPSHOT_MAX_COMPRESSED_BYTES` | 50 MiB | largest snapshot upload, as sent |
| `QUALOR_REVIEW_SNAPSHOT_MAX_DECOMPRESSED_BYTES` | 500 MiB | largest snapshot once inflated. 500 MiB is also the maximum, and 1 MiB the minimum |

A reverse proxy must let bodies this large through, as for reports: raise `client_max_body_size`
together with the first variable ([Reverse proxy and TLS](./install-server.md#reverse-proxy-and-tls)).
Snapshots share the server's upload slots with reports (`QUALOR_MAX_CONCURRENT_UPLOADS`, 4 by
default), but a snapshot never takes the last free slot: that one stays for reports, so snapshots
alone never fill every upload slot. With only one slot, snapshots and reports share it. When no
slot is free for a snapshot the server answers 503, and the scanner waits and retries. In a Helm
install both variables go into `extraEnv`.

Each merge request analysis with AI review on also adds an unpack job to the server's analysis
worker. With the default `QUALOR_WORKER_CONCURRENCY=1` that job can delay the quality gates of
other projects by a few seconds, so set it to 2 or more on a busy server
([Server settings](./install-server.md#server-settings)). The reviews themselves run on a worker
of their own, `QUALOR_REVIEW_WORKER_CONCURRENCY` at once (2 by default, at most 8), so a review
never delays an analysis or an answer of the AI assistant.

Fixed limits: 1 MiB per file, 50 000 files, 256 KiB per diff and 64 MiB of diffs in all, 1 024
bytes per path.

## Budgets and the instance ceiling

AI review has budgets of its own, separate from the AI assistant's budgets: one large review cannot
use up the day's explanations, and the reverse. They are per organisation and per UTC day, and an
organisation admin sets them under **Budgets per day (UTC)** in **Settings → AI review**:

| Budget | Default | Meaning |
|---|---|---|
| Tokens per day | 2 000 000 | the most tokens (input and output) all the organisation's reviews may use in a day |
| Cost per day in US dollars | empty (no limit) | needs the model's prices, which the instance admin enters in the AI assistant settings |
| Tokens per project and day | empty (no limit) | the most tokens one project's reviews may use in a day |
| Tokens per review | 300 000 | the most one review may use; a review that reaches it ends with what it has found |

The **instance ceiling** belongs to the instance admin: **Settings → AI assistant**, field **AI
review: most tokens per organisation per day**. An organisation's tokens per day are the smaller of
its own value and the ceiling; **Settings → AI review** shows the ceiling next to the field. Empty
means no ceiling. The budgets take effect when the review itself runs.

## What your CI needs

- **Merge request pipelines.** On GitLab, run the job in merge request pipelines
  (`merge_request_event`, [GitLab](./gitlab.md#2-the-ci-job)). On GitHub, run the workflow on
  `pull_request` ([GitHub](./github.md#2-the-workflow)). The scanner reads the merge request's last
  commit, title and description from the CI: `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` in a merged-result
  or merge-train pipeline (`CI_COMMIT_SHA` otherwise), `CI_MERGE_REQUEST_TITLE` and
  `CI_MERGE_REQUEST_DESCRIPTION` on GitLab, and the event's `pull_request.head.sha`, `title` and
  `body` on GitHub.
- **The last commit must be in the clone.** The workflow on the [GitHub](./github.md#2-the-workflow)
  page checks out the pull request's head with `fetch-depth: 0`, so it is. With GitHub's default
  checkout, which is a merge commit, the scanner fetches the last commit from `origin` by its id.
  That needs the checkout's credentials, so a job with `persist-credentials: false` cannot fetch it
  from a private repository: check out the head as that page shows. **`scm.autoFetch: false` in
  `qualor.yml` fetches nothing**, so with it a clone that lacks the last commit sends no snapshot.
- **The full history**, as for new code (`GIT_DEPTH: 0` on GitLab, `fetch-depth: 0` on GitHub), so
  the scanner finds where the branch left the target branch. A shallow clone that cannot be
  deepened sends no snapshot.
- **GitLab CI or GitHub Actions.** Other CI systems (Jenkins, Bitbucket, TeamCity or a laptop)
  send no snapshot: the scanner learns the merge request, its last commit, title and description
  only from those two, and `--mr` with `--mr-target` alone does not give it enough.
- **A scan that exits 3** (a required analyzer failed) sends no snapshot.
- `--mr` and `--mr-target` that name **another merge request** than the one CI runs for send no
  snapshot (the title and the last commit are the CI's).
- **Time.** Building the snapshot masks every file, at about 1.8 MB of text a second on a
  developer machine: about 15 seconds for a repository of 25 MB, and about five minutes near the
  500 MiB limit. It adds to the job. The scan does not wait for the server to unpack the snapshot.

**The snapshot never changes the scan's result.** Whatever goes wrong while it is built or sent
is a warning in the log. The exit code stays the quality gate's.

## Troubleshooting

Every scan log line about the snapshot starts with `AI review` (the table leaves out the
`AI review: ` prefix). The table lists the messages that call for an answer; the log has more
informational lines about what the snapshot holds and masks. Set `QUALOR_LOG_LEVEL=debug` for more.

| Message in the scan log | What it means, and what to do |
|---|---|
| `AI review is off for this project (<reason>), so no repository snapshot is sent` | Not an error. The reasons are in the next table |
| `no snapshot sent, the secret scan (<engines>) did not complete` | An engine that is switched on and had something to run did not finish, or rule files you named in `analyzers.semgrep.configs` never ran. Fix the path or the tool, or switch the engine off with `enabled: false` ([When the secret scan stops the snapshot](#when-the-secret-scan-stops-the-snapshot)). An engine with nothing to run, such as Semgrep on its defaults, does not cause it |
| `no snapshot sent, the secret scan's output could not be read` | Run the scan again. If it repeats, read the debug log |
| `no snapshot sent, the merge request's head commit <sha> is not in the clone and could not be fetched` | Give the job the full history, or check out the pull request's head ([What your CI needs](#what-your-ci-needs)) |
| `… is not in the clone (scm.autoFetch is false)` | Allow the fetch (`scm.autoFetch: true`), or give the clone the commit |
| `no snapshot sent, the merge request's head commit is unknown (…)` | The CI did not name the commit: run in merge request pipelines on GitLab, on the `pull_request` event on GitHub |
| `no snapshot sent, the merge request's head and origin/<target> have no common commit in this clone` | The clone lacks the history: `GIT_DEPTH: 0` or `fetch-depth: 0` |
| `no snapshot sent, the merge request's changes alone are over the server's snapshot limits` | The merge request is very large. The operator can raise the [limits](#size-limits-and-the-two-server-variables) |
| `no snapshot sent, the head files that differ from the scanned checkout could not be scanned` | Gitleaks failed on them. Run the scan again, or rebase the merge request (when the target branch changed a file that your Gitleaks configuration extends), or read the debug log |
| `no snapshot sent, --mr and --mr-target name another merge request …` | Do not pass `--mr` and `--mr-target` for a merge request other than the one CI runs for |
| `no snapshot sent, the server refused it (409 AI_REVIEW_OFF …)` | An organisation admin switched AI review off, or the provider changed, while the job ran |
| `… (413 SNAPSHOT_TOO_LARGE …)` | Over the limits. Raise them, and the proxy's body limit |
| `… (409 SNAPSHOT_EXISTS …)` | The analysis already has a snapshot |
| `the merge base's files could not be scanned for secrets (…), so the snapshot sends none of the lines the merge request removes` | Gitleaks could not run over the target branch's versions. The snapshot is sent without removed lines |
| `the secret scan is off in qualor.yml; only built-in patterns mask secrets in the snapshot` | You switched Gitleaks off; see [above](#when-the-secret-scan-stops-the-snapshot) |
| `N paths left out of the repository snapshot, which cannot hold them safely` | A warning, and the snapshot is sent without those paths: names that are very long, hold control characters or other characters a snapshot path may not have, or hold a secret |
| `N files are not in the clone's objects and were left out of the snapshot` | A partial clone lacks those files. Fetch the objects, or use a full clone |
| `the server could not be asked whether it reviews (…), so no repository snapshot is sent` | The scanner could not reach the server's review route (network, proxy or certificate). The report is uploaded; there is no snapshot this time |
| `the server did not say whether it reviews (…), so no repository snapshot is sent` | The server answered with an error, such as 403 for a token that cannot upload. The text names it |
| `the merge request's diff could not be read, so the snapshot has no patches: …` | git failed to produce the diff. The snapshot is sent without diffs |
| `no snapshot sent: <error>` | A git, disk or network failure while the snapshot was built or sent. The text says which, with any secret in it masked |
| `the server is busy with other uploads; retrying the snapshot` | The server's upload slots are taken; the scanner retries. The operator can raise `QUALOR_MAX_CONCURRENT_UPLOADS` |
| a snapshot is uploaded and nothing else happens | Expected today: the review itself arrives with the next part of this page |

Why AI review is off for a project:

| Reason | Fix |
|---|---|
| `no_provider` | An instance admin configures a provider in **Settings → AI assistant** |
| `organization_disabled` | An instance admin enables the organisation there |
| `review_disabled` | An organisation admin switches AI review on in **Settings → AI review** |
| `consent_outdated` | The provider changed. An organisation admin presses **Confirm again** |
| `project_not_selected` | Add the project to **Projects to review**. If the instance admin excluded it from the AI assistant, it is never reviewed |
| `not_mapped` | Map the project to its GitLab or GitHub repository ([GitLab](./gitlab.md), [GitHub](./github.md)) |

## API

An organisation admin's settings page uses these endpoints, so you can script the same steps:

- `GET /api/v0/organizations/{id}/ai/review` returns the settings, the warning (`notice`), the
  provider (`provider.host` and `provider.model`) and `consentCurrent`.
- `PUT /api/v0/organizations/{id}/ai/review` sets `enabled`, `scope` (`all` or `selected`),
  `projectIds` and `budgets`. To switch AI review on, or to confirm it again, add
  `acknowledgeDataSharing: { host, model }`, copied from the `provider` of the `GET` answer.

Errors: `AI_DISABLED` (409: no provider, or the organisation is not enabled for the AI assistant),
`AI_REVIEW_CONSENT_REQUIRED` (409: switching on without the acknowledgement),
`AI_REVIEW_PROVIDER_CHANGED` (409: the provider changed since you read the warning; nothing is
stored, read the `GET` answer again) and `PROJECT_NOT_IN_ORGANIZATION` (422: a project of another
organisation). The scanner itself uses `GET /api/v0/projects/review-context` and
`POST /api/v0/analyses/{id}/review-snapshot` with the project's analysis token. Their errors are
`AI_REVIEW_OFF`, `SNAPSHOT_EXISTS`, `SNAPSHOT_TOO_LARGE`, `SNAPSHOT_INVALID` and
`ANALYSIS_NOT_FOUND`.

## What comes next

The next part of this page describes the review itself: what it looks for, how it uses your rules
files and the diff, where it posts its findings on GitLab and GitHub, how it answers replies, what
it costs, and which models work well. Until then, the snapshot is the only thing AI review adds to
your server.
