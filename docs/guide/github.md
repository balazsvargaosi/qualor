# GitHub

Qualor works with GitHub.com, GHE.com and GitHub Enterprise Server 3.9 or later. Setup has two parts:

1. **The Actions workflow** (the Qualor Action) runs `qualor scan`, uploads the analysis and fails the check when the
   quality gate fails.
2. **A GitHub App (optional, recommended)** lets the Qualor server post a check run
   `qualor/<project key>` with annotations on changed lines, plus one summary comment per pull
   request. Its **Re-run** button re-decorates.

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
variable `QUALOR_SCANNER_IMAGE` with `qualor/scanner:0.10`, or a full version such as
`qualor/scanner:0.10.0` (for C#, `QUALOR_SCANNER_DOTNET_IMAGE` with `qualor/scanner-dotnet:0.10`).

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
- uses: qualor-dev/scan-action@v0.10
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
      - uses: qualor-dev/scan-action@v0.10
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

The action's version follows Qualor's: `@v0.10.0` runs `qualor/scanner:0.10.0`, `@v0.10` follows
the 0.10 patch releases and `@v0` the latest release. Pick the version that matches your Qualor
server, or pin a full version to control every update.

Why it looks like this:

- It checks out the **pull request's head**, not GitHub's merge commit, so annotations land on the
  pull request's own lines.
- `fetch-depth: 0` gives the full history, from which new code is computed.
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
- uses: qualor-dev/scan-action/dotnet@v0.10
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
| Repository permissions | **Checks: Read and write**, **Pull requests: Read and write**, **Metadata: Read-only**. Nothing else |
| Subscribe to events | **Check run** (only for the Re-run button) |
| Webhook | inactive for now. You activate it in step 3 |
| Where can it be installed | Only on this account |

Then **generate a private key** (a `.pem` file) and note the **App ID**. **Install** the App on the
repositories Qualor should decorate.

### Connect it to Qualor

In Qualor, an **org admin** opens **Settings → GitHub → New GitHub App**:

- **API address**: `https://api.github.com` for GitHub.com, `https://api.<subdomain>.ghe.com` for
  GHE.com, or `https://<host>/api/v3` for GitHub Enterprise Server.
- **App id** and **Private key**: paste the `.pem` file, or choose it. Use the unencrypted RSA key
  that GitHub generated.
- **Webhook secret** (optional): a random value such as `openssl rand -hex 32`. It is needed only for
  the Re-run button.

Then, in **Settings → Repositories**, pick the GitHub connection for each project, enter the
repository as `owner/repo` and **Save**. **Check** tests that the App is installed there and has the
permissions it needs.

### Turn on Re-run (optional)

With a webhook secret saved and `QUALOR_PUBLIC_URL` set on the server, Qualor shows the webhook URL:
`https://qualor.example.com/api/v0/github/webhooks/<connection id>`. On the App's settings page, paste
that URL and the same secret, keep the content type **application/json**, and activate the webhook.

GitHub Enterprise Server on an internal network needs its host in `QUALOR_SCM_INTERNAL_HOSTS` on the
server, and a private CA needs `NODE_EXTRA_CA_CERTS`.

### What reviewers see

- A **check run** `qualor/<project key>` on every analysed commit: *success* or *failure*, with the
  failed conditions in its title and the summary in its body.
- **Annotations** on up to 50 new issues on added lines, each with a link to its rule's
  documentation. They are *failure* for blocker and high issues, *warning* for medium, and *notice*
  for low and info.
- **One summary comment** per pull request, edited in place. It holds the verdict, a table of every
  gate condition with its value and the value it requires, the new issues by severity, the ten most
  severe ones with their rule (linked to the rule's documentation) and a link to each in Qualor, and
  a link to the branch in Qualor.
- Marking an issue **false positive** or **won't fix** in Qualor re-evaluates the gate at once. A new
  check run without that annotation replaces the old one.

## 4. Block merges on the gate

Add a branch protection rule (or a ruleset) on the default branch that requires the status check
**`qualor`** (the workflow job), or **`qualor/<project key>`** (the App's check run), or both.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The job is skipped | the pull request comes from a fork, which is by design |
| Exit 5 | the `QUALOR_TOKEN` secret is wrong or revoked |
| Gate `error`, new code unavailable | `fetch-depth: 0` is missing |
| No check run | no App connection or mapping, the App is not installed on the repository, or it lacks a permission |
| `The GitHub repository was not found` after a rename | update the mapping to the new `owner/repo` |

More in [Troubleshooting](./troubleshooting.md).
