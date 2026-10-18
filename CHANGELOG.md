# Changelog

All notable changes to Qualor are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The GitHub Action [`qualor-dev/scan-action`](https://github.com/qualor-dev/scan-action) scans,
  uploads and fails on the quality gate in one step (`@v0.10`, `@v0` or `@v0.10.0`), and
  `qualor-dev/scan-action/dotnet` does the same for C# around your build. See
  [the guide](docs/guide/github.md).
- The GitLab CI/CD component is released again as 0.10.0, so `@0.10` resolves.
- Slack and Microsoft Teams notifications: in **Settings → Webhooks** (or a project's settings),
  **New webhook** now asks the type. A Slack or Teams webhook posts a formatted message when the
  main branch's quality gate fails or passes again, and a weekly security digest on Monday at 09:00
  in its time zone; **Send test** checks it. The URL is stored encrypted and shown masked. Teams
  uses a Workflows webhook (Office 365 connector URLs are refused). See
  [the guide](docs/guide/chat-notifications.md). The webhooks API gains `kind`, `timezone`,
  `urlMasked` and `POST /api/v0/webhooks/{id}/test`.

## [0.10.0] - 2026-10-18

### Added

- MCP server at `/mcp` with OAuth sign-in (Claude Code, Cursor, claude.ai and other MCP clients):
  quality gate status, issues, rules, measures, the AI assistant and issue status changes;
  **Connected apps** and **Settings → MCP**. It needs `QUALOR_PUBLIC_URL`; see
  [the guide](docs/guide/mcp.md). `GET /api/v0/system/info` reports whether it is on (`mcp`).

## [0.9.0] - 2026-10-16

### Added

- OpenGrep is given the built-in excludes and the `sources.exclude` patterns starting with `**/` as
  `--exclude` arguments whenever it
  selects the files itself (a file list too long for one command line, mostly on Windows, and the
  `semgrep` analyzer). Vendored and minified bundles are no longer parsed, which kept large repositories
  from finishing within the analyzer's time limit. `*.min.mjs` and `*.min.cjs` are built-in excludes.
- Email. Instance administrators set up an SMTP server in **Settings → Email**, or the operator
  sets `QUALOR_SMTP_URL` and `QUALOR_SMTP_FROM` (Helm: `secrets.smtpUrl` and `config.smtpFrom`).
  **Send test** shows the server's answer, and **Recent messages** lists every message with its
  status. Qualor emails the instance administrators 30, 7 and 1 day before the licence expires,
  when its grace period starts and when it ends, and when a webhook delivery gives up (at most once
  a day per webhook); each alert can be turned off. Messages have an HTML and a plain-text part,
  are retried on temporary failures, and their body is deleted once sent.
- Forgotten passwords: with email set up and `QUALOR_PUBLIC_URL` set, **Forgot password?** on the
  sign-in page sends a one-time link that works for 60 minutes. It follows the password sign-in
  policy: break-glass-only servers send links to break-glass admins only, and the demo account and
  single sign-on accounts without a password get none.
- Invitations: instance admins invite a new user by email from **Settings → Users** instead of
  making up an initial password. The link works for 7 days and can be resent or revoked.
- A "Your Qualor password was changed" email after a reset through a link, a change of one's own
  password, or a reset by an administrator (to accounts that have an email address).
- API: `POST /auth/password-reset`, `POST /auth/password-reset/complete`,
  `POST /auth/invitations/inspect`, `POST /auth/invitations/accept`, and
  `POST`/`DELETE /users/{id}/invitation`; `POST /users` takes `invite`, users carry `invitation`,
  and `GET /auth/methods` says `passwordReset`.
- Project notifications by email: press **Watch** on a project to get an email when its quality
  gate fails, when it passes again, and when an analysis fails, on the main branch or on every
  branch and merge request. **Settings → Notifications** lists your watched projects and turns
  notification email off. Every email has a **Stop watching** link that works without signing in,
  and mail apps' one-click unsubscribe works too. Organisation administrators also get the
  failing-webhook email for their organisation.
- API: `GET`/`PUT`/`DELETE /projects/{id}/watch`, `GET`/`PUT /me/notifications`, and the public
  `GET` and `POST /notifications/unsubscribe` (RFC 8058 one-click).
- Dependency licences: every scan now records the project's dependencies and their licences,
  through a second, offline Trivy pass that needs no database. A project's new **Dependencies**
  tab lists them by branch or merge request, with their lockfile line, licences and whether they
  are direct, filters, and how many have a known licence; `GET /api/v0/projects/{id}/dependencies`
  returns the same. npm and Composer lockfiles carry the licences; for pnpm, Yarn, Go, NuGet and
  Maven, install the dependencies in the scan job before `qualor scan` (Gradle gives licences only
  in part). Development dependencies and lockfiles the scan does not analyse are left out. The
  new `qualor.yml` keys `analyzers.trivy.licenses` (`auto`, `true` or `false`) and
  `analyzers.trivy.licenseTimeoutSeconds` (default 300) control the pass; a failure or a timeout
  is a warning (`LICENSE_SCAN_FAILED`, `LICENSE_SCAN_TIMEOUT`) and never fails the scan. The
  measure `unknown_licenses_ratio` gives the share of packages with an unknown licence. This is
  in every edition. See
  [Dependency licences](docs/guide/dependency-licenses.md).
- A licence policy (Business and Enterprise): an organisation admin sets, in **Settings → Licence
  policy** or through `GET/PUT /api/v0/organizations/{id}/license-policy`, which licences the
  organisation's projects may use: Qualor's licence groups (network copyleft, strong copyleft,
  weak copyleft, non-commercial or source-available), SPDX ids to forbid or to allow, or an allow
  list. A dependency under a forbidden licence becomes an issue `license:forbidden` (severity
  high) of the new quality **Licensing**, which has no rating; with **Warn about dependencies with
  unknown licences**, a package without a licence becomes an Info issue `license:unknown`. They
  get the new-code treatment and the merge request decoration, won't fix accepts one package, and
  the new gate metrics `licensing_issues`, `forbidden_licenses` and their `new_` forms count them.
  The built-in "Qualor way" gate is unchanged: its `new_issues > 0` already fails on a new
  forbidden licence. Compliance and portfolio reports leave licence issues out. A policy change
  applies from each project's next analysis. It needs a licence key listing the new feature
  `license-policy`. The new permission `org.licenses.manage` (Organization admin) and the audit
  action `organization.license_policy_changed` go with it.
- Name suggestions: the user name fields of **Settings → Members** (Add member), **Project →
  Access** and the **Settings → Audit log** filter suggest active users as you type, by the start
  of their user name or of a word of their display name. Pick one with the arrow keys and Enter, or
  click it; typing the whole user name still works. Add member leaves out the organisation's
  members, and Access leaves out the people who already have a role on the project.
- API: `GET /users/search?q=` returns up to 10 matching active users (id, user name and display
  name; never the email address), with `limit`, `excludeOrganization` and `excludeProject`. It has
  the permission of `GET /users/lookup` and allows 60 requests a minute per caller.
  `GET /organizations/{id}/members` takes `q` with the same match.
- Qualor's security rules cover C# (ASP.NET Core): 12 rules for SQL, command, LDAP, XPath and
  regular expression injection, path traversal, SSRF, XSS, open redirects, unsafe deserialization,
  XML external entities and disabled TLS verification, in qualor-rules 2026.10.5 (69 rules, which
  the images pin). They need Qualor 0.9.0 or later:
  Qualor 0.8.0 and older refuse a rules pack that holds C# rules (its images pin their own pack and
  are unaffected).
- C#: under `qualor dotnet begin` and `end`, Qualor's own Roslyn taint engine runs these rules on
  the whole solution in place of OpenGrep, for the files of the projects the build compiled. It
  follows request data across methods, files and projects and into the code generated for Razor
  views and components, and shows the path as each finding's related locations. Its budget is 10
  minutes and, by default, half of the job's memory (at least 4 GB where the machine has it,
  and 1024 MB left free where the job has at least 2 GB; `QUALOR_TAINT_TIME_LIMIT`, `QUALOR_TAINT_MEMORY_LIMIT`). When it cannot give a
  complete result, the OpenGrep C# rules run as before and the report warns
  (`TAINT_ENGINE_FALLBACK`) with the reason. A finding whose path goes through stored data, a
  lookup by a request key or a call or view the engine could not narrow down is marked
  **Possible** on the issue list, the issue and file pages, in merge request comments and pull
  request annotations, and in the GitLab Code Quality and SAST reports; the issues API returns it as `confidence` (`high`, `medium`, or `null` when the analyzer
  sets none).

