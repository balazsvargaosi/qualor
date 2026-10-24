# AI assistant

Qualor can ask a language model about one issue at a time. It is optional, **off by default**, and
uses a model you choose, with your own key: a hosted provider or a local model on your own network.
[AI review](./ai-review.md), which lets a model review whole merge requests, is described on its
own page. It uses the provider configured here and has its own switch, warning and budgets.

## What it does

In the issue view, the **AI assistant** panel offers three actions. Each one runs only when a person
clicks it, for that one issue. With an Enterprise licence, an organisation admin can also let
Qualor suggest fixes for the new findings of merge requests without a click (see
[Automatic fix suggestions](#automatic-fix-suggestions-enterprise)); that is off until they switch
it on.

- **Explain**: what the rule checks, why this code triggers it, the risk, and how to fix it.
- **Suggest triage**: whether the finding looks like a false positive, with a verdict ("Likely a
  false positive", "Likely a true positive" or "Uncertain"), a confidence and up to five reasons.
  It is only a suggestion: the model never changes an issue. A person who agrees clicks **Mark as
  false positive…**, which opens the usual status change with an empty comment. They write their
  own reason, as always, and the issue's changelog records that the AI suggestion was shown and
  that the decision was theirs.
- **Suggest a fix**: a replacement for the flagged lines, shown as before and after. On a merge
  request or pull request mapped to GitLab or GitHub, a person can click **Post to merge request**.
  Qualor then posts it as a GitLab suggestion or a GitHub suggested change, which a person reviews
  and applies there. Qualor never commits, pushes or opens a branch or merge request of its own.

Every answer is labelled "AI-generated, may be wrong", with the model's name and the time. Answers
are shown as plain text: links, Markdown and HTML in them are never rendered.

A fix is posted only when all of these hold. Otherwise the panel says why nothing was posted:

- the merge request's head is still the commit Qualor analysed (after a newer push, analyse it and
  ask again);
- the lines to replace are lines the merge request added, and they are unchanged;
- the issue is still open, and the assistant and its fix feature are still enabled.

Posting the same suggestion twice posts it once. Qualor needs no extra GitLab scope or GitHub App
permission for this: the token or App that comments on merge requests posts the suggestion.

Triage and fix need an **open** issue. A fix also needs the issue's file, line and the code around
it.

## What is sent, and where

Nothing is sent to any model until an instance admin has configured a provider **and** enabled
the organisation **and** the feature, **and** a person clicks. No scan, merge request comment or
background job calls a model by itself, and the scanner (the CLI) never contacts a model: only the
server does. There are two exceptions, and an organisation admin must switch each one on first:

- the Enterprise feature [automatic fix suggestions](#automatic-fix-suggestions-enterprise);
- [AI review](./ai-review.md), which is in every edition. It calls the model without anyone's click,
  for each merge request of the projects the admin chose, and **repository files may be sent for
  it**: the merge request's diff and any file the model chooses to read, from a copy of the
  repository that the scanner uploaded to your server. Secrets in it are masked, credentials files
  are not in the copy, and files on **Never send these paths** are never shown to the model. What
  it sends is listed in [What the model is sent](./ai-review.md#what-the-model-is-sent).

What follows is what the single-issue actions send.

For the one issue a person asks about, the server sends:

- the rule: its key, name, description and CWE numbers;
- the issue's severity, quality and kind, and its message;
- the file path, the lines and the language;
- the code around the issue that the scan already stored: the flagged lines with up to 3 lines of
  context on each side.

**Secrets are redacted first.** The scanner already replaces the secrets its analyzers find with
`«redacted»`. The server then redacts again, before anything leaves: private keys, cloud and SCM
tokens, API keys, JSON Web Tokens, passwords in URLs, `Authorization` headers, and values assigned
to names such as `password`, `secret`, `token` or `api_key` (in code, `.env` and YAML files,
properties, Dockerfiles, connection strings and XML).

**Never sent by these actions:**

- issues of secret-detection rules (Gitleaks, and rules about credentials in code). An AI review is
  shown their rule, place and masked message, so that it does not report them again
  ([What the model is sent](./ai-review.md#what-the-model-is-sent));
- issues in files that look like credentials: `.env` files, keys and certificates (`*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.jks`, `*.ppk`), `id_rsa` and similar, `credentials*`, `.npmrc`, `.pypirc`,
  `.netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, Docker and Kubernetes configs, Terraform
  variables and state, `secrets.yml`. A source extension is no exception: `credentials.js` is not
  sent either;
- issues of an excluded project or on an excluded path;
- the names of the project, organisation and branch, commit SHAs, users and changelog comments.

The **What is sent** panel in the settings, and a notice in the issue view's panel, name these
fields together with the provider's host and model.

## Configuration

### The provider (instance admins)

An instance admin opens **Settings → AI assistant** and configures one provider for the whole
instance:

| Setting | What to enter |
|---|---|
| Kind | **OpenAI-compatible** (OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio and other servers with the chat completions API) or **Anthropic** |
| Base URL | with the version path for OpenAI-compatible servers: `https://api.openai.com/v1`, `https://<resource>.openai.azure.com/openai/v1`, `http://ollama:11434/v1`. Anthropic: `https://api.anthropic.com` |
| Model | the model's name as the provider spells it |
| API key | write-only. It is stored encrypted and never shown again. Leave it empty for a local model without a key |
| Key header | `Authorization: Bearer` (the default), or `api-key` for Azure |
| JSON mode | on by default. Turn it off for a server that refuses `response_format` |
| Output limit field | `max_completion_tokens` for OpenAI and Azure OpenAI, whose current models refuse `max_tokens`; `max_tokens` for vLLM, Ollama and most other servers. The page picks it from the base URL's host until you choose one |
| Temperature | optional; not sent when empty |
| Timeout (seconds) | 5–600, default 60, for the whole request |

Press **Test**. It sends a fixed prompt that holds no repository data to the saved provider, and
shows the model's name and the latency, or what went wrong. When that passes, it makes a second
call, also with fixed text, to check tool calling, which [AI review](./ai-review.md#models-that-work)
needs. The page then adds `Tool calling (needed by AI review): supported` or `not supported`, and
nothing when the check could not tell.

- For Azure OpenAI, use the v1 API's base URL. The older per-deployment URLs
  (`/openai/deployments/<name>/…?api-version=`) are not supported.
- **Changing the base URL needs the key again**, so a stored key is only ever sent to the address
  it was entered for. **Remove the key** deletes it.
- The key is encrypted with `QUALOR_SECRET_KEY`. After that key changes, set the API key again.
- The address must be `https` and resolve to public addresses, unless the operator lists the host
  in `QUALOR_LLM_INTERNAL_HOSTS` (see [a local model](#a-local-model-with-ollama)). Redirects are
  not followed, and no proxy is used.

### Organisations and projects

On the same page, per organisation, the instance admin chooses:

- **Enabled**: nothing of an organisation is ever sent while it is off. Organisations start off.
- the features: **Explain**, **Suggest triage** and **Suggest a fix**, each off until checked;
- excluded projects, whose issues are never sent.

**Never send these paths** takes up to 100 globs (such as `legacy/**` or `**/*.generated.ts`),
matched against the issue's path in every organisation.

The AI assistant panel appears in the issue view only for an enabled organisation, and each action
only when its feature is on and the issue can be sent. Any member of the organisation can ask and
post, as for changing an issue's status: signed in, or with a token that has the `write` scope (see
[Users, projects and tokens](./users-projects-tokens.md)).

## Automatic fix suggestions (Enterprise)

With an Enterprise licence (the feature `llm.auto-fix`, see [Enterprise](./enterprise.md)), Qualor
can suggest fixes for the new findings of a merge request or pull request on its own, and post
them there as a GitLab suggestion or a GitHub suggested change, without anyone clicking **Suggest a
fix**. It is **off by default**, for every organisation. Nothing is committed or pushed: a person
still reviews each suggestion and applies it on GitLab or GitHub, or ignores it.

### What runs, and when

After each analysis of a merge request or pull request whose project is mapped to GitLab or GitHub
([GitLab](./gitlab.md), [GitHub](./github.md)), Qualor picks the findings that get a suggestion:

- only **new-code** findings of that merge request, never the old issues of the branch it targets,
  and never an analysis of the main branch or of another branch;
- only **open** issues of at least the **minimum severity** (default **High**: blocker and high);
- at most **the maximum per analysis** (default 10, from 1 to 25), the most severe first;
- never an issue Qualor already asked a model about on its own, whatever the answer was. A later
  analysis of the same merge request, or a new commit that still has the finding, does not suggest
  it again. If a person already got a fix for that issue and it still applies (the same code, rule
  and model, within the 30-day cache), Qualor neither asks again nor posts it; otherwise it asks on
  its own;
- never an issue the assistant would not send for a person either: secret-detection rules,
  credential files, excluded projects and excluded paths.

Qualor asks the model in the background, so the analysis, the quality gate and the merge request
comment are never delayed. Each answer that passes the same safety checks as a person's suggestion
is posted to the merge request as an inline suggestion. It carries the line "Posted automatically
for new findings of this merge request. A person can switch this off in Qualor's AI settings." and
is labelled "AI-generated, may be wrong", like any other answer. In the issue view an automatic fix
shows **Suggested automatically**.

### The safety checks are the same

A suggestion is posted only when all of these still hold when Qualor posts it:

- the merge request's head is still the commit Qualor analysed. After a newer push, the next
  analysis starts again, and the findings that got no suggestion yet can get one;
- the lines to replace are lines the merge request added, and they are unchanged;
- the issue is still open, the answer passed the safety rules (inside the shown lines, no secret,
  no control characters, no GitLab quick action), and the assistant, its fix feature and automatic
  fix suggestions are still enabled for the organisation and the project.

The same data is sent as for a person's fix, redacted the same way ([What is sent, and
where](#what-is-sent-and-where)), and the same files and rules are never sent.

### Switch it on and off

1. An instance admin has configured a provider and enabled the organisation with **Suggest a fix**
   ([Configuration](#configuration)). Automatic fix suggestions follow from that: they cannot be
   switched on for an organisation that has none of it.
2. An **organisation admin** opens **Settings → Automatic fixes** (the organisation chosen in the
   header) and switches on **Post fix suggestions automatically**, with the **Minimum severity** and
   the **At most per analysis**. The same block is on **Settings → AI assistant** for an instance
   admin, per organisation. The permission is `org.ai.manage`, held by the Organization admin role
   ([Roles and the audit log](./roles-and-audit.md)). Without the licence the page shows an
   Enterprise note in place of the controls.
3. A **project admin** can opt one project out: **Project → Settings → Automatic fix
   suggestions**. A project cannot switch it on when the organisation has it off. Without the
   organisation's switch the panel says so, and for a project excluded from the AI assistant it
   says that instead of offering the switch.

Switching it off, or losing the licence, stops new suggestions at once, including requests already
waiting, and posts nothing more. Suggestions already posted stay on the merge request. A
suggestion a person asked for is never posted automatically.

### Budget and cost

An automatic suggestion is an ordinary fix request of the organisation: it counts against the
organisation's **daily fix budget**, its tokens and its estimated cost ([Budgets and
limits](#budgets-and-limits)). Not against a person's hourly bound, since no person asked. Your
fix budget is the only limit. When the budget is used up, Qualor stops asking for
that analysis, and the findings that got no suggestion yet are picked up by a later analysis of
the same merge request, once the budget is back at the next UTC midnight. The server logs one line
(`outcome: budget_exhausted`). Lower **At most per analysis** or raise the budget if suggestions
use it up too fast.

### Audit

The audit log records a change of the organisation's settings as
`organization.auto_fix_changed` and a project's opt-out as `project.auto_fix_changed`. Each
automatic request and each post are recorded as `ai.requested` and `ai.fix_posted` by the system,
since no person acted ([Roles and the audit log](./roles-and-audit.md#what-is-recorded)).

## A local model with Ollama

To keep code on your own network, run [Ollama](https://ollama.com) next to the server. Qualor talks
to Ollama's OpenAI-compatible API at `/v1`.

1. Add an `ollama` service to the [`compose.yml`](./install-server.md#the-compose-file) of the
   server, with a volume for its models and no published port:

   ```yaml
   services:
     server:
       # ... as in "Install the server"
     ollama:
       image: ollama/ollama:<version> # pin a version
       restart: unless-stopped
       volumes:
         - ollama:/root/.ollama
       security_opt: ['no-new-privileges:true']

   volumes:
     data:
     ollama:
   ```

2. Allow the server to call it over plain `http` on the internal network. In `.env`:

   ```sh
   QUALOR_LLM_INTERNAL_HOSTS=ollama:11434
   ```

   The guide's `compose.yml` passes this variable to the server. It is a list separate from
   `QUALOR_SCM_INTERNAL_HOSTS`: listing a GitLab does not let the model point at it, nor the reverse.

3. Start it and download a model into the volume:

   ```sh
   docker compose up -d
   docker compose exec ollama ollama pull <model>
   ```

4. In **Settings → AI assistant**, choose **OpenAI-compatible**, base URL `http://ollama:11434/v1`,
   the model's name as `ollama list` shows it, and no API key. Press **Test**, then enable the
   organisations and features you want.

A local model on a CPU can be slow. If requests end with "The model did not answer in time", raise
the timeout (up to 600 s). Give Ollama the memory its model needs. vLLM and LM Studio are set up the
same way, with their own host and port in `QUALOR_LLM_INTERNAL_HOSTS`.

To run the server with its database on a separate network with no route out, as the repository's
own `deploy/docker-compose.yml` does, see "A local model with Ollama" in
[`deploy/README.md`](../../deploy/README.md#a-local-model-with-ollama).

## Budgets and limits

The instance admin sets daily budgets per organisation (UTC days) under **Budgets per organisation
and day (UTC)**:

| Budget | Default |
|---|---|
| Explanations | 200 a day |
| Triage suggestions | 100 a day |
| Fix suggestions | 25 a day |
| Tokens (sent and received) | 1 000 000 a day |
| Estimated cost in US dollars | off. It needs the model's prices per million tokens, which you enter |
| Requests per person | 30 an hour, all features together |

The top of the page shows today's use of the organisation chosen in the header against these
budgets, one meter per budget, and says when a budget is reached for the day.

The field **AI review: most tokens per organisation per day** under them is not a budget of this
assistant. It caps what an organisation admin may give [AI review](./ai-review.md#budgets-and-todays-usage),
which has budgets of its own. Leave it empty for no cap.

Posting a suggestion to a merge request does not count again. The budgets are yours to set, and no
edition caps them: the fix budget can go up to 100 000 a day, like the explanation and triage budgets.

An organisation over a budget gets "The organisation's AI budget for today is used up" until the
next UTC midnight. A person over the hourly bound gets "You asked too often; try again in a few
minutes".

**What counts.** A request counts against the daily budgets from the moment it is queued. If it
then fails without using any tokens, because the provider refused the API key or because nothing
was sent (the AI assistant was turned off, the settings or the issue changed, the key or the
address can no longer be used), it stops counting. Every other failure, such as a timeout or a
refused request, still counts. The hourly bound per person counts every request, whatever its
outcome.

**Cache.** An answer is kept for the issue for 30 days. Asking again for the same issue, with the
same code, rule and model, shows the stored answer at once, sends nothing and costs no budget.
**Ask again** sends a new request and counts against the budget.

Each server process runs at most two requests at once, and at most one per organisation, so one busy
organisation cannot hold up the others. A slow or unavailable provider never delays analyses, gates or merge
request comments.

## Retention and audit

The server records every request sent to the provider: who asked, for which issue, the feature,
the provider's host and model, the size and a hash of what was sent, the names of the fields sent,
the number of redactions, the status, the token counts, the estimated cost when prices are set, and
the duration. It never records the API key, and it does not record the content sent unless you ask
it to:

- **Store the prompts sent** (off by default) keeps the exact redacted data sent, for 1–90 days
  (**Days to keep them**, default 7).
- The answer is kept, since the issue view shows it and a fix is posted from it. For a fix, the
  lines it replaces are kept with it, to check them against the merge request before posting.
- Request records are deleted after **90 days**, or with their organisation or project. The record
  of an automatic fix suggestion stays while its issue exists, since it is what keeps Qualor from
  suggesting that fix again.
- Each finished request also writes one log line with the same details, never the content or the
  key. When the provider answered with an error, the line has its HTTP status (`providerStatus`).
- The calls of an [AI review](./ai-review.md#how-long-copies-live) are recorded the same way, with
  the feature `review` and no issue or person. With **Store the prompts sent** on, their prompts are
  kept too, for the days set there, and the model's answers stay with the record. The prompts hold
  the code the model was shown.

Today's use and budgets for an organisation are at `GET /api/v0/organizations/{id}/ai`.

## Troubleshooting

| Message | What to do |
|---|---|
| "The model did not answer in time" | raise the timeout in the settings; a local model on a CPU needs more |
| "The model provider could not be reached" | check the base URL and that the server can reach the host. After 5 failures in a row Qualor pauses calls to that address for 10 minutes |
| "The model provider is rate limiting Qualor; try later" | the provider's own limit. Qualor retries after the time the provider asks for; try again later, or lower the budgets |
| "The provider refused the API key (HTTP 401)" | set a valid key; check the key header (`api-key` for Azure) |
| "The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit" | the key is valid but may not use this model: check the model's name, the key's project or workspace permissions, and the account's billing or credit |
| "The model does not accept max_tokens; set the output limit field to max_completion_tokens in the AI assistant settings" (or the other way round) | the model refused the output limit field: pick the other one in the settings |
| "The provider refused the request; check the base URL and the model" | an OpenAI-compatible base URL usually needs `/v1`; check the model's name. OpenAI's newer models need the `max_completion_tokens` output limit field; some servers need JSON mode off |
| "The provider's answer was not understood" | the address is not a chat completions or Anthropic Messages API, or the answer was over 1 MiB |
| "The provider's address is not allowed" | the operator lists the host with its port in `QUALOR_LLM_INTERNAL_HOSTS`, or use an `https` address that resolves to public addresses |
| "The stored API key can no longer be read; set it again" | `QUALOR_SECRET_KEY` changed. Enter the API key again |
| "The model's answer could not be used" | the model did not answer with the expected JSON, or its answer was cut off. Ask again, or try another model |
| "The model declined to answer" | the provider's content filter or the model refused |
| "The suggested fix was not safe to show" | the fix broke a safety rule (outside the shown lines, a secret, control characters, or a GitLab quick action). Ask again or fix it by hand |
| "The AI assistant is not enabled for this organisation" | an instance admin enables the organisation and the feature |
| "Findings of secret rules are never sent" / "Issues in credential files are never sent" | by design: Explain, Triage and Fix never send them. Handle these issues without the assistant |
| "An administrator excluded this issue's path or project" | by design; an instance admin can change the exclusions |
| "Something changed since you asked; ask again" | the settings or the issue changed (a new analysis) while the request waited |
| "The request was interrupted; ask again" | the server restarted, or the request failed unexpectedly, while it ran |
| "Not posted: the merge request has a newer commit" | analyse the latest commit, then ask for a new fix |
| "Not posted: the lines are not added lines of the merge request" / "the code on the merge request differs" | suggestions can only replace lines the merge request added, unchanged. Fix it by hand |
| No automatic suggestions on a merge request | check, in order: the licence lists `llm.auto-fix`; **Settings → Automatic fixes** is on for the organisation, and the organisation and **Suggest a fix** are enabled in **Settings → AI assistant**; the project did not opt out and is not excluded from the AI assistant; the project is mapped to GitLab or GitHub; the findings are new in this merge request, open and at the minimum severity; no suggestion was made for them before; the daily fix budget is not used up |
| "Automatic fix suggestions need the Enterprise plan." (the Settings page, or the API's 403 `FEATURE_NOT_LICENSED`) | apply a key that lists `llm.auto-fix` ([Enterprise](./enterprise.md)) |
| Switching automatic fix suggestions on answers 409 `AI_DISABLED` | an instance admin must configure a provider, enable the organisation and turn on **Suggest a fix** first |
| 409 `AUTO_FIX_OPT_OUT_LIMIT_REACHED` | an organisation lists at most 1 000 projects that opted out; let a project back in first |
| "The project is not mapped to GitLab or GitHub" | map it in **Settings → Repositories** ([GitLab](./gitlab.md), [GitHub](./github.md)) |

Error codes in the API: `AI_DISABLED` (409), `AI_NOT_ELIGIBLE` (409, with the reason in `detail`),
`AI_POST_NOT_POSSIBLE` (409, with the reason in `detail`), `AI_QUOTA_EXCEEDED` (429 with
`Retry-After`) and `RATE_LIMITED` (429). A failed request's `error.code` is one of `PROVIDER_TIMEOUT`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_REFUSED_KEY`,
`PROVIDER_REJECTED_REQUEST`, `PROVIDER_BAD_ANSWER`, `URL_NOT_ALLOWED`, `KEY_UNDECRYPTABLE`,
`MALFORMED_OUTPUT`, `OUTPUT_TRUNCATED`, `MODEL_REFUSED`, `OUTPUT_REFUSED`, `AI_DISABLED`,
`SETTINGS_CHANGED`, `ISSUE_CHANGED`, `ISSUE_GONE` or `REQUEST_ABANDONED`.
