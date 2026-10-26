# GitHub

Qualor works with GitHub.com, GHE.com and GitHub Enterprise Server 3.9 or later. Setup has two parts:

1. **The Actions workflow** (the Qualor Action) runs `qualor scan`, uploads the analysis and fails the check when the
   quality gate fails.
2. **A GitHub App (optional, recommended)** lets the Qualor server post a check run
   `qualor/<project key>`, a review comment on each new issue on the changed lines, and one summary
   comment per pull request. Its **Re-run** button re-decorates. With the App's webhook, Qualor also
   answers replies to its comments, and `qualor review` comments, at once
   ([AI review](./ai-review.md#replies-and-commands)).

The workflow itself needs no GitHub write permission. The App posts everything.

## Before you start

- A running Qualor server that GitHub's runners (or your self-hosted runners) can reach over HTTPS.
- Runners that can pull `qualor/scanner` from Docker Hub (the Action does), or your own copy of it
  ([Images](./install-server.md#images)).
- A Qualor project whose key is `owner/repo`, and a project analysis token
  ([Tokens](./users-projects-tokens.md#tokens)).

## 1. Variables and secret

In the repository (or the organisation) go to **Settings → Secrets and variables → Actions** and add:

| Kind | Name | Value |
|---|---|---|
| Variable | `QUALOR_URL` | `https://qualor.example.com` |
| Secret | `QUALOR_TOKEN` | the token |

Only if you run [your own image or a mirror](#without-the-action-your-own-image-or-a-mirror), add the
variable `QUALOR_SCANNER_IMAGE` with `qualor/scanner:0.11`, or a full version such as
`qualor/scanner:0.11.0` (for C#, `QUALOR_SCANNER_DOTNET_IMAGE` with `qualor/scanner-dotnet:0.11`).

## 2. The workflow

Use the Qualor Action,
[`qualor-dev/scan-action`](https://github.com/qualor-dev/scan-action). After the checkout, one step
scans, uploads and fails when the quality gate fails:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    persist-credentials: false
    ref: ${{ github.event.pull_request.head.sha || github.sha }}
- uses: qualor-dev/scan-action@v0.11
  with:
    server-url: ${{ vars.QUALOR_URL }}
    token: ${{ secrets.QUALOR_TOKEN }}
```

The complete workflow, saved as `.github/workflows/qualor.yml`:

```yaml
name: qualor
on:
  pull_request:
  push:
    branches: [main]          # your default branch
permissions:
  contents: read
jobs:
  qualor:
    # Pull requests from forks get no secrets, so they are skipped.
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      # Install dependencies (JS/TS, Go) or build (Java) here, before the scan.
      - uses: qualor-dev/scan-action@v0.11
        with:
          server-url: ${{ vars.QUALOR_URL }}
          token: ${{ secrets.QUALOR_TOKEN }}
```

The project key defaults to the repository (`owner/repo`). Inputs:

| Input | Default | Description |
|---|---|---|
| `server-url` | required | your Qualor server |
| `token` | required | a project analysis token, from a secret |
| `project-key` | | the project key. Default: `project.key` in `qualor.yml`, else `owner/repo` |
| `config` | | the path of `qualor.yml`, when it is not at the repository root |
| `wait` | `true` | wait for the quality gate and fail the step when it fails. `false` uploads and passes |
| `args` | | more `qualor scan` options separated by spaces, for example `--sarif osv.sarif` |

The step fails when the gate fails, when an analyzer that `qualor.yml` marks as required fails, or
when the upload is refused (a wrong or revoked token). It needs a Linux runner with Docker
(`ubuntu-latest` or self-hosted). The scanner cannot write into the checkout, so an option that
writes a file (such as `--output`) needs a path under `/tmp`.

The action's version follows Qualor's: `@v0.11.0` runs `qualor/scanner:0.11.0`, `@v0.11` follows
the 0.11 patch releases and `@v0` the latest release. Pick the version that matches your Qualor
server, or pin a full version to control every update.

Why it looks like this:

- It checks out the **pull request's head**, not GitHub's merge commit, so the review comments on the
  analyzers' issues land on the pull request's own lines. After a checkout of the merge commit (what
  `actions/checkout` does by default) there are no review comments for the analyzers' issues, and the
  summary says so. The comments of [AI review](./ai-review.md) are still posted: its snapshot is built
  from the pull request's head commit, which the scanner fetches from `origin` by its id when the
  checkout lacks it ([What your CI needs](./ai-review.md#what-your-ci-needs)).
- `fetch-depth: 0` gives the full history, from which new code is computed. AI review needs it too:
  its snapshot holds the pull request's changes against the point where the branch left the target
  branch.
- `persist-credentials: false` keeps the job's GitHub token out of `.git/config`, where the analysed
  code could read it.
- Pull requests **from forks are skipped**. GitHub gives them no secrets. Never switch to
  `pull_request_target`, which would run a fork's code with your token.

Go: run `go mod download` before the Qualor step in the same job (see
[Languages and analyzers](./languages-and-analyzers.md#go-staticcheck-go-vet-gosec)).

### C#

Qualor analyses C# inside your build, so use the `dotnet` action. It runs `qualor dotnet begin`, your
build and `qualor dotnet end` in the `qualor/scanner-dotnet` image:

```yaml
- uses: qualor-dev/scan-action/dotnet@v0.11
  with:
    server-url: ${{ vars.QUALOR_URL }}
    token: ${{ secrets.QUALOR_TOKEN }}
    build-command: dotnet build MySolution.sln --no-incremental
```

It takes the same inputs plus `build-command` (default `dotnet build --no-incremental`; keep
`--no-incremental`). When the build fails, nothing is uploaded. The token goes to `qualor dotnet end`
only, but the build runs your repository's code in the same container as the upload and could read
it; if that is not acceptable, use the template
[`integrations/github/qualor-dotnet.yml`](../../integrations/github/qualor-dotnet.yml), which keeps
the token in a separate step. See [Languages and analyzers](./languages-and-analyzers.md#c).

### Without the Action (your own image or a mirror)

To run your own copy of the scanner image (a private registry or a mirror), copy
[`integrations/github/qualor.yml`](../../integrations/github/qualor.yml) to
`.github/workflows/qualor.yml`. Copy the whole file, not only the job: it also sets the triggers and
`permissions: { contents: read }`. It needs the variable `QUALOR_SCANNER_IMAGE` from step 1.

```yaml
name: qualor
on:
  pull_request:
  push:
    branches: [main]          # your default branch
permissions:
  contents: read
jobs:
  qualor:
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    container:
      image: ${{ vars.QUALOR_SCANNER_IMAGE }}
      options: --user 1001
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      # Install dependencies (JS/TS) or build (Java) here, before the scan.
      - run: qualor scan
        env:
          QUALOR_URL: ${{ vars.QUALOR_URL }}
          QUALOR_TOKEN: ${{ secrets.QUALOR_TOKEN }}
```

The checkout is the same as above. `--user 1001` runs the container as the runner's user, so the
checkout is writable. If your image is in a private registry, add `credentials` to `container:` (for
GHCR: `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`, plus `packages: read`
in `permissions`). For C#, copy `integrations/github/qualor-dotnet.yml` instead and replace its
build step with your own.

## 3. The GitHub App

### Create it

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**, in the organisation
that owns the repositories. You can also register it from the manifest
[`integrations/github/app-manifest.json`](../../integrations/github/app-manifest.json).

| Setting | Value |
|---|---|
| Repository permissions | **Checks: Read and write**, **Contents: Read and write**, **Issues: Read-only**, **Metadata: Read-only**, **Pull requests: Read and write**. Nothing else |
| Subscribe to events | **Check run** (the Re-run button), **Issue comment** and **Pull request review comment** (answers to replies and commands at once) |
| Webhook | inactive for now. You activate it in step 3 |
| Where can it be installed | Only on this account |

Qualor uses **Contents: Read and write** only to resolve and reopen its own review conversations:
GitHub lets an App do that only with this permission.

Then **generate a private key** (a `.pem` file) and note the **App ID**. **Install** the App on the
repositories Qualor should decorate.

### Connect it to Qualor

In Qualor, an **org admin** opens **Settings → GitHub → New GitHub App**:

- **API address**: `https://api.github.com` for GitHub.com, `https://api.<subdomain>.ghe.com` for
  GHE.com, or `https://<host>/api/v3` for GitHub Enterprise Server.
- **App id** and **Private key**: paste the `.pem` file, or choose it. Use the unencrypted RSA key
  that GitHub generated.
- **Webhook secret** (optional): a random value such as `openssl rand -hex 32`. It is needed for the
  webhook ([below](#turn-on-the-webhook-recommended)): the Re-run button, and answers to replies and
  commands at once.

Then, in **Settings → Repositories**, pick the GitHub connection for each project, enter the
repository as `owner/repo` and **Save**. **Check** tests that the App is installed there and has the
permissions it needs. On **Settings → GitHub**, the App's **Test** with a repository also lists
what the App lacks of the rest: **Contents: Read and write**, **Issues: Read-only** and each of the
three events, with what each one costs. The test still passes: Qualor works without them, with
less.

### Turn on the webhook (recommended)

With a webhook secret saved and `QUALOR_PUBLIC_URL` set on the server, Qualor shows the webhook URL:
`https://qualor.example.com/api/v0/github/webhooks/<connection id>`. On the App's settings page, paste
that URL and the same secret, keep the content type **application/json**, and activate the webhook.
The App must subscribe to three events ([Create it](#create-it)), and Qualor acts on each:

- **Check run**: the **Re-run** button of Qualor's check run decorates the pull request again.
- **Issue comment** and **Pull request review comment**: when a person comments on a pull request,
  Qualor reads the pull request's comments and answers a reply in one of its threads, or a
  `qualor review` comment, at once ([AI review: Replies and commands](./ai-review.md#replies-and-commands)).
  Without these two events it answers at the next analysis of the pull request, or when someone
  presses **Re-run**.

Qualor takes only the repository, the pull request, the action and whether the author is a person or
a bot from an event, never the text of the comment: it reads the comments through the API. A comment
of a bot, Qualor's own App included, starts nothing.

The **Issues: Read-only** permission is there because GitHub sends `issue_comment` only to an App
that can read issues. It is how Qualor is told of a pull request's comments as they are written, for
`qualor review`. Qualor reads and writes the comments with the Pull requests permission that the App
already has.

Whether a person may change a finding's status with a reply, or ask for a review, depends on their
role in the repository: admin, maintain, write or triage, or a custom role whose legacy permission
(GitHub's `permission` field) is `admin` or `write`. Qualor reads it from GitHub's collaborator
permission API, which needs only the Metadata permission
([Who may change a status](./ai-review.md#who-may-change-a-status)).

GitHub Enterprise Server on an internal network needs its host in `QUALOR_SCM_INTERNAL_HOSTS` on the
server, and a private CA needs `NODE_EXTRA_CA_CERTS`.

### Update an App you created before

An App created before keeps the permissions and events it had. To give it **Contents: Read and
write**, which Qualor uses only to resolve and reopen its own review conversations, and to turn the
comment events on:

1. On GitHub, open the App's settings (**Settings → Developer settings → GitHub Apps**, your App,
   **Edit**) and go to **Permissions & events**. Under **Repository permissions** set **Contents**
   to **Read and write** and **Issues** to **Read-only**. Under **Subscribe to events** tick
   **Issue comment** and **Pull request review comment**, and keep **Check run**. Save the changes.
2. GitHub then asks the owner of each installation of the App to accept the new permissions. The
   owner of the organisation or the account the App is installed on gets a request, and accepts it
   on the installation's page. Until then Qualor's conversations stay open after a fix or a won't
   fix (the summary says how many), and GitHub sends no `issue_comment` event for that
   installation, so a `qualor review` comment is answered at the next analysis of the pull request
   or at the next press of **Re-run**. Replies in review threads need no new permission to be
   answered, only the event.
3. Make sure the webhook is active with Qualor's URL and secret ([above](#turn-on-the-webhook-recommended)).
   The App's **Advanced** tab lists the recent deliveries and what Qualor answered.
4. On **Settings → GitHub**, **Test** the App with a repository: it lists what the App still
   lacks.

### What reviewers see

- A **check run** `qualor/<project key>` on every analysed commit: *success* or *failure*, with the
  failed conditions in its title and the summary in its body. It has no annotations: the findings
  on the changed lines are the review comments below.
- **A review comment on each new issue** that sits on a line the pull request added, up to 50 per
  pull request, with the rule's key linked to its documentation and, when `QUALOR_PUBLIC_URL` is
  set, a link to the issue in Qualor. An analysis posts its new comments together, as one review,
  so GitHub notifies once. Each comment is a conversation that people can reply to and resolve.
  Qualor resolves the conversation when the issue is fixed or marked in Qualor, and reopens it if
  the issue comes back, with **Contents: Read and write**. Without it the conversations stay as
  they are, and the summary says how many: an open one stays open, and one Qualor resolved earlier
  stays resolved when its issue comes back. Qualor never reopens a conversation that someone else
  resolved. A reply by someone else only stops Qualor from resolving the conversation: Qualor
  still reopens a conversation it resolved itself. A comment keeps the text it was posted with: a
  severity changed later in Qualor shows in the summary. A Qualor comment you delete comes back at
  the next analysis; to silence one, mark its issue in Qualor.
- **One summary comment** per pull request, edited in place. It holds the verdict, a table of every
  gate condition with its value and the value it requires, the new issues by severity, the ten most
  severe ones with their rule (linked to the rule's documentation) and a link to each in Qualor, how
  many issues are commented inline and how many could not be placed on the diff, and a link to the
  branch in Qualor.
- Marking an issue **false positive** or **won't fix** in Qualor re-evaluates the gate at once, with
  no new scan. The check run is updated in place, and the issue's conversation is resolved (unless
  someone else replied in it; with **Contents: Read and write**, see
  [What reviewers see](#what-reviewers-see)).
- **AI review**, when an organisation admin switched it on for the project
  ([AI review](./ai-review.md)). The summary comment gains an **AI review** section, and each finding
  of high or medium severity gets a review comment on its line, **up to 20 per pull request, beside
  the 50 above**, in the same review as the analyzers' comments. A finding whose fix is a replacement
  of lines the pull request added comes with a suggested change, which a person applies with
  **Commit suggestion**. Qualor resolves, reopens and leaves these conversations as it does the
  others. These comments need no extra permission.
- **Answers to replies and commands**, with AI review switched on for the project. Qualor answers a
  person's reply in one of its conversations, from an analyzer or from AI review, and a reply to an
  AI finding can mark it won't fix or false positive and resolve the conversation (with **Contents:
  Read and write**, as above; without it the conversation stays open). A comment on the
  pull request's page that starts with `qualor review` gets an answer as a comment of its own
  ([Replies and commands](./ai-review.md#replies-and-commands)). With the webhook this is immediate
  ([above](#turn-on-the-webhook-recommended)); without it the answer comes at the next analysis.

The check run is written first, so it never waits for the comments. GitHub asks integrations to
make at most one write a second, and Qualor keeps to that: an analysis's new comments take one
write, but each conversation it resolves or reopens takes one more, so when many issues are fixed
at once their conversations can take a minute or more to follow.

One run of Qualor's comments makes at most 350 requests to GitHub. It posts its new comments (up to
50 for the analyzers' issues and 20 for AI review's findings, the most severe first) as one review,
and resolves or reopens at most 100 conversations. The check run and the summary are always written.
Whatever is left waits for the next analysis.

## 4. Block merges on the gate

Add a branch protection rule (or a ruleset) on the default branch that requires the status check
**`qualor`** (the workflow job), or **`qualor/<project key>`** (the App's check run), or both.

If the rule also requires conversations to be resolved before merging, Qualor's open comments block
the merge, also those on issues that pass the gate (low and info ones, say) and the open comments of
[AI review](./ai-review.md). Qualor resolves a comment when its issue is fixed or marked in Qualor
(unless someone else replied in it, and with **Contents: Read and write**, see
[What reviewers see](#what-reviewers-see)), and a person can resolve it too. Without that
permission Qualor resolves none, so the rule waits for a person to resolve each of its open
comments.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The job is skipped | the pull request comes from a fork, which is by design |
| Exit 5 | the `QUALOR_TOKEN` secret is wrong or revoked |
| Gate `error`, new code unavailable | `fetch-depth: 0` is missing |
| No check run | no App connection or mapping, the App is not installed on the repository, or it lacks a permission |
| No review comment on an issue | the workflow checked out GitHub's merge commit (the summary says "The analyzers’ issues are not commented inline"; use the `ref:` of [the workflow](#2-the-workflow)), the issue is not on a line the pull request added, or it is past the 50 per pull request (the findings of AI review have 20 more, see the next row). The summary counts the ones it could not place. After a merge-commit checkout only the analyzers' comments are missing: AI review's comments are still posted |
| No **AI review** section in the summary | AI review is not switched on for the project ([Why AI review is off for a project](./ai-review.md#why-ai-review-is-off-for-a-project)), or the workflow did not run for a pull request |
| No comment on an AI finding | the section says what became of the review ([What the summary says](./ai-review.md#what-the-summary-says)). A finding of low severity without a suggested change gets none, nor one past the 20 per pull request, nor one the review made for a commit the pull request has since moved past. The summary counts them, and lists those it can |
| Replies and `qualor review` comments are answered only at the next analysis | the webhook is not set up or not active, its secret differs from Qualor's (the App's **Advanced** tab shows 401), or the App does not subscribe to **Issue comment** and **Pull request review comment**. For `qualor review` also: the App lacks **Issues: Read-only**, or the owner of an installation has not accepted it ([Update an App you created before](#update-an-app-you-created-before)) |
| A reply or a `qualor review` comment gets no answer at all | [AI review: Why a reply or a command was not answered](./ai-review.md#why-a-reply-or-a-command-was-not-answered) |
| Conversations stay open after a fix or a won't fix | the App lacks **Contents: Read and write**, or the owner of an installation has not accepted it ([Update an App you created before](#update-an-app-you-created-before)). The summary says how many conversations could not be resolved or reopened, and **Settings → GitHub**, **Test** with the repository lists what the App lacks |
| A conversation stays open after the issue is fixed or marked | someone else replied in it. Qualor leaves such a conversation for people to resolve |
| The summary says "Inline comments could not be updated this time." | GitHub failed or refused a request for the review comments: an outage or a rate limit (Qualor tries again on its own), or a missing permission (it tries again at the next analysis). The server log's `GitHub decoration retried` or `GitHub decoration stopped` line says why |
| `The GitHub repository was not found` after a rename | update the mapping to the new `owner/repo` |

More in [Troubleshooting](./troubleshooting.md).
