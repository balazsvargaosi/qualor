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

Nothing is sent to any model until an instance admin has connected a provider **and** allowed the
organisation to use AI **and** switched the feature on, **and** a person clicks. No scan, merge
request comment or background job calls a model by itself, and the scanner (the CLI) never contacts
a model: only the server does. There are two exceptions, and an organisation admin must switch each
one on first:

- the Enterprise feature [automatic fix suggestions](#automatic-fix-suggestions-enterprise);
- [AI review](./ai-review.md), which is in every edition. It calls the model without anyone's click,
  for each merge request of the projects the admin chose, and **repository files may be sent for
  it**: the merge request's diff and any file the model chooses to read, from a copy of the
  repository that the scanner uploaded to your server. Secrets in it are masked, credentials files
  are not in the copy, and files on **Never send these paths** are never shown to the model. It also
  answers a person's reply in one of its threads in the merge request, with that thread and any file
  the model chooses to read. What it sends is listed in
  [What the model is sent](./ai-review.md#what-the-model-is-sent).

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

**What is sent**, in the **Data and privacy** section of **Settings → AI provider**, lists what
each feature sends and to which host. A notice in the issue view's panel names these fields
together with the provider's host and model.

## Configuration

### The provider (instance admins)

An instance admin opens **Settings → AI provider** and connects one provider for the whole
instance. The page opens with a **Status** card: the provider and its last Test, how many
organisations may use AI, where AI review is on or paused, the limits and the prices. Under it come
four sections, each with its own Save: **Provider**, **Organizations**, **Limits** and **Data and
privacy**. Until a provider is saved, only **Provider** shows. Leaving the page with changes that
are not saved asks first ("Leave without saving?").

In the **Provider** section, choose the kind of API the model speaks; the other settings show once
you do:

| Setting | What to enter |
|---|---|
| Provider | **OpenAI-compatible** (OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio, LiteLLM and other servers of the Chat Completions or Responses API) or **Anthropic** (Claude models at `api.anthropic.com`) |
| Base URL | with the version path for OpenAI-compatible servers: `https://api.openai.com/v1`, `https://<resource>.openai.azure.com/openai/v1`, `http://ollama:11434/v1`. Anthropic: `https://api.anthropic.com`, which choosing **Anthropic** fills into an empty field |
| API key | write-only. It is stored encrypted and never shown again. Leave it empty for a local model without a key. Once a key is stored, the page shows **Set** and "An API key is set." in place of the field, with **Replace the key** and **Remove the key** |
| Workspace ID | Anthropic only, optional: `wrkspc_…`, for a key of the whole organisation that is not scoped to a workspace. Sent as `anthropic-workspace-id` on every request. Not a secret ([The current models](#the-current-models)) |
| Model | the model's name as the provider spells it: the **standard model**, which Explain, Suggest triage, Suggest a fix, the review's reviewers and the answers to replies use |
| Strong model | under the switch **Use a stronger and a faster model for parts of AI review**, off by default: the model of the review's judge and of its second check of security findings. Empty: the model above ([Model tiers](#model-tiers)) |
| Fast model | under the same switch: the model of the quality reviewer of a small review, 10 changed lines or fewer. Empty: the model above |
| Prices | under the switch **Count costs with these models' prices**, off by default: an **Input** and an **Output** price for each model, in US dollars per million tokens ([Budgets and limits](#budgets-and-limits)) |

**Connection options** is a fold that lists its values while it is closed. Most providers need
none of them changed:

| Setting | What to enter |
|---|---|
| API | OpenAI-compatible only: **Chat Completions** (what vLLM, Ollama, LM Studio and Azure serve) or **Responses**, OpenAI's Responses API, which its newest models need for tool calling ([The current models](#the-current-models)). The page sets it from the address until you choose: **Responses** for a new provider at `api.openai.com`, **Chat Completions** for any other |
| Key header | OpenAI-compatible only: `Authorization: Bearer` (the default), or `api-key (Azure)` |
| Output limit parameter | Chat Completions only: `max_completion_tokens` for OpenAI and Azure OpenAI, whose current models refuse `max_tokens`; `max_tokens` for vLLM, Ollama and most other servers. The page sets it from the base URL's host until you choose one. The Responses API always uses `max_output_tokens`, and the page hides this setting while **Responses** is chosen |
| Ask for a JSON object | OpenAI-compatible only: JSON mode, on by default. Turn it off for a server that refuses `response_format` |
| Timeout | 5–600 seconds, default 60, for the whole request of Explain, Suggest triage, Suggest a fix and the Test. A review or reply call streams its answer and waits at least 300 seconds for the first piece and between two pieces, and 15 minutes in all ([Models that work](./ai-review.md#models-that-work)) |
| Set a temperature | OpenAI-compatible only, off by default: no temperature is sent, and the model uses its own. On, the **Temperature**, from 0 to 2. For Anthropic the page says "Not used: Anthropic's current models take no temperature." |

Press **Save and test**. It saves the provider, then tests every model of it at once: the standard
model, and the strong and the fast model when they name another model. For each it sends a fixed
prompt that holds no repository data (it asks for a JSON reply: `Reply in JSON.`), and when that
passes, a second call, also with fixed text, to check tool calling, which
[AI review](./ai-review.md#models-that-work) needs. **Last test** then shows a line for each model,
such as `gpt-6.1-sol: connected in 812 ms · can call tools` or
`gpt-4o-mini: connected in 640 ms · cannot call tools, so AI review would fail`, or the model's
name and what went wrong. A model whose tool check could not tell gets its connection only. A model
that fails never fails another, and when any failed the page also says
`The test failed for 1 of 3 models.` The Test asks through the API you chose. For a model that
takes tools only through the Responses API the page adds `This model takes tools only through the
Responses API: choose Responses in Connection options.` and opens **Connection options**, and for a
key that is not scoped to a workspace the model's line says `This key is not scoped to a
workspace: give its workspace ID above.`

**Test again** tests the saved provider again, while the section has no unsaved changes. Qualor
keeps the last Test until the provider's settings or its key change: when you come back, **Last
test** shows it with when it ran and who ran it ("Tested Oct 26, 2026, 2:02 PM UTC, by you."),
without the time each call took, and the **Provider** line of the Status card sums it up. An
organisation admin who switches AI review on is warned when it found a model that cannot call
tools ([In Qualor](./ai-review.md#in-qualor)).

- For Azure OpenAI, use the v1 API's base URL. The older per-deployment URLs
  (`/openai/deployments/<name>/…?api-version=`) are not supported.
- **Changing the base URL needs the key again**, so a stored key is only ever sent to the address
  it was entered for: the key field comes back with "You changed the address: enter the key again.
  Qualor sends a key only to the address it was entered for." **Remove the key** deletes it when
  you save; **Undo** keeps it.
- **Changing the address or the models pauses AI review** in the organisations whose admins
  confirmed them ([The warning](./ai-review.md#the-warning)). The page says so under the base URL,
  and while AI review is on somewhere, **Save and test** asks first, such as "Pause AI review in
  Acme?", naming the provider they confirmed and the new one. **Save and pause AI review** saves;
  **Cancel** sends nothing. Explain, Suggest triage and Suggest a fix carry on as before. The key,
  the API, the timeout, the temperature, the workspace and the prices pause nothing.
- **Remove the provider…** asks "Remove the AI provider?", then stops every AI feature in every
  organisation and deletes the API key. Organisations keep their settings.
- The key is encrypted with `QUALOR_SECRET_KEY`. After that key changes, set the API key again.
- The address must be `https` and resolve to public addresses, unless the operator lists the host
  in `QUALOR_LLM_INTERNAL_HOSTS` (see [a local model](#a-local-model-with-ollama)). Redirects are
  not followed, and no proxy is used.
- After 5 failures in a row (timeouts, no answer, rate limits) Qualor pauses calls to the address
  for 10 minutes. [AI review](./ai-review.md) calls the same provider and its failures count too:
  repeated timeouts or rate limits during reviews pause **Explain**, **Suggest triage** and
  **Suggest a fix** for those 10 minutes, and the reverse.

### The current models

What follows is what Qualor does so that the current models of OpenAI and Anthropic work.

- **OpenAI: Chat Completions or Responses.** The **API** setting, in **Connection options**, picks
  the API that Qualor calls. Chat Completions is what vLLM, Ollama, LM Studio, LiteLLM and Azure
  deployments serve, and what the page sets for any address but `api.openai.com`. OpenAI's newest
  models (`gpt-6.1-sol`, `gpt-5.6-terra` and `gpt-6-luna` were checked)
  take function tools with reasoning only through the **Responses** API, and
  [AI review](./ai-review.md#models-that-work) needs tools: choose Responses for them. The Test
  says so when you do not. Through Responses the output limit is always `max_output_tokens`, so
  **Output limit parameter** does not apply. With JSON mode on, the API wants the word JSON in a
  message of the request, so Qualor adds the line `Reply in JSON.` to the first message when no
  message says it. A Responses request is stateless: Qualor sends `store: false`, so OpenAI keeps
  nothing beyond its own abuse monitoring, and the reasoning the model did comes back encrypted and
  goes back with the next turn of a conversation. The API clamps an output limit that is too large
  by itself.
- **Anthropic.** The current models (Claude 4.7 and later) take no temperature: Qualor never sends
  one, the page offers none for this kind ("Not used: Anthropic's current models take no
  temperature."), saving one through the API is refused ("Anthropic's current models take no
  temperature: leave it empty"), and a value that an older version stored is ignored. They think
  by default, and Qualor sends their thinking back unchanged with each turn of a conversation, as
  they require. A key of the whole organisation that is not scoped to a workspace needs its
  **Workspace ID**, which Qualor sends as `anthropic-workspace-id` on every request. Without it the
  provider refuses the call, and the Test says "This key is not scoped to a workspace: give its
  workspace ID above." (`PROVIDER_WORKSPACE_REQUIRED`).
- **Room to think.** A model that thinks counts its thinking in the output limit. So review and
  reply calls ask for 16 000 output tokens more than the answer needs, and Explain, Suggest triage,
  Suggest a fix and the Test for 4 000 more. The room costs nothing unless the model uses it. A
  model that takes less (a cap of its own, or a server with a small context window) refuses the
  call, each server in its own words and some with a 422 (Hugging Face TGI). Qualor asks again,
  once, in the same call without the room after any such refusal (a 400 or a 422), unless the
  refusal is about something else: the workspace, tools, the Responses API or streaming. When the
  answer comes back, it remembers that server and model until the server restarts, and asks
  without the room from then on. For a context window that the prompt shares with the answer, in
  the words of vLLM or Anthropic, it remembers nothing, so a vLLM with a small window pays one quick
  refusal on each call. When the second ask is refused too, its error is what the call reports. How
  the room counts in a review's budget is in
  [Budgets and today's usage](./ai-review.md#budgets-and-todays-usage).
- **A refusal fails that step.** A model can refuse a request. Qualor reads a refusal as an answer
  that could not be read, so the step fails, as [AI review](./ai-review.md#models-that-work) says,
  and it never falls back to a model you did not choose.

### Model tiers

The work of AI review falls into three tiers, and you can give each its own model. Only the
standard model is required:

| Tier | Setting | What runs on it |
|---|---|---|
| Strong | **Strong model** | the judge of a review, and the second check of its security findings |
| Standard | **Model** | the reviewers (quality, tests, security and performance), the answers to replies, and Explain, Suggest triage and Suggest a fix |
| Fast | **Fast model** | the quality reviewer of a review of 10 changed lines or fewer |

The strong and the fast model are set under the switch **Use a stronger and a faster model for
parts of AI review**; switched off, both tiers use the standard model. A tier you leave empty uses
the standard model, and so does a tier whose model is the standard model's own name. The assignment
is fixed: you choose each tier's model, not what work a tier does.
The security reviewer that a sensitive path adds to a small review stays on the standard model, as
do the reviewers of every larger review.

- **Prices.** With prices entered, a tier that has a model of its own needs its prices too
  ([Budgets and limits](#budgets-and-limits)), and each call is costed at the prices of the model it
  went to.
- **The warning.** What an organisation admin confirms to switch AI review on names every model,
  sorted, such as `api.openai.com (gpt-5.6-terra, gpt-6-luna, gpt-6.1-sol)`. Changing, adding or
  dropping any of them asks for the confirmation again, and AI review stops until an organisation
  admin gives it ([The warning](./ai-review.md#the-warning)).
- **The Test** checks each model on its own ([above](#the-provider-instance-admins)).
- **The records.** Each call is recorded with the model it went to ([Retention and
  audit](#retention-and-audit)).

### Organisations and projects

The **Organizations** section of the same page lists every organisation, 25 at a time (**Show 25
more**), with a filter. A row shows whether the organisation may use AI (**Allowed** or **Not
allowed**), its **Assistant features**, how many of its projects are **Never sent**, and what its
own admins switched on (**AI review**, **AI review (paused)**, **Fix suggestions** or **Fix
suggestions (not running)**). **Open** chooses the organisation in the header and goes to its own
AI page. **Edit** opens the organisation's editor under its row. For an organisation named Acme it
holds these, saved with **Save Acme**:

- **Allow AI in Acme**: nothing of an organisation is ever sent while it is off, and organisations
  start off. While it is on, the organisation's people can use the features below, and its admins
  can switch on AI review, which sends repository code, and automatic fix suggestions. Switching it
  off where AI review is on says "AI review is on in Acme: it stops, and its repository copies are
  deleted, when you save."
- **Assistant features**: **Explain**, **Suggest triage** and **Suggest a fix**, each off until
  switched on. Switching **Suggest a fix** off where the organisation has automatic fix suggestions
  on says "Acme's automatic fix suggestions stop without it."
- **Never sent to the provider**: the organisation's projects whose issues are never explained,
  triaged or fixed, and that AI review never reviews; its copies of their repositories are deleted.
  **Add a project** searches the organisation's projects, and **Remove** takes one off the list.

**Never send these paths**, in the **Data and privacy** section, takes up to 100 globs (such as
`legacy/**` or `**/*.generated.ts`), added one at a time with **Add**, matched against the issue's
path in every organisation.

An organisation admin sees what was chosen for their organisation, read-only, in the **Assistant**
section of **Settings → AI**.

The AI assistant panel appears in the issue view only for an organisation that may use AI, and each
action only when its feature is on and the issue can be sent. For a project an instance admin
excluded, the panel says "An instance admin excluded this project from AI." in place of the
actions. Any member of the organisation can ask and post, as for changing an issue's status:
signed in, or with a token that has the `write` scope (see
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

1. An instance admin has connected a provider and allowed the organisation to use AI with
   **Suggest a fix** on ([Configuration](#configuration)). Automatic fix suggestions follow from
   that: they cannot be switched on for an organisation that has none of it.
2. An **organisation admin** opens **Settings → AI** (the organisation chosen in the header). In
   its **Automatic fix suggestions** section they switch on **Post fix suggestions
   automatically**, choose the **Minimum severity** and **At most per analysis** under it, and
   press **Save fix suggestions**. The section also lists the projects whose admins opted out.
   While the organisation (Acme, say) lacks **Suggest a fix**, the switch is disabled under "Needs
   Suggest a fix for Acme, which an instance admin turns on in Settings → AI provider."; when
   **Suggest a fix** goes off after they were switched on, the section says "On, but not running:
   Suggest a fix is off for Acme. An instance admin turns it on in Settings → AI provider." The
   permission is `org.ai.manage`, held by the Organization admin role
   ([Roles and the audit log](./roles-and-audit.md)). Without a licence that lists
   `llm.auto-fix` the page has no such section, and its Status ends with "Automatic fix suggestions
   are part of Qualor Enterprise." The old address `/settings/auto-fix` opens the section.
3. A **project admin** can opt one project out in the project's **AI** panel (**Project →
   Settings → AI**), with the switch **Post fix suggestions to this project's merge requests
   automatically** under **Fixes**. It saves at once. A project cannot switch it on when the
   organisation has it off: the panel then says "Acme has automatic fix suggestions off. An
   organization admin switches them on in Settings → AI.", and for a project excluded from AI it
   says "Not for a project excluded from AI." instead of offering the switch.

Switching it off, or losing the licence, stops new suggestions at once, including requests already
waiting, and posts nothing more. Suggestions already posted stay on the merge request. A
suggestion a person asked for is never posted automatically.

### Budget and cost

An automatic suggestion is an ordinary fix request of the organisation: it counts against the
organisation's **daily fix budget** (**Fix suggestions per day**), its tokens and its estimated
cost ([Budgets and limits](#budgets-and-limits)). Not against a person's hourly bound, since no
person asked. Your fix budget is the only limit. When the budget is used up, Qualor stops asking for
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

4. In **Settings → AI provider**, choose **OpenAI-compatible**, base URL `http://ollama:11434/v1`,
   the model's name as `ollama list` shows it, and no API key. Press **Save and test**, then allow
   the organisations you want under **Organizations**, with the features they may use.

A local model on a CPU can be slow. If requests end with "The model did not answer in time", raise
the **Timeout** in **Connection options** (up to 600 seconds). Give Ollama the memory its model
needs. vLLM and LM Studio are set up the same way, with their own host and port in
`QUALOR_LLM_INTERNAL_HOSTS`.

To run the server with its database on a separate network with no route out, as the repository's
own `deploy/docker-compose.yml` does, see "A local model with Ollama" in
[`deploy/README.md`](../../deploy/README.md#a-local-model-with-ollama).

## Budgets and limits

The instance admin sets the assistant's limits in the **Limits** section of **Settings → AI
provider**, under **Explain, Suggest triage and Suggest a fix**. They are the same for each allowed
organisation, per UTC day, and automatic fix suggestions count as fix suggestions:

| Limit | Default |
|---|---|
| Explanations per day | 200 |
| Triage suggestions per day | 100 |
| Fix suggestions per day | 25 |
| Tokens per day (sent and received) | 1 000 000 |
| Limit the cost | off. On, **Cost per day** in US dollars. It needs the models' prices: without them the switch is disabled under "No prices are set, so a cost limit would count nothing. Enter them under Provider → Prices." |
| Asks per person and hour | 30, the three features together |

An organisation's use today is on its own page: the **Today** line of the Status card in
**Settings → AI** has an **Assistant** meter of its tokens against **Tokens per day**, with the
explanations, triage suggestions and fixes so far ("Explanations 12 · Triage 3 · Fixes 1"), and
says "Budget reached for today" once it is. The page's **Assistant** section lists the limits.

**Prices.** The estimated cost needs prices, in US dollars per million tokens. Switch on **Count
costs with these models' prices** in the **Provider** section: it shows an **Input** and an
**Output** price for the standard model and, for each tier that has a model of its own
([Model tiers](#model-tiers)), for that model, each row named by its model. With prices entered, a
tier with its own model needs its prices too: saving without them is refused ("Give the strong
model's prices too", "Give the fast model's prices too"), and so is, through the API, a pair of
prices for a tier that has no model of its own ("Set the strong model first"). A call is costed at
the prices of the model it went to. When a cost limit is set, Qualor turns what is left of it into
tokens at the dearest price among your models, since the model of the next call is not known ahead.

The **AI review** group of **Limits** is not a budget of this assistant. Its switch **Cap the
tokens an organization may give AI review**, with **Tokens per day, per organization** under it,
caps what an organisation admin may give [AI review](./ai-review.md#budgets-and-todays-usage),
which has budgets of its own. Off, there is no cap: "Off: no cap, and organization admins may allow
up to 1,000,000,000 tokens a day."

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

- **Keep a copy of what is sent**, in the **Data and privacy** section of **Settings → AI
  provider** (off by default), keeps the exact data sent, after masking, for 1–90 days (**Keep
  for**, default 7).
- The answer is kept, since the issue view shows it and a fix is posted from it. For a fix, the
  lines it replaces are kept with it, to check them against the merge request before posting.
- Request records are deleted after **90 days**, or with their organisation or project. The record
  of an automatic fix suggestion stays while its issue exists, since it is what keeps Qualor from
  suggesting that fix again.
- Each finished request also writes one log line with the same details, never the content or the
  key. When the provider answered with an error, the line has its HTTP status (`providerStatus`).
- The calls of an [AI review](./ai-review.md#how-long-copies-live) are recorded the same way, with
  the feature `review` (a review's calls) or `review-reply` (the answers to replies), the model that
  call went to, and no issue or person. With **Keep a copy of what is sent** on, their prompts are
  kept too, for the days set there, and the model's answers stay with the record. The prompts hold
  the code the model was shown, and for a reply what people wrote in the thread.

Today's use and budgets for an organisation are at `GET /api/v0/organizations/{id}/ai`.

## Troubleshooting

| Message | What to do |
|---|---|
| "The model did not answer in time" | raise the **Timeout** in the **Connection options** of **Settings → AI provider**; a local model on a CPU needs more |
| "The model provider could not be reached" | check the base URL and that the server can reach the host. After 5 failures in a row Qualor pauses calls to that address for 10 minutes, and failures of AI reviews count too ([The provider](#the-provider-instance-admins)) |
| "The model provider is rate limiting Qualor; try later" | the provider's own limit. Qualor retries after the time the provider asks for; try again later, or lower the budgets |
| "The provider refused the API key (HTTP 401)" | set a valid key; check the key header (`api-key` for Azure) |
| "The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit" | the key is valid but may not use this model: check the model's name, the key's project or workspace permissions, and the account's billing or credit |
| "The model does not accept max_tokens; set the output limit parameter to max_completion_tokens in the AI provider settings" (or the other way round) | the model refused the output limit parameter, also when asked again without the room to think: choose the other **Output limit parameter** in **Connection options** |
| "The provider refused the request; check the base URL and the model" | an OpenAI-compatible base URL usually needs `/v1`; check the model's name. OpenAI's newer models need the `max_completion_tokens` output limit parameter; some servers need **Ask for a JSON object** off |
| "The provider's answer was not understood" | the address is not a chat completions, Responses or Anthropic Messages API (check the **API** setting too), or the answer was over 1 MiB |
| "This key is not scoped to a workspace: give its workspace ID" (the Test's line ends "above", other pages "in the AI provider settings"; the code is `PROVIDER_WORKSPACE_REQUIRED`) | an Anthropic key of the whole organisation needs its **Workspace ID** (`wrkspc_…`) in **Settings → AI provider**. The request is not retried |
| "This model takes tools only through the Responses API: choose Responses in Connection options." (under the Test's lines) | choose **Responses** under **API** in **Connection options**, then press **Save and test** ([The current models](#the-current-models)) |
| "Anthropic's current models take no temperature: leave it empty" | an Anthropic provider cannot be saved with a temperature. The page sends none for it; through the API, leave `provider.temperature` empty |
| "Give the strong model's prices too" or "Give the fast model's prices too" | prices are entered, and a tier has a model of its own: enter that model's input and output prices, or clear all prices ([Budgets and limits](#budgets-and-limits)) |
| "The provider's address is not allowed" | the operator lists the host with its port in `QUALOR_LLM_INTERNAL_HOSTS`, or use an `https` address that resolves to public addresses |
| "The stored API key can no longer be read; set it again" | `QUALOR_SECRET_KEY` changed. Enter the API key again |
| "The model's answer could not be used" | the model did not answer with the expected JSON, or its answer was cut off. Ask again, or try another model |
| "The model declined to answer" | the provider's content filter or the model refused |
| "The suggested fix was not safe to show" | the fix broke a safety rule (outside the shown lines, a secret, control characters, or a GitLab quick action). Ask again or fix it by hand |
| "This organization may not use AI." | an instance admin allows the organisation, with the feature on, under **Organizations** in **Settings → AI provider** |
| "Findings of secret rules are never sent" / "Issues in credential files are never sent" | by design: Explain, Triage and Fix never send them. Handle these issues without the assistant |
| "An administrator excluded this issue's path or project" | by design; an instance admin can change the exclusions |
| "Something changed since you asked; ask again" | the settings or the issue changed (a new analysis) while the request waited |
| "The request was interrupted; ask again" | the server crashed or was killed while the request ran, a stop took longer than its grace period (60 seconds in the guide's Compose file and Helm chart), or the request failed unexpectedly. A request that is waiting or running when the server is stopped in time goes back to the queue and is answered after the restart |
| "Not posted: the merge request has a newer commit" | analyse the latest commit, then ask for a new fix |
| "Not posted: the lines are not added lines of the merge request" / "the code on the merge request differs" | suggestions can only replace lines the merge request added, unchanged. Fix it by hand |
| No automatic suggestions on a merge request | check, in order: the licence lists `llm.auto-fix`; **Post fix suggestions automatically** is on in **Settings → AI** for the organisation, and the organisation may use AI with **Suggest a fix** on in **Settings → AI provider**; the project did not opt out and is not excluded from AI; the project is mapped to GitLab or GitHub; the findings are new in this merge request, open and at the minimum severity; no suggestion was made for them before; the daily fix budget is not used up |
| No **Automatic fix suggestions** section in **Settings → AI**, whose Status ends with "Automatic fix suggestions are part of Qualor Enterprise." | the licence does not list `llm.auto-fix`, or it lapsed: apply a key that lists it ([Enterprise](./enterprise.md)) |
| "Automatic fix suggestions need the Enterprise plan." in the **Automatic fix suggestions** section, or the API's 403 `FEATURE_NOT_LICENSED` | the licence does not list `llm.auto-fix`; on the page, it lapsed while the page was open. Apply a key that lists it, then open the page again |
| "Switching them on needs AI set up on this server and allowed for this organization, with Suggest a fix. …" when saving automatic fix suggestions (the API's 409 `AI_DISABLED`) | an instance admin connects a provider, allows the organisation and turns on **Suggest a fix** first, in **Settings → AI provider** |
| 409 `AUTO_FIX_OPT_OUT_LIMIT_REACHED` | an organisation lists at most 1 000 projects that opted out; let a project back in first |
| "The project is not mapped to GitLab or GitHub" | map it in **Settings → Repositories** ([GitLab](./gitlab.md), [GitHub](./github.md)) |

Error codes in the API: `AI_DISABLED` (409), `AI_NOT_ELIGIBLE` (409, with the reason in `detail`),
`AI_POST_NOT_POSSIBLE` (409, with the reason in `detail`), `AI_QUOTA_EXCEEDED` (429 with
`Retry-After`) and `RATE_LIMITED` (429). A failed request's `error.code` is one of `PROVIDER_TIMEOUT`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_REFUSED_KEY`,
`PROVIDER_WORKSPACE_REQUIRED`, `PROVIDER_REJECTED_REQUEST`, `PROVIDER_BAD_ANSWER`,
`URL_NOT_ALLOWED`, `KEY_UNDECRYPTABLE`, `MALFORMED_OUTPUT`, `OUTPUT_TRUNCATED`, `MODEL_REFUSED`,
`OUTPUT_REFUSED`, `AI_DISABLED`, `SETTINGS_CHANGED`, `ISSUE_CHANGED`, `ISSUE_GONE` or
`REQUEST_ABANDONED`.
