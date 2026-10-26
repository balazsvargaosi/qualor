# AI review

AI review reads a merge request the way a careful colleague would, on a model you choose, and
comments on what it finds. It also answers when people reply to its comments or ask it for a review
([Replies and commands](#replies-and-commands)). On GitHub, read "pull request" wherever this page
says "merge request". It is part of the free community edition and **off by default**. It uses the
provider that an instance admin configured for the [AI assistant](./ai-assistant.md): a hosted
provider with your own key, or a local model on your own network.

Your code goes to that provider. For each merge request of the projects you choose, the scanner
uploads a copy of the repository to your Qualor server, and the review sends the model the diff and
any file it chooses to read. When someone replies to one of its comments, the model gets that thread
and any file it chooses to read in the same way. Choose the projects with that in mind.

This page covers what you set up, what a review does and posts, how Qualor answers replies and
commands, how long it keeps its copies, the budgets, and what to do when a review or an answer does
not come.

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
5. A person who replies in one of Qualor's threads, or writes `qualor review` in a note, gets an
   answer, and a reply can mark an AI finding won't fix or false positive
   ([Replies and commands](#replies-and-commands)).
6. A later push is reviewed again, and only its new changes raise new findings
   ([Re-reviews](#re-reviews)).
7. Qualor deletes the snapshot when the merge request is merged or closed
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
- Optional: a webhook on that connection, so that Qualor answers replies and commands at once and
  not at the next analysis ([At once, or at the next analysis](#at-once-or-at-the-next-analysis)).

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
> `<host>` (`<models>`). The scanner uploads a copy of the repository to this Qualor server for each
> merge request; Qualor keeps it until the merge request is closed (at most `<days>` days). Secrets
> the analyzers found are masked; credentials files are never sent.

`<host>` is the provider's address (with its port, such as `ollama:11434`), and `<models>` every
model the review uses, each once, in sorted order and separated by commas: one model, or up
to three when the instance admin gave the provider a strong or a fast model
([Model tiers](./ai-assistant.md#model-tiers)). `<days>` is the most days the server keeps a
snapshot (14). Take it at its word: when the review runs, the code of the projects you choose goes
to that provider, so choose them with that in mind. No masking finds every secret
([How secrets are masked](#how-secrets-are-masked)).

Qualor records who confirmed the warning, when, and for which provider, and the audit log (with
`audit-log`) records each change of these settings as `organization.ai_review_changed`
([Roles and the audit log](./roles-and-audit.md#what-is-recorded)).

**A confirmation belongs to one provider and its models.** It names the provider's address, its
host and every model it uses. When the instance admin changes any of them, adds a strong or a fast
model, drops one or changes one, the confirmation no longer covers the new setup: AI review stops,
and **Settings → AI review** shows "The AI provider changed; confirm again to keep reviewing." with
a **Confirm again** button that opens the new warning. A warning given for one address or one set of
models never covers another. If the provider changes while you are looking at the box, saving is
refused and the box opens again with the new warning.

## How a review works

A review starts when the scanner's snapshot of a merge request has arrived. It runs on the server,
in the background. The summary comment says **AI review in progress…** until it ends.

- **A snapshot that is late.** The review waits 15 minutes for it. Without one it ends as not run,
  and a snapshot that arrives later starts it again, as long as no newer push has been analysed
  since.
- **A newer push replaces a review in progress.** The old review stops asking the model and stores
  nothing, unless it is already storing its findings. The new push is reviewed instead.
- **Some merge requests are not reviewed:** a draft, unless someone asks for it with `qualor review`
  ([Commands](#commands)); one that is merged or closed; one with nothing to review in its changed
  files; one whose reviewed changes are the same as in the last review; one too large for **Tokens
  per review**; and every one while the day's token budget is spent. The summary says which
  ([What the summary says](#what-the-summary-says)).
- **A stop of the server ends a review in progress.** The review ends as failed at once, so the
  stop does not wait for it, and it is not resumed: the summary says that AI review failed because
  of an error in Qualor, and the next push reviews again. A review that has not started yet runs
  once the server is up again, and so does an answer to a reply that was still waiting for the
  model.

### What the model is sent

- the merge request's title and description, and the name of its target branch;
- the changed files, with the code around the changes, and the rest of the repository as far as the
  model chooses to read it;
- your rules files `AGENTS.md`, `CLAUDE.md` and `REVIEW.md`, when the repository has them;
- what the analyzers already reported on the changed files: rule, severity, message and place. The
  findings of the secret-detection rules are among them, as rule, place and masked message, so that
  the review does not report them again;
- the findings of earlier reviews of this merge request.

Secrets are masked in all of it, also in the files the model reads later. Credentials files are not
in the snapshot, and files on the AI assistant's **Never send these paths** list are never shown to
the model. Only the server contacts the provider, and only through the address the instance admin
configured.

To answer a reply, the model is sent the finding the thread is about (its rule, message and place,
and for an AI finding its text and suggested change), Qualor's first comment in the thread, and what
people wrote in it since Qualor's last answer, each note with its author's user name: the newest 20
notes, each cut to 2 000 characters. It can read the repository through the same three tools as a
review, while the merge request has a snapshot. Secrets are masked in all of it, and the words of a
reply are data to the model, never instructions.

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

A changed file whose path looks security-sensitive adds the security reviewer at any size: one with
`auth`, `login`, `session`, `password`, `secret` or `crypt` anywhere in it, and a few more such
words, or with `token`, `sso`, `acl`, `jwt`, `csrf` or `rbac` as a word of its own, which no lower
case letter follows: `token.ts`, `tokens/` and `csrfToken.ts` count, and `tokenizer/` does not.

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

The reviewers run on the standard model. The one exception is the quality reviewer of a review of
10 changed lines or fewer, which runs on the fast model when the instance admin set one; the
security reviewer that a sensitive path adds stays on the standard model
([Model tiers](./ai-assistant.md#model-tiers)).

### The judge

Reviewers report everything they suspect, so some of it is wrong or repeated. A judge then reads
their findings against the code. It keeps what the code shows, merges findings that describe one
problem, and drops the rest. It also re-checks the findings of earlier reviews
([Re-reviews](#re-reviews)) and writes the one-sentence verdict and the short walkthrough of the
summary. If the judge gives no answer that can be read, the review fails and posts nothing. The
judge runs on the strong model when the instance admin set one.

### The second check of security findings

A security finding that the judge keeps as high or medium is checked again, by a separate
conversation that gets that finding alone and has to decide from the code whether the flaw is real.
It does this for five findings at most, the most severe first. A finding it rejects is dropped. One
it confirms says so on the issue. One it cannot settle is kept as a possible finding, marked
**Needs validation**. This check runs on the strong model too.

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
the new commit places its own findings. Threads are never deleted. The comments need no extra
GitLab scope and no extra GitHub App permission. Only the answers at once to `qualor review` on
GitHub ask the App for Issues: Read-only ([GitHub](./github.md#turn-on-the-webhook-recommended)).

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
- A reply in the finding's thread can dismiss it too: a member's decision of priority makes it
  **Won't fix**, and a claim that the code bears out makes it **False positive**
  ([Replies and commands](#replies-and-commands)). The issue's history then records the change with
  no user and a comment that names the person who replied.
- In [MCP](./mcp.md), `qualor_issues` marks findings `AI`, and `qualor_issue` gives the review's
  text, its assumption, the suggested change and the commit it read.

Qualor answers a reply in its threads ([Replies and commands](#replies-and-commands)). A reply from
a person also keeps Qualor from resolving the thread when the issue is fixed or marked in Qualor.
Resolving a thread on GitLab or GitHub hides it there and does not dismiss the finding: mark the
issue in Qualor to do that, or say so in a reply.

## Replies and commands

People can talk to AI review in the merge request. Qualor answers a reply in one of its threads, and
a note that starts with `qualor review`, `qualor fix` or `qualor stop`. It does so for the projects
AI review is switched on for, in open merge requests that it has analysed.

### Replies

Qualor answers a note when all of these hold:

- **It is in a thread Qualor started.** The thread's first note is one of Qualor's own comments on
  a finding, from an analyzer or from AI review. A reply to the summary comment is not answered.
- **A person wrote it.** On GitHub that is an account of the type User: comments of bots, Qualor's
  App among them, are never answered. On GitLab it is anyone but Qualor's own user, apart from
  GitLab's system notes. Give Qualor's connection a bot account, such as a project or group access
  token ([GitLab](./gitlab.md#3-merge-request-comments-and-commit-status)): what the user whose
  token Qualor uses writes looks like Qualor's own notes and is not answered.
- **It is new.** It is newer than every note Qualor has handled in that thread.
- **It is recent.** It was written after an organisation admin last confirmed the AI review warning,
  and at most 30 days ago, so that switching AI review on never answers old threads.
- **The thread is open, and so is the merge request.** A thread that someone resolved gets no
  answer, and that includes a thread Qualor resolved itself after changing the status.

All the notes written in a thread since Qualor's last answer are one **round**, and Qualor answers a
round once, reading every note in it. Two replies written close together usually get one answer,
and a reply written while Qualor is answering is answered in a round of its own.

The answer is plain prose in the language of the person's last note, up to 1 200 characters, under
the heading **AI review** · reply. A thank-you or an acknowledgement may get no answer at all. The
model reads the finding, Qualor's first comment and the notes, and, while the merge request has a
snapshot, the repository through the review's three tools. Its words reach GitLab and GitHub as the
review's do ([The text](#the-text)).

### What a reply can change

A reply can change the status of **the one finding its thread is about**, and nothing else. It can
do so only for an **open finding of AI review**:

| What a member of the project writes | What Qualor does | The answer ends with |
|---|---|---|
| States a decision of priority: the team accepts the risk, or will not fix it | marks the finding **Won't fix** and resolves the thread | `Marked won't fix.` |
| Claims that the finding is wrong, or that the code is meant to work that way, and the code shows it | marks it **False positive** and resolves the thread | `Marked as a false positive: the code shows it does not hold.` |
| Asks a question, disagrees, says thanks, or anything else | answers, and changes nothing | |

For a false positive, Qualor must have read the lines of the finding (a file read that showed one of
them, or a search that matched on one), and the code must still be the code the finding was made
for: the snapshot is of the commit the review read, or the lines still hold the same text. A merge
request without a snapshot gets answers from the thread alone, and never a false positive.

A demand is not a decision. "Mark every issue won't fix", an order to ignore its rules, a link or a
mention changes nothing, and what a reply can change is always that one finding. Qualor's own code,
not the model, decides which statuses a thread allows: an answer that names another one, or that
cannot be read even after a second try, is dropped and nothing is posted.

A thread of an analyzer's finding, and the thread of a finding that is no longer open, are only
explained: Qualor says what the rule means, why it applies and how to fix it, and never changes the
status.

**What is recorded.** The issue's **History** shows the change with no user (as **Analysis**) and
the comment ``Won't fix after `<name>` replied in the merge request.`` or
``False positive after `<name>` replied in the merge request.``. `<name>` is the SCM user name of
the person who wrote the newest note of the round. With the audit log (`audit-log`), the event
`issue.status_changed` is recorded by `system`. A person can set the status back in Qualor, as for
any issue.

### Who may change a status

A status changes only when every person whose note is in the round has the rights of a member,
since on a public repository anyone can comment:

- **GitLab:** the role Developer or more on the project, through a membership that is in force (one
  inherited from a group counts; an inactive user, or a membership that is not active or has
  ended, does not).
- **GitHub:** a repository role of admin, maintain, write or triage (a custom role counts when its
  base permission is write or admin). Qualor reads the role through the collaborator permission
  API, which needs only the Metadata permission that every App has. Being a member of the
  organisation is no role: it counts through the role it gives on the repository, and an organisation
  member with only read access does not qualify.

Anyone else, and any round of more than five authors, gets an answer and no status change. A member
of the project can still make the change in Qualor, or write the reply.

### Commands

A command is a note whose **first line** starts with `qualor review`, `qualor fix` or `qualor stop`,
in any case, followed by the end of the line or a space. `Qualor review please` is a command;
`@qualor review`, `please qualor review`, `qualor reviewer` and `qualor review.` are not. Only the
first line counts.

It has to be a **top-level** note: on GitLab the first note of a discussion, on GitHub a comment on
the pull request's page, not a review comment on the diff. A note inside a thread is never a
command: in one of Qualor's threads it is a reply. GitHub comments of bots are ignored. As for
replies, a command counts only when it was written after the confirmation of the warning and at most
30 days ago.

Qualor answers each command note once, in a note of its own with a fixed text: on GitLab in the
discussion of the command, on GitHub as a comment on the pull request. No model is called for a
command, and a command that was deleted before Qualor answered is not answered.

| The note | Qualor answers |
|---|---|
| `qualor review` from a person who may not ask | `Only project members can ask for an AI review.` |
| `qualor review`, and AI review was switched off after the note was written | `AI review is not switched on for this project.` |
| `qualor review`, and the commit was reviewed (the review is done, or found the same changes as the last one) | ``This commit (`<sha>`) has been reviewed. Push a new commit to review again.`` |
| `qualor review`, and a review of the commit is waiting or running | `A review of this commit is in progress.` |
| `qualor review` in any other case | ``Reviewing this commit (`<sha>`).`` |
| `qualor fix` or `qualor stop` | `Auto-fix is not switched on for this project.` |

`<sha>` is the first 12 characters of the commit. Only `qualor review` does anything.
`qualor fix` and `qualor stop` are kept for an automatic fixing of findings that does not exist yet,
and anyone gets the answer above.

- **Who may ask for a review:** the same members as for a status change (GitLab: Developer or more;
  GitHub: a role of triage or more). A refusal is still a posted note.
- **What it starts.** `qualor review` reviews the merge request's newest analysis when no review
  has run for it, or when the review ended without a result: it was skipped (for any reason but
  "unchanged"), failed or was replaced by a newer one. The summary says "AI review in progress…"
  at once.
- **A draft is reviewed when asked.** A push after it starts an ordinary review, which skips
  drafts: a draft needs a new `qualor review` after each push.
- **The snapshot is still needed.** A review that someone asked for reads the scanner's snapshot of
  that commit. Without one it waits 15 minutes for it and ends skipped again, and the summary says
  no snapshot came ([What the summary says](#what-the-summary-says)).
- **One review for each analysis.** However often it is written, an analysis has one review: a
  second note while it runs is answered "in progress", and one after it is done "has been
  reviewed". The day's budgets and **Tokens per review** apply as for any review.
- **In a monorepo,** every Qualor project that is mapped to the repository answers a command, so
  one note can get an answer for each project, and starts each project's review.
- **Qualor answers only where AI review is switched on for the project.** On a project without it,
  a command gets no answer at all.

### At once, or at the next analysis

Qualor finds new replies and commands in one of two ways:

- **A webhook** tells Qualor that someone commented. Qualor then reads the merge request's comments
  through the API (it never trusts the text in the webhook) and answers as soon as the model has
  decided. Set it up on [GitLab](./gitlab.md#answers-to-replies-and-commands-webhook) (the Comments
  events) or on [GitHub](./github.md#turn-on-the-webhook-recommended) (the Issue comment and Pull
  request review comment events, and the Issues permission).
- **The next analysis.** Without a webhook, Qualor looks at a merge request's comments each time it
  updates its own comments there: when the merge request is analysed again, when a review ends, when
  an issue's status changes in Qualor, and on GitHub when someone presses **Re-run**. A reply waits
  for that.

A webhook that fails does no harm. The next time Qualor updates the comments it finds the same
notes, and a note that both ways find is answered once.

Answers are made by the same worker as the reviews (`QUALOR_REVIEW_WORKER_CONCURRENCY`, 2 by
default). A free slot takes an answer before a waiting review, but an answer waits while every slot
is busy with a review.

### What replies cost, and who can ask

Anyone who can comment on the merge request can write a reply or a command, and on a public
repository that is anyone with an account. Several limits bound what they can spend:

- one reply uses at most 60 000 tokens, input and output of all its calls together;
- replies count in the day's budgets of AI review
  ([Budgets and today's usage](#budgets-and-todays-usage)). A day without room for a reply skips
  it, and Qualor offers it again on a later UTC day, as long as the note is not older than 30 days;
- `qualor review` costs one review, but only a member can ask for it, an analysis has one review
  however often it is asked for, and the day's budgets still apply;
- Qualor queues at most 50 replies and 20 commands of a merge request at a time. The rest wait for
  the next time it looks.

### What Qualor keeps

Each reply and command Qualor handles is one record: the ids of the note and of its thread, the SCM
user name of the person who wrote it, what came of it, the answer Qualor decided on (up to 1 200
characters), the model, and the tokens and cost of its calls. The text of the person's note is not
in it. Records are deleted 90 days after they are finished, and with their merge request or project.
Every call to the model is recorded as well ([How long copies live](#how-long-copies-live)).

## Re-reviews

Each new scan of a merge request is reviewed again, on its latest commit.

- **Only new changes raise new findings.** The scanner works out which lines changed since the last
  reviewed commit, and a re-review raises new findings only on those lines (and within three of
  them). When the last reviewed commit is no longer part of the branch, as after a rebase, the whole
  merge request counts as changed.
- **Earlier findings are checked wherever they are.** The judge is shown up to 50 findings of the
  earlier reviews, the open ones first, and says of each open one whether its problem is still in
  the code. One it is not shown stays as it is.
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
  `Tool calling (needed by AI review): supported` or `not supported`, with a line for each model
  when the provider has a strong or a fast model ([Model tiers](./ai-assistant.md#model-tiers)). It
  says nothing when it could not tell.
- **OpenAI's newest models need the Responses API.** They take function tools with reasoning only
  through OpenAI's Responses API, not through Chat Completions. `gpt-6.1-sol`, `gpt-5.6-terra` and
  `gpt-6-luna` are the ones this was checked with. For such a model choose **Responses** under
  **API** in **Settings → AI assistant**
  ([The provider](./ai-assistant.md#the-provider-instance-admins)). On Chat Completions the review
  fails with the message about tool calls above, and the Test tells you to choose Responses.
  Servers such as vLLM, Ollama and Azure deployments stay on Chat Completions.
- **Anthropic's current models** (Claude 4.7 and later) take no temperature, which Qualor never
  sends, and think before they answer. A key that belongs to the whole organisation and is not
  scoped to a workspace needs the **Workspace ID** (`wrkspc_…`) in the same settings. Without it the
  Test says "This key is not scoped to a workspace: give its workspace ID", and a review ends with a
  provider error (`PROVIDER_WORKSPACE_REQUIRED`, [below](#when-the-model-provider-fails)).
- **Small local models give weak reviews.** They miss problems, report others that are not there,
  and more often fail to answer in the form the review needs. Use a strong model for code.
- **Allow time.** A review's answers are long: a reviewer may write up to 12 288 tokens in one
  answer and the judge up to 16 384, and a reasoning model can think for minutes before it writes.
  So review and reply calls **stream**: the answer arrives in pieces, and a gateway that cuts a
  connection that sits idle does not cut a long answer. Qualor waits for the first piece, and then
  for each next one, as long as the timeout in the AI assistant settings (60 seconds by default, up
  to 600 seconds) or 5 minutes, whichever is longer, and a call has 15 minutes in all. That timeout
  is the whole wait of Explain, Suggest triage, Suggest a fix and the Test, which do not stream. A
  server that refuses a streamed request (a 400 that names `stream`) is asked again without
  streaming, and Qualor remembers that server address and model until the server restarts: their
  later calls are not streamed, and one line in the server log says so. A call that is not streamed
  waits at least 5 minutes for its whole answer. A server that ignores the request for a stream and
  sends its whole answer as JSON is read as it is.
  A review usually takes a few minutes, and a big merge request can take 15 or more. The summary
  says the review is in progress until it ends.
- **Room to think.** A model that thinks counts its thinking in the output limit, so a call asks for
  room beyond the answer's own tokens. It costs nothing unless the model uses it
  ([Budgets and today's usage](#budgets-and-todays-usage)).
- **A refusal fails that step.** A model can refuse a request, and Anthropic's and OpenAI's current
  models can do it inside an answer. Qualor reads it as an answer that could not be read: a
  reviewer's or a check's part is missing from the review and the summary says so, the judge's
  refusal fails the review, and a reply goes unanswered. Qualor never falls back to a model you did
  not choose.
- **The review writes in English**, whatever language your code and comments are in. An answer to a
  reply is written in the language of the person's last note.

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

Three other records hold something of a review:

- **The findings** are issues, kept like any issue. A closed one is deleted after 30 days.
- **Every call to the model** is recorded like an AI assistant request, with the feature `review`
  (a review's calls) or `review-reply` (the answers to replies), the model that call went to, the
  token counts, the estimated cost and a hash of what was sent, for 90 days. The server log has one
  line for each call, with no content: `AI review call finished`, and for a reply
  `AI review reply call finished`. If an instance admin switched on **Store the prompts sent**, the
  prompts are kept too, for the days set there (1 to 90, 7 by default), and what the model answered
  stays with the record. They can quote the code the model was shown, and for a reply what people
  wrote in the thread ([Retention and audit](./ai-assistant.md#retention-and-audit)).
- **The replies and commands Qualor handled**, one record each, for 90 days after they are
  finished ([What Qualor keeps](#what-qualor-keeps)).

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
by default, at most 8), so a review never delays an analysis or an answer of the AI assistant. The
answers to replies and commands run on it too, and take a free slot before a waiting review. Each
review, and each answer to a reply while the model decides, holds a masking worker that can use up
to 512 MiB of heap, so allow that many times the number of slots on top of what the server uses
otherwise: 1 GiB more at the default of 2. On a small server, set the variable to 1 (in the same
places as the two above).

Fixed limits: 1 MiB per file, 50 000 files, 256 KiB per diff and 64 MiB of diffs in all, 1 024
bytes per path.

## Budgets and today's usage

AI review has budgets of its own, separate from the AI assistant's budgets: one large review cannot
use up the day's explanations, and the reverse. They pay for the reviews and for the answers to
replies together. They are per organisation and per UTC day, and an organisation admin sets them
under **Budgets per day (UTC)** in **Settings → AI review**:

| Budget | Default | Meaning |
|---|---|---|
| Tokens per day | 2 000 000 | the most tokens (input and output) all the organisation's reviews and answers to replies may use in a day |
| Cost per day in US dollars | empty (no limit) | needs the models' prices, which the instance admin enters in the AI assistant settings: the standard model's, and a strong or fast model's own ([Model tiers](./ai-assistant.md#model-tiers)) |
| Tokens per project and day | empty (no limit) | the most tokens one project's reviews and answers may use in a day |
| Tokens per review | 300 000 | the most one review may use, from 1 to 10 000 000. An answer to a reply has its own limit of 60 000 tokens |

The **instance ceiling** belongs to the instance admin: **Settings → AI assistant**, field **AI
review: most tokens per organisation per day**. An organisation's tokens per day are the smaller of
its own value and the ceiling; **Settings → AI review** shows the ceiling next to the field. Empty
means no ceiling.

**Today's usage.** Under the heading of the budgets, **Settings → AI review** shows what the
organisation's reviews and answers to replies have used since UTC midnight, such as
`Today: 120,000 of 2,000,000 tokens · 3 reviews`, with `· $1.23` added when prices are set. The
budget in that line is the smaller of the organisation's tokens per day and the instance ceiling.
The tokens and the cost include the answers to replies; the number of reviews does not.
`GET /api/v0/organizations/{id}/ai/review` gives the same figures as `usage`
([API](#api)). Reviews that were skipped are not counted.

**How the budgets are enforced.** Before a review starts, Qualor works out what it may spend: the
smallest of Tokens per review, what the organisation has left of its day, what the project has left
of its day (when it has a budget), and what the cost budget has left at the dearest price of your
models: the highest price per token, input or output, among them, since the model of the next call
is not known ahead. When the day has nothing left, or too little for a review of this size, the
review is skipped and the summary says the day's token budget is spent. When Tokens per review itself is too little for a
merge request this large, the summary says that instead (see **Big merge requests** below).
Otherwise the review shares its tokens between its stages: 55 % for the reviewers, an equal part
each, 35 % for the judge and 10 % for the second check of security findings. A stage that has used
its share answers with what it has, and the summary says "The review reached its token limit, so it
may have missed problems." The limit is a ceiling Qualor works to, not a count to the token: it
stops asking the model when it expects the next answer not to fit, but it cannot know how long an
answer will be, so a review can end somewhat over it. The day's budget is checked as each review
starts, so reviews that start together, one on each worker slot (`QUALOR_REVIEW_WORKER_CONCURRENCY`
on each replica of the server), can each spend what was left: the day can end over its budget by up
to about (slots − 1) × Tokens per review.

**Answers to replies.** An answer asks the day for room before it starts, as a review does, with a
ceiling of 60 000 tokens in the place of Tokens per review. A day with nothing left, or with less
than the first call of the answer needs, skips it, and a later UTC day offers it again
([What replies cost, and who can ask](#what-replies-cost-and-who-can-ask)).

**Room to think.** A model that thinks counts its thinking in the output limit. So each call of a
review or of an answer to a reply asks for 16 000 output tokens more than the answer needs, and
Explain, Suggest triage, Suggest a fix and the Test for 4 000 more. The room costs nothing unless
the model uses it. Qualor plans a review's calls with the answer's own limit, so a call that thinks
can spend up to that room beyond what Qualor expected of it, and a review can end further over its
limit than it otherwise would. A model that refuses so large a limit, such as one with a smaller
output cap or a server with a small context window, is asked again, once, in the same call without
the room: Qualor does so after any refusal of such a call (a 400, or a 422 as Hugging Face TGI
answers), whatever its words, unless the refusal is about the workspace, tools, the Responses API
or streaming. When the second ask is answered, Qualor remembers that server address and model until
the server restarts, and asks without the room from then on. When the refusal is about a context
window that the prompt and the answer share, in the words of vLLM or Anthropic, nothing is
remembered: Qualor asks for the room again on every call, and asks again without it when the prompt
leaves none, so a vLLM with a small window pays one quick refusal on each call. OpenAI's Responses
API clamps a limit that is too large by itself, so nothing is asked again there.

**Big merge requests.** The reviewers get the changed code in their first message and read more with
their tools. At the default of 300 000 tokens per review, a merge request of about 80 changed files
or more gets no code in that first message, and its reviewers have room for fewer turns of reading.
From about 100 changed files it is not reviewed at all: the list of its changes alone would leave a
reviewer no room. Short paths let more files fit, and many analyzer findings on the changed files
fewer. The summary then says "AI review did not run because this merge request is too large for the
Tokens per review budget; raise it in the AI review settings." For big merge requests, raise
**Tokens per review** in **Settings → AI review** (to 600 000, say), and check that the day's budget
can pay for it. Mind the model's context window too, the most it reads in one call: the higher
Tokens per review, the longer one call of a review can grow, and raised far, a call can pass the
window. The provider then refuses the call, and the review fails with a provider error
(`PROVIDER_REJECTED_REQUEST`). Keep **Tokens per review** within what the model takes.

**How tokens are counted.** Tokens are the counts the provider reports. For a call that reports no
input count, Qualor counts a quarter of the bytes it sent, both in a review's ceiling and in today's
figure. An output count that the provider does not report is left out of today's figure, so a provider
that reports none makes it too low. A call the provider refused, did not take or could not be reached
for is not counted.

## What your CI needs

- **A scanner of the server's release.** A scanner from a release before AI review sends no
  snapshot, and its log says nothing about one. Pin the CI component
  ([GitLab](./gitlab.md#with-the-cicd-component-recommended)), the action
  ([GitHub](./github.md#2-the-workflow)) or the scanner image to the server's release.
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
| AI review did not run: no repository snapshot came for this commit. See the CI job’s log and the guide’s `fetch-depth` note. | The scanner sent no snapshot, or it took more than 15 minutes to arrive. Read the `AI review:` lines in the CI job's log ([the scan log](#the-scan-log)). A shallow clone, a pipeline that is not a merge request pipeline and a secret scan that did not finish are the usual causes ([What your CI needs](#what-your-ci-needs)). A log with no `AI review:` line at all comes from a scanner of a release before AI review (pin the CI component, the action or the scanner image to the server's release), or from a CI other than GitLab CI and GitHub Actions. A snapshot that arrives later starts the review again |
| AI review did not run: the server refused the repository snapshot of this commit. (`Reason: SNAPSHOT_INVALID`) | The server could not use the upload, or it was of another merge request. The server log names the reason. Run the job again to upload a new snapshot, and report it if it repeats |
| AI review is skipped while this merge request is a draft; the next pipeline after it is ready reviews it, and a `qualor review` note reviews it now. | Mark the merge request ready, then run the pipeline again, or write `qualor review` in a note to review the draft now. A push after that starts an ordinary review, which skips the draft again ([Commands](#commands)) |
| AI review did not run because this merge request is merged or closed. | Nothing to do |
| AI review is switched off for this project. (`Reason: …`) | The reason code says why: [Why AI review is off for a project](#why-ai-review-is-off-for-a-project) |
| AI review found nothing to review in the changed files. | Not an error. The merge request changes only files the review leaves out: lock files, generated or minified files, binary files and files on the AI assistant's **Never send these paths** list |
| AI review did not repeat: the changes it reviews are the same as in its last review, whose findings stay open. | Not an error. The push changed nothing the review reads |
| AI review did not run because its token budget for today is spent. | Wait for UTC midnight, or raise the budgets ([Budgets and today's usage](#budgets-and-todays-usage)). It also appears when what is left of the day is too little for a merge request of this size |
| AI review did not run because this merge request is too large for the Tokens per review budget; raise it in the AI review settings. | The list of its changes alone leaves a reviewer no room: at the default 300 000 tokens, from about 100 changed files. Raise **Tokens per review** in **Settings → AI review** ([Budgets and today's usage](#budgets-and-todays-usage)) |
| AI review failed: the model provider returned an error or could not be reached. The next push reviews again. | A call was refused, timed out, was rate limited or got no answer. Qualor tries a rate-limited call again twice and one that timed out once. The server log's `AI review call finished` lines give each call's error code and the provider's HTTP status: [the table below](#when-the-model-provider-fails) says what to do. Run **Test** in **Settings → AI assistant** to check the provider. With no such line for the review in the log, no call was made: the stored API key could no longer be read (`QUALOR_SECRET_KEY` changed; set the API key again in **Settings → AI assistant**), or calls to the provider were paused after repeated failures (`PROVIDER_UNAVAILABLE` below) |
| AI review failed: the model provider does not support the tool calls the review needs. The next push reviews again. | Use a model and a server that can call tools. **Test** in **Settings → AI assistant** shows `Tool calling (needed by AI review): not supported` for this one ([Models that work](#models-that-work)). With one of OpenAI's newest models, the cause is usually the API: choose **Responses** under **API** in **Settings → AI assistant**, and the Test says tool calling is supported |
| AI review failed: the model’s answers could not be read. The next push reviews again. | The judge did not answer in the form the review needs, even when asked again. Small models do this more often: try a stronger one |
| AI review failed because of an error in Qualor. The next push reviews again. | An unexpected error, or a stop of the server during the review (a review is not resumed). If it keeps happening with the server running, report it with the server log's `AI review run failed` line |
| The review reached its token limit, so it may have missed problems. | A stage used its share of the tokens. Raise **Tokens per review**, mainly for big merge requests ([Budgets and today's usage](#budgets-and-todays-usage)) |
| A reviewer’s answer could not be read, so part of the review is missing. | A reviewer did not answer in the form the review needs. The rest of the review is intact. Try a stronger model |
| There were more serious security findings than the review verifies, so the rest were not checked a second time. | Not an error. The second check covers five findings |
| The scanner left some files out of the repository snapshot to stay within its limits, so the review did not see all of them. | Raise the [snapshot limits](#size-limits-and-the-two-server-variables) |

A failed or skipped review is not tried again by itself. The next push reviews again, and so does
running the CI job again.

### Why a reply or a command was not answered

Qualor writes one line to the server log for each reply or command it handled: `AI reply ended`,
with `replyId` (the id of its record), `status` (`done`, `skipped` or `failed`), `outcome` and
`reason`. Nothing shows in the merge request when Qualor skips or fails a note, so start there. A
note with no such line was never taken up:

| Symptom | What to check |
|---|---|
| A reply gets no answer, and the log has no `AI reply ended` line for it | The note must be a reply Qualor answers ([Replies](#replies)): in an open thread whose first note is Qualor's own comment on a finding (not the summary), by a person (on GitHub not a bot, on GitLab not the user whose token Qualor uses), written after the confirmation of the warning and 30 days ago at most, in an open merge request. AI review must be switched on for the project ([Why AI review is off for a project](#why-ai-review-is-off-for-a-project)). Without a webhook the answer comes at the next analysis ([At once, or at the next analysis](#at-once-or-at-the-next-analysis)) |
| A command gets no answer | The first line of the note must start with `qualor review`, `qualor fix` or `qualor stop`, in a top-level note (on GitHub a comment on the pull request's page, not a review comment). AI review must be switched on for the project: on a project without it Qualor says nothing. The merge request needs an analysis by Qualor. Without a webhook the answer comes at the next analysis |
| On GitHub, `qualor review` is answered only at the next analysis | GitHub does not send the `issue_comment` event: the App lacks the Issues permission or the event, or the owner of an installation has not accepted the new permission ([GitHub](./github.md#update-an-app-you-created-before)) |
| On GitLab, replies and commands are answered only at the next analysis | there is no webhook on the project, its secret token differs (GitLab shows 401 under **Recent events**), **Comments** is not ticked, or GitLab cannot reach Qualor's address ([GitLab](./gitlab.md#answers-to-replies-and-commands-webhook)) |
| A reply is answered, but the finding stays open | The person may not change a status ([Who may change a status](#who-may-change-a-status)), the thread is an analyzer's or its issue is no longer open, the reply states no decision of priority and no claim that the code bears out, or the merge request had no snapshot to read the code from, which a false positive needs |
| A finding changed its status after a reply | A member wrote a decision of priority, or a claim that the code bore out. The issue's **History** has the comment that names the person, and a person can set the status back |

What `outcome` says, for a note that was handled (`status` `done`):

| `outcome` | What happened |
|---|---|
| `answered` | Qualor answered in the thread of an AI finding, and changed nothing |
| `acknowledged` | The model saw nothing to answer, such as a thank-you, so nothing was posted |
| `explained` | Qualor explained an analyzer's finding in its thread |
| `wont_fix` | The reply decided the finding's priority: it is marked won't fix, its thread is resolved, and the answer says so |
| `false_positive` | The code bore out the claim: the finding is marked false positive, and its thread is resolved |
| `review_requested` | `qualor review` started a review, and Qualor answered "Reviewing this commit" |
| `in_progress` | `qualor review` found a review of the commit waiting or running |
| `already_reviewed` | `qualor review` found the commit's review done, or the same as the last review |
| `not_available` | `qualor fix` or `qualor stop`, which do nothing yet, or a `qualor review` from someone who may not ask |
| `review_off` | `qualor review`, after AI review was switched off for the project |

What `reason` says, for a note that was skipped or that failed. Nothing is posted:

| `reason` | What it means, and what to do |
|---|---|
| `budget_spent` (skipped) | The day had no room for the answer. Qualor offers it again on a later UTC day, as long as the note is not older than 30 days. To answer sooner, raise the budgets ([Budgets and today's usage](#budgets-and-todays-usage)) |
| `inactive` (skipped) | AI review stopped covering the project while the note waited or the model decided: it was switched off, the project left the list or was unmapped, or the provider or one of its models changed and the confirmation is outdated ([Why AI review is off for a project](#why-ai-review-is-off-for-a-project)) |
| `closed` (skipped) | The merge request was merged or closed. Nothing to do |
| `thread_gone` (skipped) | The thread or the command's note was deleted, someone resolved the thread before Qualor answered, or the project is no longer mapped to that provider. Nothing to do |
| `superseded` (skipped) | A newer round in the same thread covers this one, and its answer reads these notes too |
| `provider_error` (failed) | The model could not be asked or gave no answer ([When the model provider fails](#when-the-model-provider-fails)). The log has an `AI review reply call finished` line for each call, with its error code |
| `provider_no_tools` (failed) | The model's server refuses tool calls ([Models that work](#models-that-work)). With one of OpenAI's newest models, choose **Responses** under **API** in **Settings → AI assistant** |
| `bad_answer` (failed) | The model's answer could not be read, or it named a status the thread does not allow, even after a second try. Nothing is posted, on purpose. A stronger model fails less often |
| `internal` (failed) | An unexpected error in Qualor, or something that cannot be answered: the SCM connection can no longer be used (its token no longer decrypts after `QUALOR_SECRET_KEY` changed, or its address is no longer allowed), the issue is no longer the project's, or the merge request has no analysis to review. The log's `AI reply not answered:` line or `AI reply failed on its last try` line says which |

A note that was skipped or failed is not tried again, except `budget_spent`. A later reply in the
same thread is a new round that reads the earlier notes too.

### When the model provider fails

A review that failed with a provider error has an `AI review call finished` line in the server log for
each call, with its status and, for a call that failed, its error code:

| Error code in the log | What to do |
|---|---|
| `PROVIDER_TIMEOUT` | The model sent nothing for as long as a review call waits, or the call went past its limit. A review or reply call waits for its first piece, and between two pieces, as long as the timeout in the AI assistant settings or 5 minutes, whichever is longer, and a call has 15 minutes in all. A slow local model may need more time: raise the timeout in **Settings → AI assistant**, up to 600 seconds |
| `PROVIDER_RATE_LIMITED` | The provider's own limit. Qualor waited as the provider asked and tried twice. Review again later, or lower the budgets |
| `PROVIDER_REFUSED_KEY` | Set a valid API key, and check the key header (`api-key` for Azure) |
| `PROVIDER_REJECTED_REQUEST` | The provider refused the request: check the base URL, the model's name and the output limit field ([AI assistant: Troubleshooting](./ai-assistant.md#troubleshooting)) |
| `PROVIDER_BAD_ANSWER` | The provider answered, but not in a form Qualor could read: the address is not a chat completions, Responses or Anthropic Messages API, or the answer was over 1 MiB. Check the base URL and the **API** setting ([AI assistant: Troubleshooting](./ai-assistant.md#troubleshooting)) |
| `PROVIDER_WORKSPACE_REQUIRED` | An Anthropic key that belongs to the whole organisation is not scoped to a workspace. Enter its workspace ID (`wrkspc_…`) in **Settings → AI assistant**. The call is not retried |
| `URL_NOT_ALLOWED` | The provider's address is no longer allowed: the operator lists its host, with its port, in `QUALOR_LLM_INTERNAL_HOSTS`, or the instance admin uses an `https` address that resolves to public addresses ([AI assistant: Troubleshooting](./ai-assistant.md#troubleshooting)) |
| `PROVIDER_UNAVAILABLE` | The provider could not be reached, answered with a server error, or failed or closed the connection while it was answering (a stream that ended early). Check the base URL and the network. After five failures in a row Qualor pauses calls to that address for 10 minutes, and a review that starts then fails at once, with no call in the log |

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
| `consent_outdated` | The provider, or one of its models (a strong or a fast model counts), changed. An organisation admin presses **Confirm again** |
| `project_not_selected` | Add the project to **Projects to review**. If the instance admin excluded it from the AI assistant, it is never reviewed |
| `not_mapped` | Map the project to its GitLab or GitHub repository ([GitLab](./gitlab.md), [GitHub](./github.md)) |
| `provider_changed` | The instance admin changed the provider, or one of its models, while a review was running, and the confirmation covers the new setup. The review stopped. The next push is reviewed with the new provider |

## API

An organisation admin's settings page uses these endpoints, so you can script the same steps:

- `GET /api/v0/organizations/{id}/ai/review` returns the settings, the warning (`notice`), the
  provider (`provider.host`, `provider.model` and `provider.models`: every model it uses, once each
  and sorted), `consentCurrent`, the instance ceiling (`instanceCeiling.tokensPerDay`) and today's
  use of the organisation (`usage`: `tokensToday`, `reviewsToday` and `costTodayUsd`, which is
  `null` while no prices are set).
- `PUT /api/v0/organizations/{id}/ai/review` sets `enabled`, `scope` (`all` or `selected`),
  `projectIds` and `budgets`, and answers with the same fields. To switch AI review on, or to
  confirm it again, add `acknowledgeDataSharing: { host, model, models }`, copied from the
  `provider` of the `GET` answer.

A finding is an issue of the engine `ai`: `GET /api/v0/issues?branchId=…&engine=ai` lists them, and
`GET /api/v0/issues/{id}` gives them `aiReview` (`category`, `body`, `assumption`, `verification`,
`suggestion` and `reviewedCommit`), which is `null` for every other issue. `POST
/api/v0/system/llm/test` (instance admins) tests every model of the provider at once. It answers
`toolCalling` (`supported`, `not_supported` or `not_checked`) and `hint` (`USE_RESPONSES_API`, or
`null`) for the standard model, and `models`: one entry for each model with its `tier`, `model`,
`ok`, `reportedModel`, `latencyMs`, `toolCalling`, `problem` and `hint`.

Errors: `AI_DISABLED` (409: no provider, or the organisation is not enabled for the AI assistant),
`AI_REVIEW_CONSENT_REQUIRED` (409: switching on without the acknowledgement),
`AI_REVIEW_PROVIDER_CHANGED` (409: the provider's host, model or set of models changed since you
read the warning; nothing is stored, read the `GET` answer again) and
`PROJECT_NOT_IN_ORGANIZATION` (422: a project of another organisation). The scanner itself uses `GET /api/v0/projects/review-context` and
`POST /api/v0/analyses/{id}/review-snapshot` with the project's analysis token. Their errors are
`AI_REVIEW_OFF`, `SNAPSHOT_EXISTS`, `SNAPSHOT_TOO_LARGE`, `SNAPSHOT_INVALID` and
`ANALYSIS_NOT_FOUND`.