### Changed

- C#: a project the engine could not load falls back to the OpenGrep rules (fallback reason `load`); a project
  with compile errors or unresolved references is still analysed and reported once as
  `TAINT_ENGINE_PROJECT_ERRORS`. The engine's memory limit defaults to half of the job's memory (the container's
  limit counts). `qualor dotnet begin` refuses a checkout path that contains a semicolon, which the compiler
  rejects in its Roslyn log option.
- **Breaking:** `license` and `trivy-licenses` are now reserved engine ids: `license` is the engine
  of the licence policy's issues, `trivy-licenses` the scanner's licence pass. A `qualor.yml`
  `sarif:` entry with `engine: license` or `engine: trivy-licenses` is a configuration error
  (exit 2): rename it. A SARIF file whose tool is named `license` or `trivy-licenses` is reported
  as `ext-license` or `ext-trivy-licenses`.
- C#: `qualor dotnet begin` runs the SDK's analyzers in the Recommended mode with all security
  rules on (it was the All mode). Noisy rules such as CA2007 are no longer reported, so their open
  issues close at the next scan. Builds of large solutions no longer stall: one rule of the All
  mode (CA1508) never finished on a method that passes a large dictionary initializer, and the
  mode cost three times the analyzer time.

## [0.8.0] - 2026-10-14

### Added

- Compliance reports (Enterprise): OWASP Top 10 2021 and 2025, CWE Top 25 2025, OWASP ASVS 4.0.3
  and PCI DSS 4.0.1 §6.2.4, for a project branch or an organisation, as JSON, CSV and PDF, kept
  for a year with a SHA-256 to verify them. Create them on a project's **Compliance** tab or in
  **Settings → Compliance reports**, or through `/api/v0/ee/compliance`. They need a licence key
  listing the new feature `compliance-export`. Project admins and organisation admins create a
  project's reports (the permission `project.compliance.create`); organisation admins create the
  organisation's and delete reports (`org.compliance.manage`). The audit log records each report
  created, downloaded or deleted. See [Compliance reports](docs/guide/compliance-reports.md).
- Portfolio reports (Enterprise): **Portfolio** in the top bar shows the quality of every project
  you can read, of one organisation or of all of them, on each project's main branch: quality
  gates, security and reliability ratings, lines of code, coverage and duplication weighted by
  lines of code, open issues by severity, secrets and vulnerable dependencies. It adds 12-week or
  12-month trends, a table per organisation, and four lists of the projects that need attention
  (failing gates, the worst security ratings, the most blocker and high issues, no analysis in 30
  days). Download it as CSV (one row per project) or as PDF, or read it through
  `/api/v0/ee/portfolio`. Each user sees only the projects they can read. It needs a licence key
  listing the new feature `portfolio`. See [Portfolio reports](docs/guide/portfolio.md).
