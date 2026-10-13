# The support bundle

When something goes wrong and you ask for help, the first questions are always the same: which
version, which settings, is the database healthy, what failed recently. The **support bundle**
answers them in one zip file, without any secret in it. You download it, read it if you like, and
send it to us.

It needs a Business or Enterprise licence key that lists the feature `support-bundle` (see
[Enterprise](./enterprise.md)). The community edition has no support bundle. Qualor never sends the
bundle anywhere: it is downloaded to your computer, and you decide whether to send it.

## What is in it

The file is named `qualor-support-<yyyymmdd-hhmmss>.zip` and is at most 20 MiB. Every file in it is
UTF-8 JSON, except `logs.jsonl`, which holds one JSON log line per line.

| File | What it holds |
|---|---|
| `manifest.json` | when the bundle was made, whether it came from the web UI or the command, which server replica made it, the files in it, and notes (what was cut, what could not be collected) |
| `versions.json` | the server version, Node.js and PostgreSQL versions, whether the database is embedded or external, the platform, whether it runs in a container, the uptime, memory and the number of CPUs |
| `license.json` | the edition, the state (`active`, `grace`, `expired` or `none`), the licence id, the customer, the dates and the features, listed and active. **Never the key** |
| `plugins.json` | the enterprise plugins that loaded, or why one did not |
| `migrations.json` | the applied database migrations and how many are pending |
| `config.json` | the effective configuration: only the settings that are safe to share (port, log level, worker settings, retention, switches, the kind of database). Every other setting shows only `[set]` or `[unset]`. A URL keeps its scheme, host and port only |
| `settings.json` | the settings saved in the database, the same way: for example the AI provider's kind, model and host, and which organisations are enabled, but never a key |
| `health.json` | the readiness checks, the database pool, the database size and the estimated row counts of the 15 largest tables |
| `jobs.json` | the number of jobs by queue and status, and the last 50 failed jobs with their error text (cut to 500 characters, no job data) |
| `analyses.json` | the last 50 failed analyses: the project key, the branch, the time and the error |
| `scm.json` | the GitLab and GitHub connections: host, status, the state of the circuit breaker and the last error (the command's bundle has no live connection state, and its manifest says so). No token, private key or webhook secret |
| `logs.jsonl` | the last server log lines of the replica that made the bundle: at most 5 000 lines and 5 MiB, oldest first. Only in a bundle downloaded from the web UI |

**Never in it:** passwords, tokens and their hashes, `QUALOR_SECRET_KEY`, the database password,
API keys (the AI provider's, SCM tokens), webhook and stream secrets, single sign-on client secrets
and keys, the licence key, source code, issue messages, comments, AI prompts and answers. Error
texts and log lines are also checked against the secret values this server is configured with
before they are written, and a match is replaced by `[redacted]`. A bundle that would be larger than
20 MiB loses its oldest log lines first, then its oldest failed jobs, then its oldest failed
analyses; `manifest.json` says what was cut.

You can unzip it and read every file before you send it.

## Download it from the web UI

An **instance admin** opens **Settings → Support** and selects **Download support bundle**. The
page appears only for instance admins on a server whose licence lists `support-bundle`.

- One bundle is prepared at a time on a server. A second download while one is running fails with
  429 `RATE_LIMITED`; try again in a moment. The download is a plain link, so your browser shows
  the refusal as a failed download or a small error page.
- With several replicas, the logs in the bundle come from the replica that served your request.
  Download it again, or use the command below on the other replicas, to see theirs.
- **Each download is recorded in the audit log** as `support.bundle_downloaded`, with who
  downloaded it and the size ([Roles and the audit log](./roles-and-audit.md#what-is-recorded)).

Through the API, `GET /api/v0/ee/support/bundle` returns the zip to an instance admin, as an
attachment.

## When the web UI is down

The server image has a command that makes the same bundle without the web UI, for a server that
will not start or that you cannot sign in to. Run it in the folder of your Docker Compose file
([Install the server](./install-server.md#the-compose-file)), with `-T` (the zip goes to the
standard output, and the command refuses to write it to a terminal):

```sh
# while the server is running
docker compose exec -T server /usr/local/bin/node dist/main.js support-bundle > qualor-support.zip

# while the server is stopped
docker compose run --rm -T server support-bundle > qualor-support.zip
```

Both use the server's own configuration and licence key, so the command works only where the
server would. Instead of `>`, `--out <file>` writes the zip to a file (inside the container, which
is mostly useful with `docker compose run` and a mounted folder).

The command's bundle has **no logs**: add them yourself, from the server container:

```sh
docker compose logs --no-color --tail 5000 server > qualor-server.log
```

(`docker logs --tail 5000 <container>` does the same.) Send the log file with the zip. Logs
carry the same redaction as the server writes them with, but read them before you send them.

What the command does and does not do:

- It **never changes the database** and records **no audit event**, because nobody is signed in.
  It does not start the web server, the workers or any update check, and it does not run migrations.
- With the embedded database, it uses the database of the running server, or, while the server is
  stopped, starts it for a moment and stops it again. It never creates a new database. If another
  server is using the data folder and does not answer, the command stops with a message: try
  again once the server is up, or after 30 seconds if it has stopped.
- If the database is behind the server (migrations that have not run yet), the command still
  writes what it can. `migrations.json` shows how many are pending, and a section it cannot read
  holds the error instead of its data. A database that was never set up gives no bundle.
- The exit code is 0 when the zip was written, 2 when the licence does not include `support-bundle`
  (or there is no licence), and 1 for any other failure. The message is on the standard error.

## Send it to us

Email the zip, and the log file, to <support@qualor.dev>, with a description of what went wrong and
when. Support is part of the Business and Enterprise plans ([Enterprise](./enterprise.md#plans-and-prices)).

## When the licence lapses

Without `support-bundle` the **Support** page leaves **Settings**, the route answers 403
`FEATURE_NOT_LICENSED` and the command exits with 2. Nothing is deleted. A renewed key brings it
back at the next start.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the command says it will not write the archive to a terminal | you ran it without `-T`, or without `>` or `--out`. Redirect the output to a file |
| the command exits with 2 | the licence does not list `support-bundle`, or it lapsed. Check **Settings → Licence** or the server log |
| the command exits with 1 and names `QUALOR_LICENSE_FILE` | the licence file cannot be read. Check the path and the file's permissions |
| the command says a server "holds" the data folder but its database did not answer | the server is starting or has just stopped. Wait for it, or 30 seconds, and run it again |
| the command says no server is running and the folder holds no database | the volume is empty or wrong. Check the `data` volume of your `compose.yml` |
| the download answers 429 | another bundle is being prepared. Wait and try again |
| the download answers 403 | you are not an instance admin, or the licence has no `support-bundle` |
| `manifest.json` has a note "could not be collected" | one section failed and holds its error. The rest is complete |
