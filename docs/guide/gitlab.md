# GitLab

Qualor works with GitLab.com and self-managed GitLab. Setup has two parts:

1. **The CI job** runs `qualor scan`, uploads the analysis and fails the pipeline when the quality gate
   fails. That is enough to block bad merge requests.
2. **The connection (optional, recommended)** lets the Qualor server comment on merge requests. It
   posts one summary comment, one discussion per new issue on a changed line, and a commit status
   `qualor/<project key>`. A webhook (also optional) lets Qualor answer replies to its comments, and
   `qualor review` notes, at once ([AI review](./ai-review.md#replies-and-commands)).

## Before you start

- A running Qualor server that the runners can reach over HTTPS ([Install the server](./install-server.md)).
- Runners that can pull `qualor/scanner` from Docker Hub, or your own copy of it
  ([Images](./install-server.md#images)).
- A project in Qualor whose key is the GitLab project path (`group/subgroup/app`), and a token. A
  project analysis token is best ([Tokens](./users-projects-tokens.md#tokens)).

## 1. CI/CD variables

In GitLab, under **Settings → CI/CD → Variables** of the project (or of a group, for many projects at
once):

| Variable | Value | Flags |
|---|---|---|
| `QUALOR_URL` | `https://qualor.example.com` | — |
| `QUALOR_TOKEN` | the token | **Masked**, and **not** Protected |

The token must not be *protected*. GitLab gives protected variables only to pipelines of protected
branches, so merge request pipelines would get no token.

A group-level token has to be a personal token with **Upload analyses**, because a project token
uploads to one project only. If the token's user is an org admin, Qualor creates missing projects on
their first upload.

## 2. The CI job

### With the CI/CD component (recommended)

Qualor is in the GitLab CI/CD catalog as [`gitlab.com/qualor/qualor`](https://gitlab.com/qualor/qualor).
On GitLab.com:

```yaml
# .gitlab-ci.yml
include:
  - component: gitlab.com/qualor/qualor/qualor@0.11
    inputs:
      image-tag: '0.11'
```

**Self-managed GitLab** can include components only from its own instance, never from
`gitlab.com/...`. Copy the component into a project of your instance, for example `tools/qualor`:

1. An administrator allows the import source once: **Admin → Settings → General → Import and export
   settings**, tick **Repository by URL**. A new instance has it turned off.
2. **New project → Import project → Repository by URL**, with
   `https://gitlab.com/qualor/qualor.git`, at `tools/qualor`.
3. Include the component by its full version tag:

```yaml
include:
  - component: $CI_SERVER_FQDN/tools/qualor/qualor@0.11.0
    inputs:
      image-tag: '0.11.0'
      # image: mirror.acme.internal/qualor/scanner   # your own copy of the image, without the tag
```

On GitLab Free and Community Edition, the import is a one-time copy: to get a new release, import
again or push its tag to the copy. Pull mirroring (**Settings → Repository → Mirroring
repositories**) keeps the copy up to date on its own, but needs GitLab Premium.

A short version such as `@0.11` resolves only in a CI/CD catalog project with releases. To use it on
your instance, turn on **Settings → General → Visibility → CI/CD Catalog project** in the copy, then
run a pipeline for the release tag (**Build → Pipelines → Run pipeline**). That pipeline creates the
release the catalog needs; an import alone runs none.

Pin the component and the image to the same release. Use a full version (`@0.11.0`,
`image-tag: '0.11.0'`) where every pipeline must run exactly the same analyzers.

The job runs in merge request pipelines and on the default branch. It uploads the analysis, fails
with the quality gate, and keeps GitLab's **Code Quality**, **SAST** and **Dependency Scanning**
reports as artifacts. Findings then show in the merge request widget and in the security tab. The SAST
and Dependency Scanning widgets need GitLab Ultimate. The Code Quality report works on every tier.

| Input | Default | Meaning |
|---|---|---|
| `image-tag` | required | the scanner image tag, such as `0.11` or `0.11.0` |
| `image` | `qualor/scanner` | the scanner image, without the tag |
| `stage` | `test` | the stage of the job |
| `job-name` | `qualor` | the job's name |
| `args` | empty | extra `qualor scan` arguments, for example `--sarif osv.sarif` |
| `allow-failure` | `false` | let the pipeline pass when the gate fails (a soft rollout) |
| `dotnet` | `false` | C#: run `qualor dotnet begin`, the build, then `qualor dotnet end` |
| `build-command` | `dotnet build --no-incremental` | the build that runs between `begin` and `end` when `dotnet` is true |

The component runs `qualor scan` from the repository root. If your project needs dependencies
installed (JavaScript/TypeScript) or a build (Java) first, use the job below instead, or extend the
component's job with a `before_script`:

```yaml
qualor:            # the component's job-name
  before_script:
    - npm ci
```

### Without the component

```yaml
qualor:
  stage: test
  image: { name: qualor/scanner:0.11, entrypoint: [''] }
  variables: { GIT_DEPTH: 0 }        # full history: new code is computed from git
  script:
    - npm ci                          # JS/TS: ESLint runs from node_modules. Java: build first.
    - >-
      qualor scan
      --gitlab-code-quality gl-code-quality-report.json
      --gitlab-sast gl-sast-report.json
      --gitlab-dependency-scanning gl-dependency-scanning-report.json
  artifacts:
    when: always
    reports:
      codequality: gl-code-quality-report.json
      sast: gl-sast-report.json
      dependency_scanning: gl-dependency-scanning-report.json
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

- `entrypoint: ['']` is needed because the image's entrypoint is `qualor`, and GitLab needs a shell.
- `GIT_DEPTH: 0` gives the job the full history. With a shallow clone, the CLI tries to fetch the
  baseline. If that fails, new-code conditions end in `error`, and Qualor fails the gate rather than
  guessing. [AI review](./ai-review.md#what-your-ci-needs) needs the full history too: the snapshot
  of a merge request is built from its last commit and the point where its branch left the target
  branch.
- Use **merge request pipelines** (`merge_request_event`). Only in them does the CLI know the target
  branch, and the analysis becomes a merge request analysis.

A C# project uses `qualor/scanner-dotnet` and wraps its own build. See
[Languages and analyzers](./languages-and-analyzers.md#c).

Go: run `go mod download` before `qualor scan` in the same job (see
[Languages and analyzers](./languages-and-analyzers.md#go-staticcheck-go-vet-gosec)).

## 3. Merge request comments and commit status

In Qualor, an **org admin** opens **Settings → GitLab**:

1. **New connection** opens the **New GitLab connection** dialog. Enter the GitLab address
   (`https://gitlab.example.com`; a path such as `/gitlab` is allowed) and an access token:
   - scope **`api`** and role **Maintainer**. Developer is enough for the merge request comments,
     but GitLab refuses a Developer's commit status on a protected branch, such as the default
     branch;
   - best, a **project access token** of the GitLab project, because it can reach nothing else. For
     many projects, use a **group access token**, or a personal token of a dedicated bot user. Never
     use a person's own token: every comment would carry their name, and with
     [AI review](./ai-review.md#replies-and-commands) Qualor would take that person's replies for
     its own notes and not answer them.
2. In **Settings → Repositories**, pick the connection for each Qualor project and enter the GitLab
   project: its numeric id or its full path `group/project`, then **Save**. **Check** tests that the
   token can see the project; it also warns when the token's role is below Maintainer.
3. Ask the server operator to set `QUALOR_PUBLIC_URL` so that comments link back to Qualor.

**Self-managed GitLab on an internal network.** The server calls only hosts that resolve to public
addresses, unless the operator allows the host explicitly:

```sh
QUALOR_SCM_INTERNAL_HOSTS=gitlab.corp.example.com            # https on 443
QUALOR_SCM_INTERNAL_HOSTS=gitlab.corp.example.com:8443,10.0.0.12
```

If GitLab's certificate comes from a private CA, give the server that CA with `NODE_EXTRA_CA_CERTS`.

### What reviewers see

- A **commit status** `qualor/<project key>`: *success* when the gate passes, *failed* with the failed
  conditions otherwise. It is posted for every analysed branch, not only for merge requests.
- **One summary comment** per merge request, edited in place on every analysis. It holds the
  verdict, a table of every gate condition with its value and the value it requires (conditions the
  gate skipped are listed with the reason), the count of new issues by severity, the ten most severe
  ones with their rule (linked to the rule's documentation) and a link to each in Qualor, and a link
  to the branch in Qualor. GitLab lets only a comment's author edit it, so after the token is
  replaced by one of another user, Qualor posts a new summary and deletes the old one. With a token
  below Maintainer the old summary stays; delete it by hand.
- **A discussion on each new issue** that sits on an added line, up to 50 per merge request, with
  the rule's key linked to its documentation. Qualor resolves the discussion when the issue is
  fixed or marked in Qualor, and reopens it if the issue comes back. It never reopens a thread a
  person resolved. A reply by a person also stops Qualor from resolving the thread: when its issue
  is fixed, Qualor writes one note in it instead, "Fixed in `<sha>`", with the commit, and leaves
  it open. Qualor still reopens a thread it resolved itself.
- Marking an issue **false positive** or **won't fix** in Qualor re-evaluates the gate right away, with
  no new scan. If that was the only new issue, the status turns green and the thread is resolved
  (unless a person replied in it).
- **AI review**, when an organisation admin switched it on for the project
  ([AI review](./ai-review.md)). The summary comment gains an **AI review** section, and each finding
  of high or medium severity gets a discussion on its line, **up to 20 per merge request, beside the
  50 above**. A finding whose fix is a replacement of lines the merge request added comes with a
  GitLab suggestion (`suggestion:-0+N`: the line of the discussion and the N lines below it), which a
  person applies with **Apply suggestion**. Qualor resolves, reopens and leaves these discussions as
  it does the others. The token needs no extra scope.
- **Answers to replies and commands**, with AI review switched on for the project. Qualor answers a
  person's reply in one of its discussions, from an analyzer or from AI review, and a reply to an
  AI finding can mark it won't fix or false positive and resolve the discussion. A note that starts
  with `qualor review` gets an answer in its own discussion
  ([Replies and commands](./ai-review.md#replies-and-commands)). A webhook makes this immediate
  (below); without one the answer comes at the next analysis.

In a **merged-results or merge-train pipeline**, the job analyses the merge commit, whose line
numbers are not the merge request's. The analyzers' discussions are then not created, and the
summary says so. AI review's discussions are still posted: its snapshot is built from the merge
request's own last commit, and a discussion is created only while the merge request is still at the
commit the review read.

One run of Qualor's comments makes at most 400 requests to GitLab. It creates discussions for at most
50 of the analyzers' issues and 20 of AI review's findings, the most severe first, and resolves or
reopens at most 200 discussions. The summary and the commit status are always written. Whatever is
left waits for the branch's next analysis.

Everything a comment quotes from the code is put in code spans. No snippet, no rule text and no link
that the report controls reaches GitLab, except a rule's documentation link on its key, and only
when it is a plain `https://` address. The words of AI review's discussions are model text: Qualor
puts every word that could link, mention or reference something in code spans too.

### Answers to replies and commands (webhook)

With [AI review](./ai-review.md) switched on for a project, Qualor answers a person's reply in one of
its discussions, and a note that starts with `qualor review`
([Replies and commands](./ai-review.md#replies-and-commands)). Without a webhook it does so at the
next analysis of the merge request. A webhook makes the answer come at once. It is optional.

1. In Qualor, open **Settings → GitLab**. On the connection, open **Webhook secret**, type a secret of
   16 to 256 printable ASCII characters without spaces (`openssl rand -hex 32` makes a good one)
   and press **Set the webhook secret**. The connection then shows its **Webhook URL**:
   `https://qualor.example.com/api/v0/gitlab/webhooks/<connection id>`. The URL needs
   `QUALOR_PUBLIC_URL` on the server.
2. In GitLab, open the project's **Settings → Webhooks** (you need the Maintainer role) and add a
   webhook: paste the URL, paste the secret as the **Secret token**, tick **Comments** and nothing
   else, and save. Add the same webhook, with the same URL and secret, to every GitLab project of
   this connection that has AI review.

GitLab sends an event for each comment. Qualor takes only the merge request from it: the text of a
delivery is never used. It reads the merge request's comments through the API, as a scan does, and
answers what it finds there. What Qualor checks of a delivery is its `X-Gitlab-Token` header, the
secret token, and its `X-Gitlab-Event` header: it reads only a `Note Hook` and answers any other
event with 204, unread. A delivery that GitLab sends again with the same idempotency key
(`Idempotency-Key`) is answered 204 and ignored. A proxy in front of Qualor must pass these headers
on unchanged.

GitLab has to be able to reach the URL from where it runs. GitLab.com cannot reach a Qualor that is
only on a private network, and a self-managed GitLab refuses to send a webhook to a private address
until its admin allows requests to the local network from webhooks (**Admin area → Settings →
Network → Outbound requests**). A delivery that GitLab could not make shows as a failed one under
the webhook's **Recent events**.

GitLab counts any 4xx or 5xx answer, and a timeout, as a failure: it backs a webhook off after four
failures in a row, and disables it after forty. So Qualor answers every delivery that GitLab really
made with 204, whatever it does with it: an event it does not read, a project or a merge request it
does not know, a project without AI review. Only a delivery that cannot be GitLab's gets an error: a
wrong or missing secret token is 401 (429 after 60 wrong ones in a minute from one address), an
unknown connection or one without a secret is 404, and a body that is not JSON is 400 (415 when its
content type is not JSON). If the webhook's **Recent events** in GitLab show those, fix the URL or
the secret. Two more answers can reach a real delivery: 413 for a body over 1 MiB (a very long
comment), and 500 for a failure inside Qualor. GitLab counts both as failures, and the comments
are then answered at the next analysis. A webhook that GitLab disabled has to be enabled again in
GitLab.

GitLab 19 can sign deliveries with a signing token, and says the secret token is not recommended for
new webhooks. Qualor reads the secret token, which every version of GitLab sends: use the **Secret
token** field. The signing token is not supported yet.

## 4. Block merges on the gate

Either:

- keep the job's default `allow_failure: false` and turn on **Settings → Merge requests → Pipelines
  must succeed**; or
- keep the pipeline green (`allow-failure: true` during a soft rollout) and rely on the commit status
  as information.

If you also turn on **All threads must be resolved**, Qualor's open discussions block the merge,
also those on issues that pass the gate and the open discussions of [AI review](./ai-review.md).
Qualor resolves a discussion when its issue is fixed or marked in Qualor (unless a person replied in
it: for a fixed issue, Qualor then writes one note in it, "Fixed in `<sha>`"), and a person can
resolve it too.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Exit 5 | the token is wrong, revoked, or of another project |
| `new code unavailable`, gate `error` | shallow clone: set `GIT_DEPTH: 0` |
| The analysis appears as a branch, not a merge request | the job ran in a branch pipeline. Use `merge_request_event` rules |
| No comments | no connection or mapping, `QUALOR_SCM_INTERNAL_HOSTS` missing, or the token lacks the `api` scope. **Check** on **Settings → Repositories** says which |
| No discussions from the analyzers in a merge request, and the summary says "The analyzers’ issues are not commented inline" | the pipeline was a merged-results or merge-train pipeline. The analyzers' discussions need a pipeline of the merge request's own commits; AI review's discussions are not affected |
| No **AI review** section in the summary | AI review is not switched on for the project ([Why AI review is off for a project](./ai-review.md#why-ai-review-is-off-for-a-project)), or the pipeline was not a merge request pipeline |
| No discussion on an AI finding | the section says what became of the review ([What the summary says](./ai-review.md#what-the-summary-says)). A finding of low severity without a suggested change gets none, nor one past the 20, nor one the review made for a commit the merge request has since moved past |
| Replies and `qualor review` notes are answered only at the next analysis | the connection has no webhook secret (**Settings → GitLab** says so), the GitLab project has no webhook with **Comments** ticked, its secret token differs from Qualor's (GitLab's **Recent events** for the webhook show 401), GitLab cannot reach the URL (**Recent events** shows a failed delivery), or GitLab disabled the webhook after repeated failures ([Answers to replies and commands](#answers-to-replies-and-commands-webhook)) |
| A reply or a `qualor review` note gets no answer at all | [AI review: Why a reply or a command was not answered](./ai-review.md#why-a-reply-or-a-command-was-not-answered) |
| Comments on merge requests, but no commit status on the default branch | the token's role is below Maintainer, and the branch is protected. Give the token the Maintainer role |
| `@0.11` component not found on self-managed GitLab | the copy is not a CI/CD catalog project with a release. Use `@0.11.0`, or see the steps above |
| Comments but no links | `QUALOR_PUBLIC_URL` is not set on the server |

More in [Troubleshooting](./troubleshooting.md).
