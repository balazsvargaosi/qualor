# MCP server for AI agents

Qualor has a built-in MCP server (Model Context Protocol), so an AI agent such as Claude Code, Cursor
or claude.ai can work with Qualor itself. The agent reads the quality gate of a branch or merge
request and its issues, asks the [AI assistant](./ai-assistant.md) to explain a finding or suggest a
fix, and, if you allow it, marks a finding as a false positive or won't fix with a comment. It does
all of this **as the person who signed in, with that person's rights**: it never sees more than they
do. There is nothing to install. It is on as soon as the server has a public address, and each person
connects their own agent.

## Requirements

- The server has `QUALOR_PUBLIC_URL` set to the address people open Qualor at, for example
  `https://qualor.example.com` ([Install the server](./install-server.md#server-settings)). Without
  it the MCP server is off, and **Settings → MCP** says so.
- Qualor is served over **HTTPS**, usually by a reverse proxy in front of it. AI clients refuse to
  sign in over plain `http://`, except for `localhost`.
- If Qualor is served under a path, such as `https://example.com/qualor`, the proxy also sends the
  addresses that start with `/.well-known/oauth-` at the root of the host to Qualor, unchanged
  ([Reverse proxy and TLS](./install-server.md#reverse-proxy-and-tls)).
- The person has a Qualor account. Single sign-on works as usual: the sign-in page of the browser is
  the one you already use.

The MCP address is your server's address followed by `/mcp`: `https://qualor.example.com/mcp`.
**Settings → MCP** shows it with a Copy button.

## Connect Claude Code

```bash
claude mcp add --transport http qualor https://qualor.example.com/mcp
```

Then type `/mcp` in Claude Code, pick `qualor` and choose **Authenticate**. Your browser opens
Qualor. Sign in if you are not signed in, and click **Allow**. The agent can use the tools from then
on.

## Connect Cursor

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "qualor": {
      "url": "https://qualor.example.com/mcp"
    }
  }
}
```

Cursor then asks you to sign in to the server; it opens the same Qualor page.

## Connect claude.ai or Claude Desktop

Open **Settings → Connectors → Add custom connector**, name it `Qualor` and enter the address
`https://qualor.example.com/mcp`. Click **Connect** and allow the app in Qualor.

Claude reaches your server from the internet in this case, so the server must be reachable from
there. A server on a private network works with Claude Code and Cursor on a laptop inside that
network, but not with claude.ai.

## Other clients

Any client that supports MCP over HTTP with OAuth sign-in works. Give it the MCP address. It finds
the rest by itself. Qualor tells it where to register and sign in, and the client opens your
browser.

## What the agent can do

The page where you allow the app lists what it can do. Reading is always included. Changing issue
statuses is a separate box, **Change issue statuses**, which appears only if the app asks for it;
untick it to let the app read only. This choice holds the first time you allow an app: once it may
change statuses, allowing it again keeps that right. To take it away, disconnect the app
([Disconnect an app](#disconnect-an-app)) and connect it again with the box unticked.

| Tool | What it does | Needs |
|---|---|---|
| `qualor_projects` | Lists the projects you can see, so the agent can match the `projectKey` of `qualor.yml` | read |
| `qualor_gate_status` | Whether the quality gate of a branch or merge request passes, and which conditions fail. With a commit SHA, also whether CI has analysed that commit yet | read |
| `qualor_issues` | The issues of a branch or merge request, most severe first; by default the open issues in new code, which is what the gate counts | read |
| `qualor_issue` | One issue in full: the code, secondary locations, the rule and its history | read |
| `qualor_rule` | What a rule checks and how to fix what it reports | read |
| `qualor_measures` | Coverage, duplication and ratings; with a file, its covered and uncovered lines | read |
| `qualor_explain` | Asks the AI assistant to explain an issue | read, and the AI assistant on |
| `qualor_suggest_fix` | Asks the AI assistant for a fix. Nothing is posted anywhere | read, and the AI assistant on |
| `qualor_transition_issue` | Marks an issue false positive or won't fix, or reopens it, with a mandatory comment | change issue statuses |

The server also offers one ready-made prompt, **Fix the quality gate** (`fix_quality_gate`). Clients
show it as a command or a menu entry. It tells the agent to read the failed conditions, fix the
issues in new code, push, and check the gate again after CI.

Branches and merge requests are named as in Qualor: a branch by its name, a merge or pull request by
its number. Without either, the agent looks at the project's main branch.

## Permissions

- **The role decides.** The agent has your role in each project. A Viewer can read; asking the AI
  assistant and changing an issue's status need the same role as in the web UI (Maintainer or
  above, see [Roles](./roles-and-audit.md#roles)). The agent is told "forbidden" for anything you
  could not do yourself.
- **Reading and changing are separate.** On the consent page the box **Change issue statuses**
  appears only if the app asks for it, and it is yours to untick. An agent that only reads cannot change an issue, whatever it tries.
- **A status change by the agent says so.** Its comment ends with a line naming the app, so
  reviewers can tell it from your own.
- **The token works only on the MCP address.** It is not an API token: it cannot call the REST API,
  the CLI or the web UI, and it does not replace a [personal token](./users-projects-tokens.md#tokens).
- **The AI assistant keeps its own rules.** `qualor_explain` and `qualor_suggest_fix` send the same
  redacted data as the buttons in the issue view, and only when an administrator switched the
  assistant on for the organisation ([what is sent](./ai-assistant.md#what-is-sent-and-where)).
- The agent cannot create or delete projects, change settings or manage users. It sees nothing the
  person would not see.

Access tokens last an hour and the app renews them by itself. An app you do not use for 90 days is
disconnected.

## The agent's loop

The quality gate is computed by the server after CI analysed a commit, not on the agent's machine.
The agent's loop is therefore:

1. The agent fixes the code and **pushes**.
2. **CI runs `qualor scan`** ([GitLab](./gitlab.md), [GitHub](./github.md), [other CI](./other-ci.md)).
3. The agent calls `qualor_gate_status` with the pushed commit SHA. While the state is `not_yet` or
   `in_progress`, CI has not delivered yet: it waits a minute or two and asks again.
4. At `analyzed` it reads the gate and the failed conditions and goes back to step 1 if the gate
   still fails.

The states of a commit are `analyzed`, `in_progress`, `failed` (the analysis ended with an error)
and `not_yet` (Qualor has not seen the commit). If the same commit was analysed more than once, the
newest analysis counts. Without a commit SHA the tool reports the latest analysis of the branch, which
may be an older one.

## Disconnect an app

**Settings → Connected apps** lists the apps you allowed, with their rights and when they were last
used. **Disconnect** ends an app at once: its tokens stop working, and the next sign-in asks you again.
An app you disconnected, or one that was idle for 90 days, shows the **Allow** page again the next
time.

An administrator can see and disconnect the apps of any user in **Settings → Users → Connected apps**,
for example when someone leaves or a laptop is lost.

## For administrators

**Settings → MCP** (instance admins) controls which apps may connect:

- **Let apps register themselves** (dynamic registration). Most agents register this way, so leave it
  on unless you want an allow-list only. Their consent page says "Not verified: this app registered
  itself", because anyone can register under any name. The address the browser returns to is always
  shown, and users should allow only an app they started themselves.
- **Accept apps identified by a metadata URL (CIMD).** Some clients, such as claude.ai, identify
  themselves by an `https` address that describes them. Qualor fetches that address when someone
  signs in. The consent page shows the address's host. Turn this off if the server must make no such
  request.
- **Allowed apps.** One client id per line, or a URL prefix ending in `/`. When the list has entries,
  only those apps can connect, and an app that is not on it cannot sign in or renew its login any more.
  An app that is already connected keeps working for up to an hour, until its current login runs out.
  To stop it at once, disconnect it in **Settings → Users → Connected apps**.

The page also shows the MCP address, or tells you to set `QUALOR_PUBLIC_URL`.

With an audit log ([Roles and the audit log](./roles-and-audit.md)), Qualor records `oauth.client_registered`,
`oauth.grant_created`, `oauth.grant_revoked` (with who ended it, or that a stolen refresh token was
reused) and `oauth.settings_changed`. Each is in the audit log and in its export.

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| **Settings → MCP** says "Set `QUALOR_PUBLIC_URL`", and `/mcp` answers 404 | The server has no public address. Set `QUALOR_PUBLIC_URL` and restart |
| The client signs in, then asks again and again (a 401 loop) | `QUALOR_PUBLIC_URL` differs from the address the client uses: a different host, `http` instead of `https` or a path the proxy changes. The token is issued for one exact address. Fix the variable or the proxy |
| The client says it cannot connect or refuses the address | The server is on plain `http://` away from `localhost`, or claude.ai cannot reach it from the internet |
| "The administrator of this server does not allow this app." on the consent page | An administrator set an allow-list in **Settings → MCP** that does not include the app |
| This request has expired or was already answered | A sign-in request lives for 10 minutes. Start the connection again from the app |
| A tool says the AI assistant is off (`AI_DISABLED`) | An administrator has not switched on the [AI assistant](./ai-assistant.md) for the organisation, or the issue's project or path is excluded. The other tools work |
| "Project … has no analysed branch" | CI has not run `qualor scan` on that branch or merge request yet. It appears after the first analysis |
| "Matches several commits" (`AMBIGUOUS_COMMIT`) | The short SHA the agent gave fits more than one commit. It should send more characters |
| "Searched the first … branches" (`SEARCH_INCOMPLETE`) | The project has very many branches or analyses and the one asked for was not among the newest. Name it exactly |
| Forbidden when changing an issue | Your role in the project cannot triage, or the agent was allowed to read only. Connect the app again and tick **Change issue statuses** (the box appears only if the app asks for it) |
| An agent that runs several processes with one login is signed out from time to time | Qualor ends a login when the same refresh token is used twice, which is what a stolen token looks like. If several processes of one agent share a login and renew at the same moment, one of them loses it. Connect again; if it happens often, run the agent's MCP connection in one process |

More errors are in [Troubleshooting](./troubleshooting.md).
