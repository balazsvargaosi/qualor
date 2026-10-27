# Telemetry

The Qualor server sends anonymous usage statistics to the Qualor project once a day. They tell us
how many servers run, which versions, and which languages and features people use, so we know
what to work on. While telemetry is on, the server also checks Docker Hub once a day for a newer
Qualor release. The scanner (`qualor scan`) sends nothing.

## Turn it off

Set `QUALOR_TELEMETRY=false` and restart the server.

- Docker Compose: add `QUALOR_TELEMETRY=false` to the server's `environment` (or `.env`).
- `docker run`: `-e QUALOR_TELEMETRY=false`.
- Helm: `config.telemetry: false`.

At every start the server logs one line that says which it is:

```
Telemetry: disabled
```

## When and where

About a minute after the server starts, and then every 24 hours, the server sends one HTTPS
`POST` to `https://qualor.dev/api/telemetry`. It waits 5 seconds at most and never retries. When
it cannot reach qualor.dev (an offline network, a proxy), nothing else changes.

## What is sent

The whole report, as an example:

```json
{
  "schema": 2,
  "installationId": "3f0c9a52-6d1e-4c8b-9f0a-2b7d1e5c4a91",
  "version": "0.12.0",
  "edition": "community",
  "platform": { "os": "linux", "arch": "x64", "node": "22.11.0", "runtime": "docker" },
  "database": "embedded",
  "counts": {
    "organizations": 1, "users": 4, "projects": 12, "branches": 30,
    "analyses30d": 310, "qualityGates": 2, "qualityProfiles": 5, "webhooks": 1
  },
  "languages": ["java", "typescript"],
  "engines": ["qualor", "semgrep"],
  "scm": ["gitlab"],
  "features": { "sso": false, "scim": false, "aiAssistant": true, "aiReview": true },
  "aiReview": {
    "organizations": 1, "projects": 3, "provider": "anthropic",
    "tiers": { "strong": true, "fast": false },
    "reviews30d": { "done": 41, "skipped": 6, "failed": 1, "superseded": 3 },
    "findings30d": 57, "inline30d": 38, "suggestions30d": 12,
    "replies30d": { "answered": 9, "statusChanges": 2 },
    "commands30d": { "review": 2, "fix": 0, "stop": 0 }
  },
  "assistant30d": { "explain": 14, "triage": 3, "fix": 5 }
}
```

| Field | Meaning |
|---|---|
| `installationId` | a random id the server creates on its first report and keeps. It is not derived from your licence, organisations or host |
| `version`, `edition` | the server's version, and `community` or `enterprise` |
| `platform` | operating system, CPU architecture, Node.js version, and whether it runs from the Docker image, on Kubernetes or as a plain Node.js process |
| `database` | `embedded` (the image's own PostgreSQL) or `external` (`DATABASE_URL`) |
| `counts` | how many organisations, users, projects, branches, quality gates, quality profiles and webhooks exist, and how many analyses ran in the last 30 days |
| `languages` | the languages of the analysed files |
| `engines` | the built-in analyzers that ran successfully in the last 30 days, and `external` when a SARIF report from another tool was imported |
| `scm` | `gitlab` and/or `github`, when a connection exists |
| `features` | whether single sign-on, SCIM, the AI assistant and AI review are set up |
| `aiReview` | how AI review is used: the organisations that have it on, and the projects it reviews; the kind of model provider (`anthropic`, `openai_chat_completions`, `openai_responses` or `none`), never its address or its models; whether a strong and a fast model are set; and, for the last 30 days, the reviews by how they ended (done, skipped, failed, or superseded by a newer push), the findings they raised, those placed on a changed line and those with a suggestion, the replies answered and the status changes they made, and the `qualor review`, `qualor fix` and `qualor stop` commands handled |
| `assistant30d` | how many Explain, Suggest triage and Suggest a fix requests were made in the last 30 days |

Servers before 0.12.0 send `schema` 1, without `aiReview`, `assistant30d` and the `aiReview` flag
of `features`.

## What is never sent

Names of users, organisations, projects, repositories or branches, email addresses, URLs and
host names, model names, the AI provider's address, source code, file paths, issues, prompts,
model answers and review text, tokens, secrets and the licence key.

## Update check

While telemetry is on, the server asks Docker Hub (`hub.docker.com`) for the list of
`qualor/server` tags about a minute after it starts and then every 24 hours. The request carries
nothing about your installation; like any request, Docker Hub sees the address it comes from.

When a newer release exists, the server:

- logs `Qualor 0.9.0 is available (this server runs 0.8.0)` with a link to the release notes;
- shows instance admins a banner, which they can dismiss until the next release, and the new
  version next to the current one in the user menu;
- tells the scanner, which logs it at the start of a scan (see [the scanner](./cli.md#qualor-scan)).

`QUALOR_TELEMETRY=false` turns the update check off as well. Behind a firewall or with your own
registry mirror the check fails quietly and nothing is shown.

## What happens on our side

qualor.dev stores the report under the installation id, one per day, and keeps it for 24 months.
It keeps the report without the IP address it came from; like every request to qualor.dev, the
address appears in the load balancer's logs, which are deleted after 30 days. Only the Qualor
project sees the data. See also the [privacy policy](https://qualor.dev/privacy).