- Automatic fix suggestions (Enterprise): an organisation admin can switch on, in **Settings →
  Automatic fixes**, fix suggestions for the new findings of each analysed merge request or pull
  request. Qualor asks the AI assistant's model on its own and posts the answers as a GitLab
  suggestion or a GitHub suggested change, with a line saying they were posted automatically.
  The admin chooses the minimum severity (default high) and the maximum per analysis (1 to 25,
  default 10); a project admin can opt a project out. Only new-code findings are used, an issue
  is never suggested twice, the organisation's daily fix budget applies, and the safety checks
  are those of a person's suggestion. It is off by default and needs a licence key listing the
  new feature `llm.auto-fix`. This is the one case where Qualor calls the model without a click.
  The new permission `org.ai.manage` (Organization admin) and the audit actions
  `organization.auto_fix_changed` and `project.auto_fix_changed` go with it. See
  [Automatic fix suggestions](docs/guide/ai-assistant.md#automatic-fix-suggestions-enterprise).
- The support bundle (Business and Enterprise): **Settings → Support** downloads one zip with the
  versions, the configuration and settings without any secret, the licence state, the health of
  the database and queues, the recent failed jobs and analyses, the connections to GitLab and
  GitHub and the recent server logs, for an instance admin; the download is recorded in the audit
  log (`support.bundle_downloaded`). When the web UI is down, `node dist/main.js support-bundle`
  in the server image writes the same zip, without logs, and records nothing. It needs a licence
  key listing the new feature `support-bundle`. See [The support bundle](docs/guide/support-bundle.md).
- While telemetry is on, the server checks Docker Hub daily for a newer release: it logs it, shows
  instance admins a dismissible banner and a note in the user menu, and `GET /api/v0/system/version`
  returns it as `latest`, which `qualor scan` logs. `QUALOR_TELEMETRY=false` turns it off. See
  [Telemetry](docs/guide/telemetry.md#update-check).

## [0.7.1] - 2026-10-12

### Added

- `qualor import sonarqube` maps SonarQube's taint rules (`javasecurity`, `jssecurity`,
  `tssecurity`, `pythonsecurity`, `gosecurity`) to Qualor's own security rules of the same kind,
  such as `javasecurity:S3649` to `qualor:java/sql-injection`. The mappings are pending review, so
  they carry issue statuses (false positive, accepted) and leave profiles unchanged.

### Changed

- Qualor's own security rules: `qualor/scanner` runs qualor-rules 2026.10.4 (57 rules). Taint
  rules follow request data through the functions of one file: a value that goes into a helper
  function in the same file and comes back out is still followed. The scanner runs them this way
  whenever the rules release says it was tested that way. Fewer false positives, above all in the
  Java injection rules: on the OWASP Benchmark their false-positive rate fell from 45 % to 19 %.
  Python: requests in Starlette and FastAPI middleware, the program of `os.exec*()` and
  `os.spawn*()`, PowerShell's `-File` and `-CommandWithArgs`, and the TLS switches of redis-py,
  Motor and OpenSearch's `ssl_assert_hostname`. Java: disabled TLS checks in OkHttp, Apache
  HttpClient and Jakarta REST clients, XML `Validator`s, and pages fetched with `HttpClient` from
  a fixed origin taken as safe in XSS. JavaScript: XSS through the output `execFile()` hands to
  its callback, pages fetched from a configured origin taken as safe, and awaited Next.js
  redirects. Go: XSS through buffers and the request body copied to the response, PowerShell's
  `-File` and `-CommandWithArgs`, and dangerous calls inside a comparison; code that only serves a test is
  no longer reported. Scans are faster: every rule now skips files that cannot contain what it
  looks for.

### Fixed

- Several `qualor scan` runs started at the same time on one machine (parallel jobs on one CI
  runner) could fail Qualor's security rules or the OpenGrep analyzer with `exited with code null`
  on a fresh home directory. OpenGrep unpacks itself on its first run, and those runs now take
  turns at that step only.
- `qualor/scanner`: the HTML and CSS linters use source-map-js 1.2.2 (was 1.2.1;
  GHSA-68fv-2mgg-jv7q).

## [0.7.0] - 2026-10-07

### Added

- Qualor's own security rules: `qualor/scanner` runs qualor-rules 2026.10.3, 57 rules
  (source-available under PolyForm Shield 1.0.0, not MIT), with eight new ones. Python: command
  injection (`os`, `subprocess`, `asyncio` in Flask, Django and FastAPI). Java (Servlets, Spring
  MVC, JAX-RS): XPath injection (`javax.xml.xpath`) and regex injection (`java.util.regex` and the
  `String` regex methods), plus misuse rules for disabled TLS verification (trust managers that
  accept any certificate, host name verifiers that accept any host) and broken ciphers (DES, Triple
  DES, RC2, RC4, Blowfish, RC5, ECB mode, RSA without padding, `NullCipher`). New security hotspots:
  cookies without `Secure` or `HttpOnly` in Node.js (Express, express-session, cookie-session,
  Fastify, Next.js), tar archives extracted in Python without a safe extraction filter (`tarfile`,
  `shutil.unpack_archive`), and lxml parsers that load the document's DTD or lift its size limits.

### Changed

- Qualor's security rules cover more code. Disabled TLS verification: in Node.js also the TLS
  options of node-postgres, knex, nodemailer, got and `ws` clients and MongoDB's
  `tlsAllowInvalidCertificates` and `tlsInsecure`; in Python also aiohttp's `ssl=False`, host name
  checks turned off, the legacy `ssl.wrap_socket()` and the certificate switches of boto3,
  Elasticsearch, OpenSearch, PyMongo and hvac. Go: the broken-cipher rule also reports insecure TLS
  cipher suites in a `tls.Config`, and SSRF covers `net/http/httputil` reverse proxies. Python: open
  redirects through `Location` headers, Django's `RedirectView` and the request path in middleware,
  path traversal into `shelve` and `dbm` files. Node.js command injection follows `cmd /c` and
  PowerShell's `-Command`, `-EncodedCommand` and `-File`. Java request rules also take Spring
  `HttpEntity`, `RequestEntity` and `@RequestPart` parameters as request data, and Java's weak
  ciphers include the PBE names written with mode and padding.
- Qualor's JavaScript TLS verification rule takes much less time on each file, and the JavaScript
  open redirect rule scans large bundled or minified files in seconds instead of minutes.

### Fixed

- Qualor's Python security rules reported nothing in large Django modules: a module with many views
  and Django imports lost every finding of the file. They now report them, and scan large files much
  faster.
- Fewer false positives from Qualor's security rules: XSS no longer reports the results of other
  rules' sinks (Node.js, Java, Go), Django's `url_has_allowed_host_and_scheme()` and URL validators
  before a Go redirect count as guards, and Go's path traversal skips test support code.
- Qualor's Python command injection rule and Ruff's `S602` and `S605` for the same problem on the
  same line now show as one issue (Qualor's, the other its duplicate).

## [0.6.0] - 2026-10-06

### Added

- Telemetry: the server sends anonymous usage statistics (version, edition, platform, counts,
  languages, analyzers and features in use) to qualor.dev about a minute after it starts and then
  daily. `QUALOR_TELEMETRY=false` (Helm `config.telemetry: false`) turns it off. See
  [Telemetry](docs/guide/telemetry.md).
- Rule links in merge request threads, pull request check-run annotations and the summary
  comments: a rule's key links to its documentation (an `https://` link only).
- Qualor's own rules link to their pages in the qualor-rules repository
  (`docs/rules/<lang>/<name>.md`), on the issue page, in the rules list and in comments, also for
  issues found before this version.

### Fixed

- SonarJS rule links: rules.sonarsource.com no longer exists, so they open the rule in
  SonarCloud's public rule browser (TypeScript-only rules under `typescript:`). Links stored by
  earlier scans show the new page at once, and C# SonarAnalyzer links are fixed the same way.
- The links of the go vet analyzers `copylocks` and `composites` open their package pages.
- Qualor's own security rules and another analyzer's rule for the same problem on the same line
  now show as one issue (Qualor's, the other its duplicate) also where the other rule carries no
  CWE or another one: Ruff's flake8-bandit rules (`S608`, `S610`, `S611`, `S307`, `S102`, `S301`,
  `S302`, `S506`, `S501`, `S323`, `S308`, `S704`), the SonarJS rules `S2077`, `S4721`, `S1523`,
  `S4830` and `S5527` (also as a project's own `sonarjs/*` ESLint rules) and ESLint's `no-eval`,
  gosec's `G107`, `G708` and `G710`, and SpotBugs' `PT_RELATIVE_PATH_TRAVERSAL`,
  `PT_ABSOLUTE_PATH_TRAVERSAL`, `XSS_REQUEST_PARAMETER_TO_SERVLET_WRITER`, `SPEL_INJECTION` and
  `EL_INJECTION`. A merge request no longer gets two threads for one line.

## [0.5.0] - 2026-10-06

### Added

- Qualor's own security rules: a new built-in engine, `qualor`, runs qualor-rules 2026.10.1, a
  pack of 49 OpenGrep rules (source-available under PolyForm Shield 1.0.0, not MIT) that
  `qualor/scanner` includes. Taint rules follow HTTP request data to a dangerous call, misuse rules
  report unsafe settings, and hotspots point at code to review. JavaScript/TypeScript (Express,
  Next.js, Fastify, Node.js `http`): SQL injection (`pg`, `mysql2`, Knex, Sequelize, Prisma,
  TypeORM), NoSQL injection (MongoDB, Mongoose), command, code and template injection, path
  traversal, SSRF, open redirect, XSS, regex injection, prototype pollution and disabled TLS
  verification; raw HTML in React's `dangerouslySetInnerHTML` is a hotspot. Python (Flask, Django,
  FastAPI): SQL, code, template, XPath and regex injection, unsafe deserialization, path traversal,
  SSRF, open redirect, XSS, XXE and disabled TLS verification. Java (Servlets, Spring MVC, JAX-RS):
  SQL, command, expression-language, template and LDAP injection, unsafe deserialization, path
  traversal, SSRF, open redirect, XSS, XXE and zip slip. Go (`net/http`, Gin, Echo, chi,
  gorilla/mux): SQL, command and template injection, path traversal, SSRF, open redirect, XSS, zip
  slip, disabled TLS verification and broken ciphers (DES, 3DES, RC4); weak hashes (MD5, SHA-1)
  and cookies without `Secure` or `HttpOnly` are hotspots. Issues count in the quality gate,
  hotspots never do. Rule keys look like `qualor:java/sql-injection`; the UI shows the engine as
  "Qualor". Configure it with `analyzers.qualor`; `QUALOR_RULES_DIR` points at another copy of the
  rules (releases at <https://github.com/qualor-dev/qualor-rules/releases>). `nosemgrep` comments
  do not hide its findings; mark them as false positives instead.
- Where Qualor's rules and another analyzer report the same problem on a line, Qualor's issue is
  primary; if you had marked the other issue as a false positive or won't fix, the new issue
  starts with that status when it is first created (a later reopen is kept), and its history
  names the other rule and repeats the comment on that status, if there was one.
- Java security analysis: `qualor/scanner` bundles FindSecBugs 1.14.0 (LGPL-3.0) in SpotBugs. Its
  144 patterns report injections (SQL, command, path, LDAP, XPath, XSS, SSRF, expression languages),
  XXE, unsafe deserialisation configuration, weak cryptography and hard-coded passwords as
  `spotbugs:` rules. Taint findings and definite misuse are issues; review findings (weak random
  numbers, cookie flags, CORS, weak hashes, request parameters, endpoints) are security hotspots,
  which the gate never counts. The engine's version names the plugin
  (`4.10.4 + FindSecBugs 1.14.0`). `qualor import sonarqube` maps 24 SonarQube Java security rules
  to them (three activate profile rules, the rest import statuses).

### Changed

- `SEMGREP_*` and `OPENGREP_*` environment variables no longer reach OpenGrep or Semgrep:
  `SEMGREP_BASELINE_REF` and `SEMGREP_BASELINE_COMMIT` silently hid every finding older than
  that commit.
- Where a SpotBugs security rule and FindSecBugs report the same problem on one line (SQL from a
  non-constant string, a constant or empty database password, a request parameter in a header,
  cookie, file path or servlet response), the FindSecBugs issue is a duplicate of SpotBugs' own, so issues you
  already triaged stay as they are.
- `findsecbugs*` environment variables are dropped from SpotBugs' environment, so a custom
  FindSecBugs configuration named there is not read.

## [0.4.1] - 2026-10-02

### Added

- A public, read-only demo: `QUALOR_DEMO_USER` names a user anyone may sign in as from the
  sign-in page's **Explore the demo**, without a password (`POST /api/v0/auth/demo`). Every change
  made as that user is refused with 403 `DEMO_READ_ONLY`, whatever its role; the button shows only
  while the user is active, no instance admin, needs no password change and holds no role above
  Viewer. Demo sessions last at most 24 hours. `GET /auth/methods` and `GET /auth/me` say `demo`.

## [0.4.0] - 2026-10-02

### Added

- **Project → Settings** in the UI: the new-code definition (last N days, since the previous
  version, or a fixed analysis, with the current baseline), the quality gate and the quality
  profile of each language, the main branch, project analysis tokens, the project's webhooks, and
  deleting the project (type its key). Each panel shows only to those who may change it.
- Webhooks in the UI: a webhook applies to every project or to one project, a delivery can be
  sent again, the deliveries list has **Refresh**, and **Rotate secret** issues a new secret shown
  once.
- An issue's **Related locations** (the secondary locations an analyzer reports) on its page,
  numbered and marked in the code snippet, each linking to its file.
- The **Code** tab: a branch's directories and files with lines of code, complexity, coverage,
  duplication and open issues, and a page per file with a line map of coverage, new code,
  duplicated blocks and issues. Source code is not stored or shown.
- PHP: `.php` files are a language of their own (`php`) with metrics, duplication and a `php`
  quality profile, and a new `phpstan` engine runs PHPStan 2.2 (MIT) from `qualor/scanner` on
  Debian's PHP 8.2, at level 2 (`analyzers.phpstan.level`, 0-10 or `max`), with Qualor's own
  configuration. It never loads the project's `phpstan.neon`, its bootstrap files, PHPStan
  extensions or Composer's autoloader, and runs on a copy of the sources; installed dependencies
  in `vendor/` are read as symbols, never run. Unknown classes, methods and functions are not
  reported. `qualor import sonarqube` imports PHP profiles where a PHPStan rule is the same rule.
  `QUALOR_PHPSTAN_PHAR` names another phar.
- Ruby: `.rb`, `.rake`, `.gemspec`, `.ru`, `Gemfile` and `Rakefile` are a language of their own
  (`ruby`) with metrics and duplication, and a new `rubocop` engine
  runs RuboCop 1.91 (MIT) on Ruby 4.0.7 from `qualor/scanner` with Qualor's own selection
  (`qualor-default`: RuboCop's Lint and Security cops, minus a few that misfire in a Qualor
  scan; the guide lists them). It never reads the project's `.rubocop.yml`;
  choose cops with `analyzers.rubocop.select` and `ignore`, and the parsed Ruby version with
  `targetRubyVersion`. A `ruby` quality profile is created for every organisation.
  `qualor import sonarqube` imports Ruby profiles where a RuboCop cop checks the same thing (two
  rules are equivalent and activate their cop; the others are overlaps that only import issue
  statuses), and keeps the statuses of issues SonarQube imported from RuboCop.
- Go: `.go` files are language `go`, with metrics, duplication and a `go` quality profile, and three
  engines run from `qualor/scanner`: `staticcheck` (staticcheck 2026.2.1), `govet` (go vet of Go
  1.27.1) and `gosec` (gosec 2.29.0, security; G104, G115 and G304 left out by default). They
  analyse each Go module offline: run `go mod download` (or vendor your dependencies) before
  `qualor scan`; a package whose dependencies are missing is not analysed and the log says so.
  Nothing the repository asks for is run (no `go generate`, no other toolchain, no cgo), and a
  module that replaces a dependency with an outside directory or links out of the repository is
  skipped. Go coverage profiles (`go test -coverprofile`) import as the new `gocover` format.
  `qualor import sonarqube` maps the statuses of issues SonarQube imported from go vet, and 18
  curated `go:` rules (statuses only until reviewed).
- C and C++: `qualor/scanner` runs cppcheck 2.22.0 (GPL-3.0-or-later, built from source; its
  source ships in `qualor/scanner-sources`) as the `cppcheck` engine, on by default, with no build
  needed. A clang-tidy (LLVM 14+) on `PATH` runs as the `clang-tidy` engine when the job also has a
  `compile_commands.json`; no image bundles it. Qualor reads compile databases and `.clang-tidy`
  itself and never passes plugins, response files or compiler wrappers. C and C++ files get metrics
  and duplication (tree-sitter-c 0.24.1, tree-sitter-cpp 0.23.4), built-in C and C++ quality
  profiles, and `qualor import sonarqube` maps common C/C++ rules (pending review). gcovr and
  llvm-cov coverage reports already work.

### Changed

- A report that holds PHP, Ruby, Go, C or C++ files, or findings of the `phpstan`, `rubocop`,
  `staticcheck`, `govet`, `gosec`, `cppcheck` or `clang-tidy` engine, is refused (422) by a Qualor
  server older than this release: upgrade the server before the scanner.
- `.php` files were language `other`; they now count in lines of code, complexity and
  duplication, and `*Test.php` files are test files by default.
- PHPStan is skipped when `composer.json` requires packages but `vendor/` is not installed: run
  `composer install` (scripts and plugins are not needed) before the scan.
- `phpstan` is now a built-in engine id: a `sarif:` entry with `engine: phpstan` no longer
  validates, and your own PHPStan SARIF import is reported as `ext-phpstan` and counted once.
- `.rb`, `.rake`, `.gemspec`, `.ru`, `Gemfile` and `Rakefile` were language `other`; they now count
  in lines of code, complexity and duplication, which can move the new-code duplication condition.
  `*_spec.rb`, `*_test.rb` and Ruby files below `spec/` and `test/` are test files by default.
- New built-in excludes: `.bundle` directories and `db/schema.rb`.
- `rubocop` is now a built-in engine id: a `sarif:` entry with `engine: rubocop` no longer
  validates. Qualor runs RuboCop itself: remove your own RuboCop SARIF import; one you keep is
  reported as `ext-rubocop` and counts once with the built-in finding.
- `**/testdata/**` and `**/*.pb.go` are built-in excludes (Trivy's `--skip-dirs` included); the
  `testdata/` exclude applies to every language, so secret and dependency scanning skip it too, and
  `**/*_test.go` files are tests by default. `.go` files were `other` and now count in lines of
  code and duplication.
- `staticcheck`, `govet` and `gosec` are reserved engine ids: a `qualor.yml` `sarif:` entry with one
  of them fails validation. A SARIF of your own from staticcheck or gosec becomes `ext-staticcheck`
  or `ext-gosec` and is counted once with the built-in finding; remove it, Qualor runs these tools
  itself.
- `.c`, `.cpp`, `.h` and the other C/C++ files were `other`; they now count as `c` or `cpp` in
  lines of code and duplication. `CMakeFiles/`, `cmake-build-*/` and `_deps/` are built-in
  excludes. `cppcheck` and `clang-tidy` are reserved engine ids (`ext-cppcheck` and
  `ext-clang-tidy` are the names of your own imported SARIF of these tools, and count once).
- `qualor/scanner` is about 115 MB larger compressed (about 4.1 GB unpacked, was 3.5 GB) with
  PHP 8.2 and PHPStan, Ruby and RuboCop, the Go toolchain and cppcheck; `qualor/scanner-dotnet`
  is about 100 MB larger compressed (about 5.8 GB unpacked, was 5.3 GB).

### Fixed

- The `semgrep` engine skipped files larger than 1,000,000 bytes without a word (OpenGrep and
  Semgrep do so when they scan a directory); it now scans every file up to Qualor's own 1 MiB limit.

## [0.3.2] - 2026-10-01

### Changed

- The summary comment on GitLab merge requests and GitHub pull requests is easier to read: a status
  icon in the headline, the gate name, the commit and the number of new issues on one line, a table
  of every gate condition (passed ones too) with its value and the value it requires, the conditions
  the gate skipped and why, severity markers, a numbered list of the most severe new issues with
  their quality, rule and a link to each in Qualor, and an **Open in Qualor** link.

### Fixed

- sonarjs: S2430 no longer reports calls to HTTP-verb methods such as `client.GET()` or
  `client.POST()` (openapi-fetch style clients) as constructors called without `new`.

## [0.3.1] - 2026-10-01

### Added

- The user guide is built into the server: **Docs** in the top bar opens `/docs`, the guide of the
  server's own release, for signed-in users, with the page list, the sections of each page and
  Copy buttons on code blocks and AI prompts.
- The user menu shows the server's version and edition.
- `GET /api/v0/system/version` returns the server's version to any token, project analysis tokens
  included.
- `qualor scan` logs its own version when it starts and, with a server configured, the server's
  version; it warns when the scanner and the server are different releases. The check never fails
  a scan.
- The server logs its version when it starts.

## [0.3.0] - 2026-10-01

### Added

- Python: `.py` files are a language of their own (`python`) with metrics and duplication, and a
  new `ruff` engine runs Ruff 0.16 (MIT) from `qualor/scanner` with Qualor's own rule selection
  (`qualor-default`: Pyflakes, pycodestyle errors, flake8-bugbear, Pylint errors and
  flake8-bandit's security rules). It never reads the project's Ruff configuration; choose rules
  with `analyzers.ruff.select` and `analyzers.ruff.ignore`. A `python` quality profile is created
  for every organisation. `qualor import sonarqube` imports Python profiles where a Ruff rule is
  the same rule, and keeps the statuses of issues SonarQube imported from Ruff. The curated
  SonarQube-rule-to-Ruff-rule mappings (88 rules) are reviewed: each was compared against both
  rules' public documentation, and an imported Python profile now activates the mapped Ruff rule
  where the two are equivalent. A mapping marked overlap (partial counterpart) only imports issue
  statuses and does not activate the rule.
- HTML and CSS: `.html`/`.htm` files are language `html`, `.css` and `.scss` files language `css`,
  with their own quality profiles, and HTML and CSS get line, comment and duplication metrics.
  `qualor/scanner` runs HTMLHint 1.9.2 (`htmlhint` engine) and stylelint 17.15 (`stylelint`
  engine) with the project's `.htmlhintrc` or JSON/YAML stylelint configuration, or Qualor's own
  (HTMLHint rules that suit templates; `stylelint-config-recommended`). A stylelint configuration
  written in JavaScript or TypeScript is never run: stylelint is skipped with the reason, and
  `analyzers.stylelint.configFile: qualor-default` uses Qualor's configuration instead.
- Kotlin: `.kt` and `.kts` files are a language of their own (`kotlin`), with complexity, size and
  duplication metrics and a "Qualor way" Kotlin quality profile. `qualor/scanner` runs detekt 1.23.8
  (Apache-2.0) on them as a new `detekt` engine (rule keys such as `detekt:MagicNumber`), with the
  repository's own detekt config (`config/detekt/detekt.yml`, `config/detekt.yml`, `detekt.yml` or
  `.detekt.yml`) on top of detekt's defaults, or detekt's default rule set with the settings
  detekt recommends for Jetpack Compose. Rules that need the project's classpath do not run, and
  plugins and baselines from the checkout are never loaded. A detekt config Qualor cannot use
  makes detekt skip (fail under `analyzers.detekt.enabled: true`); an
  `analyzers.detekt.configFile` outside the repository stops the scan with exit 2. Turn it off
  with `analyzers.detekt.enabled: false`.
- Swift: `.swift` files are a language of their own (`swift`), with complexity, size and
  duplication metrics (tree-sitter-swift 0.7.3) and a "Qualor way" Swift quality profile.
  `qualor/scanner` runs SwiftLint 0.65.1 (MIT), its static Linux build with no Swift toolchain, on
  them as a new `swiftlint` engine (rule keys such as `swiftlint:force_cast`). It uses the
  repository's own `.swiftlint.yml`, read and filtered by Qualor (settings that write files, fetch
  URLs or change the exit code are ignored), or, without one, SwiftLint's default rules with
  adjustments for code that Xcode, SwiftPM and the common formatters write (`todo`,
  `multiple_closures_with_trailing_closure`, `trailing_comma` and `comment_spacing` off,
  `trailing_whitespace` ignoring empty lines, `identifier_name` excluding `i`, `j`, `k`, `x`, `y`,
  `z` and `id`, `line_length` ignoring URLs and comments, `opening_brace` accepting `{` on its own
  line after a wrapped condition, type header or signature, and `nesting` allowing types two
  deep). The rules that need SourceKit, and custom rules, do not run; Swift files over 1 MiB are
  not passed to SwiftLint, and files with CRLF line ends are passed with LF ends, so SwiftLint's
  line numbers are right. Rule ids SwiftLint does not know and rule settings it cannot read (it
  then uses the rule's defaults) are warned about in the scan log. A `.swiftlint.yml` Qualor
  cannot use (`parent_config` or `child_config`, `only_rules` combined with `disabled_rules`,
  `opt_in_rules` or `enabled_rules`, invalid YAML, larger than 1 MiB) makes SwiftLint skip (fail
  under `analyzers.swiftlint.enabled: true`); `analyzers.swiftlint.configFile: qualor-default`
  uses the defaults instead, and a `configFile` that is a URL or outside the repository stops the
  scan with exit 2. Turn it off with `analyzers.swiftlint.enabled: false`.
  `qualor import sonarqube` carries over the statuses of SwiftLint issues SonarQube imported
  (`external_swiftlint`).

### Changed

- A report that holds Python files is refused (422) by a Qualor server older than this release:
  upgrade the server before the scanner.
- `.py` files were language `other`; they now count in lines of code, complexity and duplication,
  and `test_*.py`, `*_test.py` and `conftest.py` are test files by default.
- New built-in excludes: `.venv`, `venv`, `.tox`, `.nox`, `__pycache__`, `__pypackages__`,
  `.eggs` and `site-packages` directories.
- Qualor now runs Ruff itself. If you imported your own Ruff SARIF to cover Python, remove that
  import (the `--sarif` flag, or the `qualor.yml` `sarif:` entry) and run Ruff with
  `analyzers.ruff` instead. `ruff` is now a reserved engine id: a `sarif:` entry with
  `engine: ruff` is a config error. A Ruff SARIF you still import is reported as `ext-ruff`, and
  each of its findings counts once with the built-in `ruff` finding of the same code on the same
  line (the built-in one is shown).
- `stylelint` and `htmlhint` are reserved engine ids: a `qualor.yml` `sarif:` entry with
  `engine: stylelint` or `engine: htmlhint` no longer validates, and a SARIF tool with that name
  becomes `ext-stylelint` / `ext-htmlhint`, so issues imported that way before get new rule keys.
- `.html`, `.htm` and `.css` files were language `other`; they now count in lines of code and
  duplication, which can move a new-code duplication condition. `.scss` files, `other` before too,
  are now language `css` (linted by stylelint, without metrics).
- Qualor now runs stylelint and HTMLHint itself. If you imported your own stylelint or HTMLHint
  SARIF, remove that import (the `--sarif` flag, or the `qualor.yml` `sarif:` entry). A stylelint
  or HTMLHint SARIF you still import is reported as `ext-stylelint` / `ext-htmlhint`, and each of
  its findings counts once with the built-in finding of the same code on the same line.
- `**/*.min.css` is a built-in exclude, like `**/*.min.js`.
- A report with `html` or `css` files needs a server of this version; upgrade the server with the
  scanner.
- Qualor now runs detekt itself. If you imported your own detekt SARIF to cover Kotlin, remove
  that import (the `--sarif` flag, or the `qualor.yml` `sarif:` entry). `detekt` is now a reserved
  engine id: a `sarif:` entry with `engine: detekt` is a config error. A detekt SARIF you still
  import is reported as `ext-detekt`, and each of its findings counts once with the built-in
  `detekt` finding of the same rule on the same line.
- A report that holds Kotlin files or the `detekt` engine is refused (422) by a Qualor server older
  than this release: upgrade the server before the scanner.
- `.kt` and `.kts` files were language `other`; they now count in lines of code, complexity and
  duplication, which can move a new-code duplication condition.
- `**/src/androidTest/**` and `**/src/*Test/**` are test sources by default. `**/src/*Test/**`
  covers Kotlin Multiplatform's test source sets, but applies to every language: Gradle's
  `src/integrationTest` or `src/functionalTest`, for example, become test files too, which leave
  lines of code, complexity, duplication and coverage.
- Qualor now runs SwiftLint itself. If you imported your own SwiftLint SARIF to cover Swift,
  remove that import (the `--sarif` flag, or the `qualor.yml` `sarif:` entry). `swiftlint` is now a
  reserved engine id: a `sarif:` entry with `engine: swiftlint` is a config error. A SwiftLint SARIF
  you still import is reported as `ext-swiftlint`, and each of its findings counts once with the
  built-in `swiftlint` finding of the same rule on the same line.
- A report that holds Swift files or the `swiftlint` engine is refused (422) by a Qualor server
  older than this release: upgrade the server before the scanner.
- `.swift` files were language `other`; they now count in lines of code, complexity and
  duplication, which can move a new-code duplication condition.
- `Pods/`, `Carthage/` and `.build/` are built-in excludes. Trivy skips them too, so a dependency
  lockfile that lives only inside one of them is no longer scanned; the lockfiles at the repository
  root (`Podfile.lock`, `Package.resolved`, `Cartfile.resolved`) still are.
- A directory whose name holds a line break (LF, CR, U+0085, U+2028 or U+2029) is skipped with a
  `PATH_UNSUPPORTED` report warning. The files below one were left out without a warning before,
  except below a U+0085 name, which were scanned.

## [0.2.0] - 2026-09-30

### Added

- SonarQube-compatible rules: `qualor/scanner-dotnet` adds SonarAnalyzer.CSharp 9.32 to the .NET
  build (rule keys `roslyn:S####`), and `qualor/scanner` runs eslint-plugin-sonarjs 2.0.4 with its
  recommended rules as a new `sonarjs` engine for JavaScript and TypeScript (`sonarjs:S####`). Both
  are the last LGPL-3.0 releases and do not change. `qualor import sonarqube` maps `csharpsquid:`,
  `javascript:` and `typescript:` rules one to one where the bundled versions have them. A project's
  own SonarAnalyzer reference replaces the bundled one; an ESLint issue and the sonarjs rule that
  decorates it count once. Turn them off with `analyzers.roslyn.sonarAnalyzer: false` and
  `analyzers.sonarjs.enabled: false`.
- **Settings → Organizations**: an instance admin sees every organisation and creates one with
  **New organization**.
- The **Branches** tab of a project deletes a branch or merge request, after a confirmation.

### Changed

- The web UI is redesigned, in the light and dark themes, and every page fits a phone and a
  tablet. A project's overview shows the quality gate's verdict with the condition that failed,
  the measures on new code, coverage, issues, duplication and size with their trends, and the
  history of open issues. The issues list has a filter bar and collapsible facets, and an issue
  shows its code, the AI assistant and its history beside its details. A quality gate's
  conditions are changed in their own rows. Settings are grouped as **Your account**,
  **Organization** and **Instance**, and creating or deleting something asks in a dialog. The
  account, **Change password** and **Sign out** are in a menu on the top bar.
- Projects are mapped to their GitLab and GitHub repositories on a page of their own, **Settings →
  Repositories**, instead of the **Projects** table of **Settings → GitLab**.
- `sonarjs` is now a built-in engine id. A `qualor.yml` `sarif:` entry with `engine: sonarjs` no
  longer validates (pick another id), and an imported tool whose name becomes `sonarjs` is reported
  as `ext-sonarjs`.
- `qualor dotnet begin` writes a new version of its MSBuild hook. The `qualor dotnet begin` of an
  older CLI treats that hook as not its own and stops with exit 2, so on a self-hosted runner whose
  builds share one MSBuild user directory, upgrade every `qualor` CLI on it together.

## [0.1.1] - 2026-09-29

### Fixed

- `restore` (the embedded database) no longer drops the database before the dump has loaded. It
  loads the dump into a new database and replaces the old one only on success; a truncated, empty or
  wrong file now fails with "the existing database was not changed" and the data stays as it was.
- `qualor import sonarqube` no longer fails the issue-status import with HTTP 500 on SonarQube
  Server 9.9 and Community Build: only rules the server has are queried, so rules from plugins it
  lacks (PMD) or newer than its analyzers no longer break the query. Reviewed security hotspots are
  counted on 9.9–10.1 too, and the SonarQube reads reuse one connection.
- `--help` and `-h` print the usage and exit 0 after any command or subcommand, instead of
  "Unknown option".
- GitLab: a 403 is no longer reported as "GitLab refused the token". The log and the connection
  test say the token lacks a permission; a commit status on a protected branch needs Maintainer.
- GitLab: after the decoration token is replaced by one of another user, the old summary comment
  is deleted instead of staying beside the new one (needs a Maintainer token).
- Connection tests and webhooks: a host name whose lookup does not finish in time, such as a
  single-label name, is reported as unresolved instead of a timeout.
- SSO: **Read metadata** on a SAML connection says why the metadata URL could not be read (host not
  public, name not resolved, timeout, TLS certificate, HTTP status, not SAML metadata) and logs a
  warning with the host and the reason. The connection **Test** reports a failed TLS certificate
  as `fetch.tls`.
- Signing in with single sign-on no longer asks for a new password when an admin set the user's
  password; the next password sign-in still does.
- AI assistant: a key the provider refuses names the provider's HTTP status (401: wrong key; 403:
  no access to the model or no credit), in the provider **Test** (`problem.providerStatus`) and the
  `AI request finished` log line. The error code stays `PROVIDER_REFUSED_KEY`.
- AI assistant: a request that failed without using tokens, because the provider refused the key
  or nothing was sent, no longer counts against the organisation's daily budgets. The hourly bound
  per person still counts every request.
- `qualor/scanner`: the notices name the five MPL-2.0 Go modules compiled into Gitleaks, and
  `qualor/scanner-sources` carries their source.

### Changed

- GitLab: the connection test reports the token's access level in the project, and the settings
  page warns when it is below Maintainer. The guide now asks for a Maintainer token.
- Docs: the GitLab guide covers self-managed GitLab (a one-time import of the component, included
  by its full version); the SonarQube migration guide says what the import moves today and when
  the scanner image needs `--allow-insecure-http`; troubleshooting covers a project reused across
  git histories.

### Security

- `qualor/scanner` and `qualor/scanner-dotnet`: Gitleaks 8.30.1 is built from its release source
  with Go 1.27.1 and current `golang.org/x/crypto` and `golang.org/x/text`, instead of the upstream
  binary built with Go 1.24.11 (CVE-2025-68121 and others).
- Node.js 22.23.3 (was 22.23.2) in all images; its npm bundles tar 7.5.22 (CVE-2026-59873,
  CVE-2026-59874, CVE-2026-73566).
- The HIGH and CRITICAL image vulnerabilities that no release fixes yet are listed with reasons
  and a review date in `deploy/scanner/.trivyignore.yaml`.

## [0.1.0] - 2026-09-28

The first public release.

### Added

- The server, `qualor/server`: the API, the web UI and the analysis worker in one image, with its
  own PostgreSQL 18 on a volume, or an external PostgreSQL 16 or later through `DATABASE_URL`.
  Docker Compose and a Helm chart (`docs/guide/install-server.md`).
- The scanner, `qualor/scanner`, and the `qualor` CLI: ESLint from the project's own
  configuration, PMD, SpotBugs, OpenGrep, Gitleaks and Trivy, any SARIF file, coverage import,
  duplication and metrics. `qualor/scanner-dotnet` adds C# with the .NET 8 and .NET 10 SDKs,
  the SDK's analyzers and Roslynator, hooked into the project's own build
  (`qualor dotnet begin`, the build, `qualor dotnet end`).
- Quality gates on new code, issue tracking across commits and branches, and quality profiles.
- GitLab: merge request comments, inline discussions and a commit status, the CI/CD component
  `gitlab.com/qualor/qualor`, and GitLab's Code Quality, SAST and Dependency Scanning reports.
- GitHub: a GitHub App with check runs and pull request comments, and GitHub Actions workflows
  in `integrations/github/`.
- `qualor import sonarqube`: quality profiles, gates and issue statuses from SonarQube Server or
  SonarQube Cloud.
- The AI assistant with your own model: explain an issue, suggest a triage, suggest a fix.
- Roles and project access in every edition: Organization admin, Project admin, Maintainer and
  Viewer, and roles on a single project.
- Webhooks and a documented HTTP API (`server/openapi.json`).
- The enterprise edition, with an offline licence key (`docs/guide/enterprise.md`): single sign-on
  with OIDC and SAML, SCIM 2.0 for Entra ID and Okta, a tamper-evident audit log with export and
  SIEM streaming, and a higher AI fix suggestion limit. The enterprise code is source-available
  under the Qualor Enterprise Licence (`enterprise/LICENSE`); everything else is MIT.
- Signed releases: cosign signatures and SPDX SBOMs for every image and the chart, and a signed
  `SHA256SUMS` for the release files (`SECURITY.md`).
