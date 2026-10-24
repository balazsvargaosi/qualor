# AI review

AI review reads a merge request the way a careful colleague would, on a model you choose, and
comments on what it finds. On GitHub, read "pull request" wherever this page says "merge request".
It is part of the free community edition and **off by default**. It uses the provider that an
instance admin configured for the [AI assistant](./ai-assistant.md): a hosted provider with your
own key, or a local model on your own network.

Your code goes to that provider. For each merge request of the projects you choose, the scanner
uploads a copy of the repository to your Qualor server, and the review sends the model the diff and
any file it chooses to read. Choose the projects with that in mind.

This page covers what you set up, what a review does and posts, how long Qualor keeps its copies,
the budgets, and what to do when a review does not run.

## How it works

1. An **organisation admin** switches AI review on in **Settings → AI review**, confirms a warning
   that names the model's provider, and chooses the projects.
2. Your CI scans a merge request as usual. When AI review is on for the project, the scanner then
   uploads a **snapshot**: a copy of the repository as it is at the merge request's last commit,
   with the merge request's changes, and with secrets masked.
3. The server stores and unpacks the snapshot, and a review runs in the background on your model
   ([How a review works](#how-a-review-works)). The scan, the quality gate and the analyzers'
   comments do not wait for it.
4. The review comments on the merge request: a section in Qualor's summary comment, and a thread on
   each finding, with a suggested change where one fits
   ([What you see in the merge request](#what-you-see-in-the-merge-request)). The findings are also
   issues in Qualor, marked **AI**.
5. A later push is reviewed again, and only its new changes raise new findings
   ([Re-reviews](#re-reviews)).
6. Qualor deletes the snapshot when the merge request is merged or closed
   ([How long copies live](#how-long-copies-live)).

Only merge request scans send a snapshot. A scan of the main branch or of any other branch never
does, and neither does a project that AI review is not switched on for.

AI review never changes the quality gate, the scan's exit code or the measures, and a review that
fails never fails the analysis. It does not approve or reject a merge request, and it changes none
of your code: a person applies a suggestion.

## Switch it on

### What has to be in place

- An **instance admin** has configured a model provider and enabled the organisation in
  **Settings → AI assistant** ([Configuration](./ai-assistant.md#configuration)). AI review uses
  the same provider and model. The AI assistant's three features (Explain, Suggest triage, Suggest a
  fix) do not have to be on. Without a provider, **Settings → AI review** says so and its form stays
  disabled.
- The model can call tools ([Models that work](#models-that-work)).
- The project is mapped to its repository on GitLab or GitHub ([GitLab](./gitlab.md),
  [GitHub](./github.md)), because the review is posted there.
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
3. Set the [budgets](#budgets-and-todays-usage) if the defaults do not suit you.
4. Press **Save**.

A project's settings (**Project → Settings → AI review**) show whether AI review is on for that
project. The panel only shows the state; the organisation admin changes it.

To switch AI review off, uncheck the box and save. No confirmation is needed. A review that is
running stops at its next step, and Qualor deletes the snapshots it holds for the projects that are
no longer reviewed ([How long copies live](#how-long-copies-live)).

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

## How a review works

A review starts when the scanner's snapshot of a merge request has arrived. It runs on the server,
in the background. The summary comment says **AI review in progress…** until it ends.

- **A snapshot that is late.** The review waits 15 minutes for it. Without one it ends as not run,
  and a snapshot that arrives later starts it again, as long as no newer push has been analysed
  since.
- **A newer push replaces a review in progress.** The old review stops asking the model and stores
  nothing. The new push is reviewed instead.
- **Some merge requests are not reviewed:** a draft; one that is merged or closed; one with nothing
  to review in its changed files; one whose reviewed changes are the same as in the last review; one
  too large for **Tokens per review**; and every one while the day's token budget is spent. The
  summary says which ([What the summary says](#what-the-summary-says)).
- **A stop of the server ends a review in progress.** The review ends as failed at once, so the
  stop does not wait for it, and it is not resumed: the summary says that AI review failed because
  of an error in Qualor, and the next push reviews again. A review that has not started yet runs
  once the server is up again.

### What the model is sent

- the merge request's title and description, and the name of its target branch;
- the changed files, with the code around the changes, and the rest of the repository as far as the
  model chooses to read it;
- your rules files `AGENTS.md`, `CLAUDE.md` and `REVIEW.md`, when the repository has them;
- what the analyzers already reported on the changed files: rule, severity, message and place;
- the findings of earlier reviews of this merge request.

Secrets are masked in all of it, also in the files the model reads later. Credentials files are not
in the snapshot, and files on the AI assistant's **Never send these paths** list are never shown to
the model. Only the server contacts the provider, and only through the address the instance admin
configured.

### What it reviews

The files the merge request changed, except:

- lock files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock` and the
  like);
- generated files (`@generated`, or `Code generated … DO NOT EDIT`, in their first lines) and
  minified files;
- binary files;
- files on the AI assistant's **Never send these paths** list
  ([What is sent, and where](./ai-assistant.md#what-is-sent-and-where)).

### The reviewers

How many reviewers read a merge request depends on its size: the lines added and removed in the
files the review covers.

| Size of the change | Reviewers |
|---|---|
| up to 10 lines | quality |
| up to 300 lines in at most 20 files | quality and tests |
| anything larger | security, quality, tests and performance |

A changed file whose path looks security-sensitive (it has `auth`, `login`, `session`, `password`,
`secret`, `crypt` or `token` in it, and a few more such words) adds the security reviewer at any
size.

| Reviewer | Looks for |
|---|---|
| quality | logic errors, errors that are swallowed or mishandled, risky or breaking changes, concurrency problems |
| tests | changed behaviour that no test would catch breaking, tests that cannot fail, documentation the change makes wrong |
| security | injection, missing or wrong authorisation, secrets in code or logs, misused cryptography, server-side request forgery, path traversal, unsafe deserialisation |
| performance | work that grows faster than it should, a query or request per item, memory with no bound, blocking calls on hot paths |

The reviewers read one after the other. Each reads the change with the code around it, and may read
more of the repository with three read-only tools over the snapshot: read a file, search for a piece
of text (not a pattern), and list files. The tools run nothing and reach nothing outside the
snapshot.

### The judge

Reviewers report everything they suspect, so some of it is wrong or repeated. A judge then reads
their findings against the code. It keeps what the code shows, merges findings that describe one
problem, and drops the rest. It also re-checks the findings of earlier reviews
([Re-reviews](#re-reviews)) and writes the one-sentence verdict and the short walkthrough of the
summary. If the judge gives no answer that can be read, the review fails and posts nothing.

### The second check of security findings

A security finding that the judge keeps as high or medium is checked again, by a separate
conversation that gets that finding alone and has to decide from the code whether the flaw is real.
It does this for five findings at most, the most severe first. A finding it rejects is dropped. One
it confirms says so on the issue. One it cannot settle is kept as a possible finding, marked
**Needs validation**.

### What counts as a finding

A finding is a problem that the merge request brings in or makes worse: in code it adds or changes,
or in code whose behaviour it changes. The reviewers and the judge are told not to report:

- unchanged code that the merge request does not affect;
- advice to use another library, framework or tool;
- formatting or style that a formatter or linter fixes, and matters of taste;
- defence in depth where the main defence holds;
- a risk that the code rules out.

A finding must sit on a line the merge request changed, or within three lines of one. One that does
not is dropped. A review keeps at most 40 findings.

Each finding has a category, a severity and a confidence:

- **Category:** logic, error handling, compatibility, concurrency, security, performance, tests or
  documentation. The issue's rule is `ai:<category>`, such as `ai:logic`.
- **Severity:** **High** is an outage, lost or corrupted data, or a flaw someone can exploit.
  **Medium** is a concrete risk: a wrong result, a crash or a leak on inputs that occur, a broken
  contract. **Low** is worth considering, and nothing goes wrong yet. A person can change an
  issue's severity in Qualor as for any issue.
- **Confidence:** *likely* when the review read the code involved and the problem follows from it,
  *possible* when it follows only if an assumption holds that the review could not check (the finding
  states the assumption). A suspicion that the code did not confirm is not reported.

### What the review takes into account

- **Your rules files.** `AGENTS.md`, `CLAUDE.md` and `REVIEW.md` from the repository's root, as the
  target branch has them, say what the repository intends and how it wants to be reviewed. The
  review is told to follow them: a finding that goes against them is not one. They can narrow or
  explain the review. They cannot change what it does or how it answers.
- **The analyzers' findings.** The review is shown what Qualor's analyzers already reported on the
  changed files, and is told not to repeat it.
- **Earlier findings.** It sees the findings of earlier reviews of this merge request, and which of
  them a person dismissed.

The review treats everything it reads from your repository, the merge request's description and the
rules files as data, not as instructions, and the model is told so.

### Quality profiles

AI findings are issues of eight built-in rules: `ai:logic`, `ai:error-handling`,
`ai:compatibility`, `ai:concurrency`, `ai:security`, `ai:performance`, `ai:tests` and `ai:docs`.
They appear in the rules list and in profiles. Quality profiles do not affect them: deactivating an
`ai:*` rule does not stop the review from reporting it. To keep AI review away from a project,
leave the project out of **Projects to review**.

## What you see in the merge request

### The summary

AI review adds a section, **AI review**, to Qualor's summary comment (the one with the gate verdict).
Until the review ends it says "AI review in progress…". Then it shows:

- the judge's one-sentence verdict on what the review found and how serious it is;
- the open findings by severity, such as `Findings: 1 high · 2 medium · 0 low`, or "No findings.";
- a short walkthrough of what the merge request changes, in up to six points;
- under **Not on changed lines**, the findings that have no thread: those with no changed line near
  them, and those whose thread could not be posted (past the cap, or the merge request moved on). It
  lists up to ten, the most severe first, each with a link to Qualor, and counts the rest. A low
  finding on a changed line, with no suggested change, has no thread and is only counted;
- notes where the review fell short: it reached its token limit, a reviewer's answer could not be
  read, more security findings than it verifies, or files the scanner left out of the snapshot;
- the commit it reviewed, and the merge request's latest commit when that is a different one;
- when there is room, a collapsed **Prompt for an AI agent** that lists the open findings (up to
  20), to paste into a coding agent.

When the review did not run or failed, the section says so in one sentence
([What the summary says](#what-the-summary-says)). The findings are not in the summary's count of
new issues, and they never count in the gate.

### Threads

A finding of high or medium severity gets a thread on the line it is about, in the merge request's
diff: a discussion on GitLab, a review comment on GitHub. A low finding gets a thread only when it
carries a suggested change that applies. Every other finding is in the summary's count and in
Qualor.

The first comment of a thread has:

- a header with the severity, the category, *likely* or *possible*, and the rule's key;
- the title in bold, then what is wrong, why it matters and how to fix it;
- what the finding assumes (**Assumes:**), and **Needs validation** when the second check could not
  settle it;
- the suggested change, if there is one;
- a link to the finding in Qualor.

There are at most **20 AI threads** per merge request, beside the analyzers' 50. The most severe
findings get them first, and a finding past the cap is in the summary. A thread is created only
while the merge request is still at the commit the review read. After a newer push, the review of
the new commit places its own findings. Threads are never deleted. AI review needs no extra GitLab
scope and no extra GitHub App permission.

If you require all threads to be resolved before merging, the open threads of AI review block the
merge like the analyzers' do ([GitLab](./gitlab.md#4-block-merges-on-the-gate),
[GitHub](./github.md#4-block-merges-on-the-gate)).

### Suggested changes

When the fix is a replacement of up to 15 lines that the merge request added, the thread carries it
as a GitLab suggestion or a GitHub suggested change. A person reviews it and applies it there with a
click, which makes a commit in that person's name. Qualor never commits, pushes or opens a branch of
its own.

Qualor posts the suggestion only when, at that moment, the lines it replaces are still exactly the
added lines the review read, and it passes the checks of the AI assistant's fix suggestions (no
secret, no control character, no GitLab quick action). Otherwise the thread is posted without it, and
its text says how to fix the problem.

### The text

The model's prose reaches GitLab and GitHub as plain words. A word that could become a link, a
mention, a reference or markup is put in code formatting: addresses, `@name`, `#1`, `!1`, commit
hashes, issue keys such as `ABC-123`, file paths, HTML. Hidden characters and characters that
reverse the direction of text are removed. So the text cannot mention a person, start a GitLab quick
action or link anywhere of its own. Qualor's labels and links are fixed text, and the lines of a
suggested change are code, checked as described above.

One thing stays as it is: words that look like ordinary words but match a tracker you set up. Examples
are `bug 12` (GitLab's EWM integration), `CU-abc` (ClickUp), `TICKET-abc` (a custom autolink of a
GitHub repository), and whatever the `jira_issue_regex` of a GitLab project matches. They can become
links, but only to the issue tracker configured for that project or repository. Qualor does not
change them.

### The findings in Qualor

- Each finding is an issue of the engine `ai`. In the issue list and on the file page of the
  **Code** tab it has an **AI** badge, and the issue list can be filtered by the engine **AI review**.
- The issue page has an **AI review** card: the review's text, what it assumes, the result of the
  second check, the suggested change as numbered lines, and the commit the review read. The card
  ends: "Found by AI review. It may be wrong, and it never counts in the quality gate."
- Findings are outside the measures, the quality gate and the counts of new issues. A failed or
  skipped review changes none of them.
- A person changes a finding's status as for any issue. **False positive** and **Won't fix** dismiss
  it: its thread is resolved (unless a person replied in it), and the review never raises it again.
  The issue's history says that the review raised it, and, when a later review closes it, whether
  the problem was fixed or its file was deleted.
- In [MCP](./mcp.md), `qualor_issues` marks findings `AI`, and `qualor_issue` gives the review's
  text, its assumption, the suggested change and the commit it read.

Qualor does not answer replies to its threads yet: a reply from a person only keeps Qualor from
resolving the thread. Resolving a thread on GitLab or GitHub hides it there and does not dismiss the
finding: mark the issue in Qualor to do that.

## Re-reviews

Each new scan of a merge request is reviewed again, on its latest commit.

- **Only new changes raise new findings.** The scanner works out which lines changed since the last
  reviewed commit, and a re-review raises new findings only on those lines (and within three of
  them). When the last reviewed commit is no longer part of the branch, as after a rebase, the whole
  merge request counts as changed.
- **Earlier findings are checked wherever they are.** The judge looks at every open finding of the
  earlier reviews and says whether the problem is still in the code.
- **Fixed findings are closed.** A finding whose problem is gone is closed, and its thread is
  resolved unless a person replied in it. A finding in a file the merge request deleted is closed
  too. One that is still there, or that the review could not tell, stays open.
- **A dismissed finding is never raised again.** After you mark a finding false positive or won't
  fix, the review does not report the same problem in the same place.
- **Threads follow the finding.** A thread that Qualor resolved is reopened if its finding is open
  again. A thread that a person resolved stays resolved.
- **A push that changes nothing the review reads** (it touches only files the review leaves out, say)
  is not reviewed again, and the findings stay as they are.

## Models that work

- **Tool calling is required.** The model reads the repository through tools. A server that refuses
  tools makes the review fail, and the summary says the provider does not support the tool calls the
  review needs. A model that ignores them reviews only what it is shown up front, and misses what
  reading the rest of the repository would have found. **Settings → AI assistant → Test** shows it:
  when the test passes, a second call checks tool calling and the page says
  `Tool calling (needed by AI review): supported` or `not supported`. It says nothing when it could
  not tell.
- **Small local models give weak reviews.** They miss problems, report others that are not there,
  and more often fail to answer in the form the review needs. Use a strong model for code.
- **Allow time.** The provider timeout in the AI assistant settings (60 seconds by default, 5 to
  600) applies to every call of a review, and its answers are long: a reviewer may write up to
  12 288 tokens in one answer and the judge up to 16 384. A review of a big merge request may need a
  higher timeout, and so may a slow local model.
- **The review writes in English**, whatever language your code and comments are in.

## What the scanner uploads

The snapshot is read from git, from the merge request's **last commit** (its head), not from the
working directory of the job. Files your CI generated or changed after the checkout are not in it.
It holds:

- **The text files of the repository** at that commit: up to 50 000 files of up to 1 MiB each.
- **The merge request's changes**: for every changed file, what happened to it (added, modified,
  renamed, deleted) and its diff against the point where the branch left the target branch and,
  after a first review, which lines changed since the last reviewed commit. A diff over 256 KiB is
  not sent.
- **The rules files `AGENTS.md`, `CLAUDE.md` and `REVIEW.md`** of the repository's root, when it
  has them (up to 64 KiB each), as they were where the merge request branched off the target
  branch, not as the merge request edits them, so a merge request cannot rewrite the rules it is
  judged by.
- **The merge request's title and description**, cut to 255 and 12 000 characters. GitLab passes
  only the first 2 700 characters of a description to the job.

**Left out, never sent** (the snapshot notes which files were left out, and why):

- files that the built-in excludes or your `sources.exclude` match (`node_modules`, `dist`, `build`,
  `vendor`, minified files and the rest of [Built-in excludes](./configuration.md#built-in-excludes)).
  To keep a file out of the snapshot, list it in `sources.exclude`. The AI assistant's **Never send
  these paths** list is a server setting that the scanner does not read: those files are still
  uploaded to your server, and the review never shows them to the model;
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

The server masks each file again with the built-in patterns before it shows it to the model.

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

## How long copies live

The snapshot is a copy of your repository in Qualor's database. A job on the server unpacks the
upload into one record per file, which takes seconds. Qualor deletes the copy at the first of these:

- **A newer analysis.** A merge request keeps the snapshot of its **newest analysis** only. When
  the merge request's next analysis has been processed, the older snapshots of that merge request
  go.
- **The merge request is merged or closed.** Qualor deletes the copy as soon as it sees the merge
  request merged or closed: when it posts its comments, when a review reads the merge request, and
  in a check that runs every hour for each merge request that holds a snapshot. The copy is gone
  within an hour of the merge request closing. When the check cannot reach GitLab or GitHub, the next
  one is an hour later.
- **AI review stops covering the project.** Qualor deletes a project's copies right after you
  switch AI review off or leave the project out of **Projects to review**. It does the same when an
  instance admin disables the organisation, excludes the project from the AI assistant, removes the
  provider or changes it (until an organisation admin confirms again), and when the project is
  unmapped from its repository or its SCM connection is deleted.
- **After 14 days.** A daily job deletes every snapshot that is **more than 14 days old**, whatever
  its state, and catches the copies the rules above missed. A snapshot the server refused (a damaged
  upload) is deleted after one day.

The snapshot lives in Qualor's database, like the reports and the code snippets of issues. Qualor
does not encrypt it, and no page or API of Qualor shows it. Treat the database and its
[backups](./install-server.md#backups) as you treat the code.

Allow for its size. The copies take about the text of the repository, which PostgreSQL compresses,
for each open merge request with a recent push, plus the copies of failed or stale analyses until
the next successful analysis on the branch deletes them, or 14 days pass.

Two other records hold something of a review:

- **The findings** are issues, kept like any issue. A closed one is deleted after 30 days.
- **Every call to the model** is recorded like an AI assistant request, with the feature `review`,
  the model, the token counts, the estimated cost and a hash of what was sent, for 90 days. The
  server log has one line for each call, with no content. If an instance admin switched on **Store
  the prompts sent**, a review's prompts are kept too, for the days set there (1 to 90, 7 by
  default), and what the model answered stays with the record. They can quote the code the model
  was shown ([Retention and audit](./ai-assistant.md#retention-and-audit)).

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
slot is free for a snapshot the server answers 503, and the scanner waits and retries. With Docker
Compose, add the variables to the `environment` of the `server` service. In a Helm install they go
into `extraEnv`.

Each merge request analysis with AI review on also adds an unpack job to the server's analysis
worker. With the default `QUALOR_WORKER_CONCURRENCY=1` that job can delay the quality gates of
other projects by a few seconds, so set it to 2 or more on a busy server
([Server settings](./install-server.md#server-settings)).

The reviews themselves run on a worker of their own, `QUALOR_REVIEW_WORKER_CONCURRENCY` at once (2
by default, at most 8), so a review never delays an analysis or an answer of the AI assistant. Each
review that runs holds a masking worker that can use up to 512 MiB of heap, so allow that many times
the number of reviews on top of what the server uses otherwise: 1 GiB more at the default of 2. On a
small server, set the variable to 1 (in the same places as the two above).

Fixed limits: 1 MiB per file, 50 000 files, 256 KiB per diff and 64 MiB of diffs in all, 1 024
bytes per path.

## Budgets and today's usage

AI review has budgets of its own, separate from the AI assistant's budgets: one large review cannot
use up the day's explanations, and the reverse. They are per organisation and per UTC day, and an
organisation admin sets them under **Budgets per day (UTC)** in **Settings → AI review**:

| Budget | Default | Meaning |
|---|---|---|
| Tokens per day | 2 000 000 | the most tokens (input and output) all the organisation's reviews may use in a day |
| Cost per day in US dollars | empty (no limit) | needs the model's prices, which the instance admin enters in the AI assistant settings |
| Tokens per project and day | empty (no limit) | the most tokens one project's reviews may use in a day |
| Tokens per review | 300 000 | the most one review may use, from 1 to 10 000 000 |

The **instance ceiling** belongs to the instance admin: **Settings → AI assistant**, field **AI
review: most tokens per organisation per day**. An organisation's tokens per day are the smaller of
its own value and the ceiling; **Settings → AI review** shows the ceiling next to the field. Empty
means no ceiling.

**Today's usage.** Under the heading of the budgets, **Settings → AI review** shows what the
organisation's reviews have used since UTC midnight, such as
`Today: 120,000 of 2,000,000 tokens · 3 reviews`, with `· $1.23` added when prices are set. The
budget in that line is the smaller of the organisation's tokens per day and the instance ceiling.
`GET /api/v0/organizations/{id}/ai/review` gives the same figures as `usage`
([API](#api)). Reviews that were skipped are not counted.

**How the budgets are enforced.** Before a review starts, Qualor works out what it may spend: the
smallest of Tokens per review, what the organisation has left of its day, what the project has left
of its day (when it has a budget), and what the cost budget has left at the model's higher price.
When the day has nothing left, or too little for a review of this size, the review is skipped and
the summary says the day's token budget is spent. When Tokens per review itself is too little for a
merge request this large, the summary says that instead (see **Big merge requests** below).
Otherwise the review shares its tokens between its stages: 55 % for the reviewers, an equal part
each, 35 % for the judge and 10 % for the second check of security findings. A stage that has used
its share answers with what it has, and the summary says "The review reached its token limit, so it
may have missed problems." The limit is a ceiling Qualor works to, not a count to the token: it
stops asking the model when it expects the next answer not to fit, but it cannot know how long an
answer will be, so a review can end somewhat over it.

**Big merge requests.** The reviewers get the changed code in their first message and read more with
their tools. At the default of 300 000 tokens per review, a merge request of about 80 changed files
or more gets no code in that first message, and its reviewers have room for fewer turns of reading.
From about 100 changed files it is not reviewed at all: the list of its changes alone would leave a
reviewer no room. Short paths let more files fit, and many analyzer findings on the changed files
fewer. The summary then says "AI review did not run because this merge request is too large for the
Tokens per review budget; raise it in the AI review settings." For big merge requests, raise
**Tokens per review** in **Settings → AI review** (to 600 000, say), and check that the day's budget
can pay for it.

**How tokens are counted.** Tokens are the counts the provider reports. For a call that reports no
input count, Qualor counts a quarter of the bytes it sent, both in a review's ceiling and in today's
figure. An output count that the provider does not report is left out of today's figure, so a provider
that reports none makes it too low. A call the provider refused, did not take or could not be reached
for is not counted.

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
  The scanner gives the snapshot **10 minutes**: one that is not built by then (a fetch that
  stalls, say) is not sent, and the job goes on to the quality gate.

**The snapshot never changes the scan's result.** Whatever goes wrong while it is built or sent
is a warning in the log. The exit code stays the quality gate's.

## Troubleshooting

### What the summary says

The summary comment on the merge request says what became of the review. These are its sentences
and what to do about each:

| The summary says | What it means, and what to do |
|---|---|
| AI review in progress… | The review waits for the snapshot (up to 15 minutes) or is running. The summary is updated when it ends |
| AI review did not run: no repository snapshot came for this commit. See the CI job’s log and the guide’s `fetch-depth` note. | The scanner sent no snapshot, or it took more than 15 minutes to arrive. Read the `AI review:` lines in the CI job's log ([the scan log](#the-scan-log)). A shallow clone, a pipeline that is not a merge request pipeline and a secret scan that did not finish are the usual causes ([What your CI needs](#what-your-ci-needs)). A snapshot that arrives later starts the review again |
| AI review did not run: the server refused the repository snapshot of this commit. (`Reason: SNAPSHOT_INVALID`) | The server could not use the upload, or it was of another merge request. The server log names the reason. Run the job again to upload a new snapshot, and report it if it repeats |
| AI review is skipped while this merge request is a draft; the next pipeline after it is ready reviews it. | Mark the merge request ready, then run the pipeline again |
| AI review did not run because this merge request is merged or closed. | Nothing to do |
| AI review is switched off for this project. (`Reason: …`) | The reason code says why: [Why AI review is off for a project](#why-ai-review-is-off-for-a-project) |
| AI review found nothing to review in the changed files. | Not an error. The merge request changes only files the review leaves out: lock files, generated or minified files, binary files and files on the AI assistant's **Never send these paths** list |
| AI review did not repeat: the changes it reviews are the same as in its last review, whose findings stay open. | Not an error. The push changed nothing the review reads |
| AI review did not run because its token budget for today is spent. | Wait for UTC midnight, or raise the budgets ([Budgets and today's usage](#budgets-and-todays-usage)). It also appears when what is left of the day is too little for a merge request of this size |
| AI review did not run because this merge request is too large for the Tokens per review budget; raise it in the AI review settings. | The list of its changes alone leaves a reviewer no room: at the default 300 000 tokens, from about 100 changed files. Raise **Tokens per review** in **Settings → AI review** ([Budgets and today's usage](#budgets-and-todays-usage)) |
| AI review failed: the model provider returned an error or could not be reached. The next push reviews again. | A call was refused, timed out, was rate limited or got no answer. Qualor tries a rate-limited call again twice and one that timed out once. It also fails when the stored API key can no longer be read (`QUALOR_SECRET_KEY` changed). The server log's `AI review call finished` lines give each call's error code and the provider's HTTP status: [the table below](#when-the-model-provider-fails) says what to do. Run **Test** in **Settings → AI assistant** to check the provider |
| AI review failed: the model provider does not support the tool calls the review needs. The next push reviews again. | Use a model and a server that can call tools. **Test** in **Settings → AI assistant** shows `Tool calling (needed by AI review): not supported` for this one ([Models that work](#models-that-work)) |
| AI review failed: the model’s answers could not be read. The next push reviews again. | The judge did not answer in the form the review needs, even when asked again. Small models do this more often: try a stronger one |
| AI review failed because of an error in Qualor. The next push reviews again. | An unexpected error, or a stop of the server during the review (a review is not resumed). If it keeps happening with the server running, report it with the server log's `AI review run failed` line |
| The review reached its token limit, so it may have missed problems. | A stage used its share of the tokens. Raise **Tokens per review**, mainly for big merge requests ([Budgets and today's usage](#budgets-and-todays-usage)) |
| A reviewer’s answer could not be read, so part of the review is missing. | A reviewer did not answer in the form the review needs. The rest of the review is intact. Try a stronger model |
| There were more serious security findings than the review verifies, so the rest were not checked a second time. | Not an error. The second check covers five findings |
| The scanner left some files out of the repository snapshot to stay within its limits, so the review did not see all of them. | Raise the [snapshot limits](#size-limits-and-the-two-server-variables) |

A failed or skipped review is not tried again by itself. The next push reviews again, and so does
running the CI job again.

### When the model provider fails

A review that failed with a provider error has an `AI review call finished` line in the server log for
each call, with its status and, for a call that failed, its error code:

| Error code in the log | What to do |
|---|---|
| `PROVIDER_TIMEOUT` | The model did not answer within the provider timeout. A review's answers are long, and a big merge request or a local model may need more time: raise the timeout in **Settings → AI assistant**, up to 600 seconds |
| `PROVIDER_RATE_LIMITED` | The provider's own limit. Qualor waited as the provider asked and tried twice. Review again later, or lower the budgets |
| `PROVIDER_REFUSED_KEY` | Set a valid API key, and check the key header (`api-key` for Azure) |
| `PROVIDER_REJECTED_REQUEST` | The provider refused the request: check the base URL, the model's name and the output limit field ([AI assistant: Troubleshooting](./ai-assistant.md#troubleshooting)) |
| `PROVIDER_UNAVAILABLE` | The provider could not be reached or answered with a server error. Check the base URL and the network. After five failures in a row Qualor pauses calls to that address for 10 minutes, and a review that starts then fails at once, with no call in the log |

### The scan log

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
| `building the repository snapshot took longer than 10 minutes, so none is sent` | Usually a fetch that stalled, or a very large repository on a slow runner. Give the job the full history so nothing has to be fetched, or more CPU. This push is not reviewed; the next one sends a snapshot again |
| `the server is busy with other uploads; retrying the snapshot` | The server's upload slots are taken; the scanner retries. The operator can raise `QUALOR_MAX_CONCURRENT_UPLOADS` |

### Why AI review is off for a project

| Reason | Fix |
|---|---|
| `no_provider` | An instance admin configures a provider in **Settings → AI assistant** |
| `organization_disabled` | An instance admin enables the organisation there |
| `review_disabled` | An organisation admin switches AI review on in **Settings → AI review** |
| `consent_outdated` | The provider changed. An organisation admin presses **Confirm again** |
| `project_not_selected` | Add the project to **Projects to review**. If the instance admin excluded it from the AI assistant, it is never reviewed |
| `not_mapped` | Map the project to its GitLab or GitHub repository ([GitLab](./gitlab.md), [GitHub](./github.md)) |
| `provider_changed` | The instance admin changed the provider while a review was running, and the confirmation covers the new one. The review stopped. The next push is reviewed with the new provider |

## API

An organisation admin's settings page uses these endpoints, so you can script the same steps:

- `GET /api/v0/organizations/{id}/ai/review` returns the settings, the warning (`notice`), the
  provider (`provider.host` and `provider.model`), `consentCurrent`, the instance ceiling
  (`instanceCeiling.tokensPerDay`) and today's use of the organisation (`usage`: `tokensToday`,
  `reviewsToday` and `costTodayUsd`, which is `null` while no prices are set).
- `PUT /api/v0/organizations/{id}/ai/review` sets `enabled`, `scope` (`all` or `selected`),
  `projectIds` and `budgets`, and answers with the same fields. To switch AI review on, or to
  confirm it again, add `acknowledgeDataSharing: { host, model }`, copied from the `provider` of the
  `GET` answer.

A finding is an issue of the engine `ai`: `GET /api/v0/issues?branchId=…&engine=ai` lists them, and
`GET /api/v0/issues/{id}` gives them `aiReview` (`category`, `body`, `assumption`, `verification`,
`suggestion` and `reviewedCommit`), which is `null` for every other issue. `POST
/api/v0/system/llm/test` (instance admins) also answers `toolCalling`: `supported`, `not_supported`
or `not_checked`.

Errors: `AI_DISABLED` (409: no provider, or the organisation is not enabled for the AI assistant),
`AI_REVIEW_CONSENT_REQUIRED` (409: switching on without the acknowledgement),
`AI_REVIEW_PROVIDER_CHANGED` (409: the provider changed since you read the warning; nothing is
stored, read the `GET` answer again) and `PROJECT_NOT_IN_ORGANIZATION` (422: a project of another
organisation). The scanner itself uses `GET /api/v0/projects/review-context` and
`POST /api/v0/analyses/{id}/review-snapshot` with the project's analysis token. Their errors are
`AI_REVIEW_OFF`, `SNAPSHOT_EXISTS`, `SNAPSHOT_TOO_LARGE`, `SNAPSHOT_INVALID` and
`ANALYSIS_NOT_FOUND`.
