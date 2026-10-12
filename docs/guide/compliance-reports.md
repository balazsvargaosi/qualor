# Compliance reports

Compliance reports need an enterprise licence listing `compliance-export`, which only the
Enterprise plan lists ([Plans and prices](./enterprise.md#plans-and-prices)). Without it, the
**Compliance** tab and **Settings → Compliance reports** are not shown.

## What a report is

A compliance report is a **point-in-time record** of the security findings of one **project
branch** (the main branch unless you choose another) or of a whole **organisation** (the main
branch of each of its projects). It maps the open findings to five security standards, lists
secrets and vulnerable dependencies on their own, records every triage decision with who made it,
when and why, and shows each project's quality gate and a short security trend.

Qualor builds the report once, when you ask for it, and keeps it unchanged: later scans and triage
do not touch it. It has a SHA-256, so anyone can check that a copy is the report Qualor built. You
download it as JSON, CSV or PDF.

## Which findings count

A report counts the **security-relevant** issues of the branch as they are when the report is
built:

- every issue whose rule has a CWE id (Gitleaks secrets count as CWE-798);
- every issue of the **security** quality;
- every security hotspot.

An issue's status decides where it appears:

| Status | In the report |
|---|---|
| open | the findings, counted in the standards |
| false positive, won't fix | the triage decisions: who set the status, when, and the comment (the first 1 000 characters) |
| resolved, closed | left out |

An issue that Qualor marks as the duplicate of another (the same problem on the same line, found
by a second analyzer) is counted once, as the issue it duplicates.

Findings are split into three sections: **secrets** (Gitleaks), **dependencies** (Trivy) and
**code** (every other analyzer). The counts of each are kept apart.

## The standards

| Standard | Id in the report | Where the CWE lists come from | Licence |
|---|---|---|---|
| OWASP Top 10 2021 | `owasp-top10-2021` | the "List of Mapped CWEs" of each category, [owasp.org/Top10/2021](https://owasp.org/Top10/2021/) | CC BY-SA 4.0, by the OWASP Foundation |
| OWASP Top 10 2025 | `owasp-top10-2025` | the same, for the 2025 edition, [owasp.org/Top10/2025](https://owasp.org/Top10/2025/) | CC BY-SA 4.0, by the OWASP Foundation |
| CWE Top 25 2025 | `cwe-top25-2025` | MITRE's [2025 CWE Top 25 Most Dangerous Software Weaknesses](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html), one category per CWE, in rank order | MITRE CWE Terms of Use. Copyright © 2006–2026, The MITRE Corporation. CWE is a trademark of The MITRE Corporation |
| OWASP ASVS 4.0.3 | `asvs-4.0.3` | the CWE column of the [ASVS 4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3) requirements, grouped by chapter (V1 to V14) | CC BY-SA 4.0, by the OWASP Foundation |
| PCI DSS 4.0.1 requirement 6.2.4 | `pci-dss-4.0.1-6.2.4` | **Qualor's own mapping** of CWE ids to the six kinds of attack the requirement names | part of Qualor Enterprise |

Each report names its standards, their sources and their licences on the PDF's cover and in the
JSON.

How a finding is matched:

- **By exact CWE id.** A finding belongs to every category whose list holds one of its rule's CWE
  ids. A child CWE does not count in its parent's category: in the CWE Top 25, a finding with
  CWE-564 (SQL injection through Hibernate, a child of CWE-89) does not count under CWE-89.
- **A finding can count in more than one category**, so a standard's category totals can add up
  to more than its number of findings. The standard's total counts each finding once.
- **Not mapped.** A finding that matches no category of a standard counts in that standard's
  **Not mapped** row, so every standard accounts for every open finding.
- **PCI DSS 6.2.4 is Qualor's mapping, not the PCI Security Standards Council's.** The
  requirement names kinds of attack, not CWE ids, so Qualor maps CWE ids to them itself; the
  category titles paraphrase the requirement. The last of the six categories, **High-risk
  vulnerabilities**, takes every **blocker** and **high** finding, whatever its CWE. Treat the
  mapping as a starting point for your assessor, not as their verdict.
- **ASVS is 4.0.3**, not 5.0: ASVS 5.0 publishes no CWE mapping.

## Creating a report

| Report of | Who can create it | Who can see it and download it |
|---|---|---|
| a project branch | Organization admins and Project admins (the permission `project.compliance.create`) | everyone who can read the project |
| an organisation | Organization admins (`org.compliance.manage`) | every member of the organisation, whatever their role |

Instance admins can do everything. Someone with a role only on some projects of an organisation,
and none in the organisation itself, does not see the organisation's reports (**Settings →
Compliance reports** tells them only members of the organisation can see them); they see the
reports of their projects.

- **A project:** **Project → Compliance**. Choose the **Branch** (the main branch is selected;
  merge requests have no report) and press **Create report**. The branch needs at least one
  successful analysis.
- **An organisation:** **Settings → Compliance reports**, for the organisation chosen in the
  header's organisation switcher. Press **Create report**. A project that was never analysed is
  in the report as **Never analysed**. An organisation report covers at most **2 000** projects;
  above that the report fails with "too many projects for one report".

The report is built in the background. It shows as **Pending**, and then as **Ready**, without a
page reload. While one report of a project branch or of an organisation is pending, another report
of the same project or organisation cannot be created: wait until it is ready. Qualor builds one
report at a time for the whole installation, so a report may wait while another is being built.

A report that fails shows **Failed** with a reason; create a new one. A report still not ready an
hour after it was created is marked failed with "the build did not finish".

Each report in the list shows when it was created, by whom, the branch, its status, the number of
open findings and the start of its SHA-256, with **Copy** for the full value. **Summary** shows the
report on the page: the category table of each standard (pick it under **Standard**), then only
the counts of the open findings, the findings in new code, the secrets, the vulnerable dependencies
and the triage decisions (false positive and won't fix), not their lists. The lists are in the
PDF, the CSV and the JSON; the gate of each project is in the PDF and the JSON.

A report holds at most **50 000** findings and **50 000** triage decisions. Above that, the lists
stop and the counts stay exact; the page, the PDF and the JSON (`summary.truncated`) say so.

## The formats

Every report downloads as **JSON**, **CSV** and **PDF** (the links next to it). The file is named
`qualor-compliance-<project or organisation key>-<yyyymmdd>-<first 8 characters of the id>`, with
`.json`, `.csv` or `.pdf`.

- **JSON is the canonical record.** It is the report exactly as Qualor built and stored it: the
  scope, the time, who created it, the server version, the standards with their sources, each
  project with its last analysis, gate (with the failed conditions) and up to 12 points of
  security trend, the summary counts, every finding with its categories in each standard, and
  every triage decision. The CSV and the PDF are made from it.
- **CSV** (UTF-8 with a byte-order mark, so Excel reads it; lines end in CRLF). The columns are
  `section`, `project`, `path`, `line`, `rule`, `rule_name`, `engine`, `severity`, `kind`, `cwe`,
  `status`, `in_new_code`, `first_seen_at`, one column per standard (named by its id, holding the
  finding's category ids, separated by `;`), then `triage_by`, `triage_at` and `triage_comment`.
  The open findings come first, then the triage decisions (`status` is `false_positive` or
  `wont_fix`). A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a
  leading `'`, so a spreadsheet never runs it as a formula.
- **PDF** (A4). Every page has the scope at the top and "Page n of m" with the report id at the
  bottom. The sections:
  1. the cover: the scope, when the report was built and by whom, the server version, the report
     id, the **SHA-256 of the JSON export**, and the standards with their sources and licences;
  2. the executive summary: the open findings by severity, the dependencies, the findings in new
     code, the secrets, the triage counts, each project with its gate, and the failed gate
     conditions; a report of one project adds its security trend;
  3. one page or more per standard: each category with its open findings, by severity, in new
     code, the number of rules and the oldest finding, then **Not mapped**;
  4. secrets and dependencies, rule by rule;
  5. the triage decisions: the **2 000** newest;
  6. the findings: the first **2 000**, by severity.

  A list cut at 2 000 ends with "The full list is in the CSV and JSON exports." In a report that
  holds only the first 50 000 findings or triage decisions, it ends with "The JSON and CSV exports
  list the first 50 000; all counts are exact." instead: the "first n of m" and "newest n of m"
  lines give the exact totals, and the secrets and dependencies tables, rule by rule, cover only
  the listed findings ("Rules among the listed findings").

  In the executive summary, a project's **Security issues** is the `security_issues` measure of
  its last analysis, while the report's findings are the open security findings when the report
  was built (see [Which findings count](#which-findings-count)), so the two can differ.

  The PDF uses the Noto Sans font, which covers **Latin, Cyrillic and Greek**. Text in other
  scripts (Chinese, Japanese, Korean, Arabic, Hebrew and others) prints as the font's missing-glyph
  box, for example in a file path or a triage comment. The JSON and the CSV keep that text as it
  is.

You can have one download running at a time. The links are plain downloads, so a refusal shows up
only as a failed download in your browser, with no message on the page:

| Answer | Meaning |
|---|---|
| 429 `RATE_LIMITED` | another of your downloads is still running: wait for it |
| 503 `REPORT_RENDER_TIMEOUT` | the PDF took longer than 60 seconds to make. The JSON and the CSV of the same report still download |
| 409 `REPORT_NOT_READY` | the report is pending or failed |
| 403 `FEATURE_NOT_LICENSED` | the licence no longer lists `compliance-export` |

Downloads are sent with `Cache-Control: no-store`, so no proxy or browser keeps a copy.

## Verifying a report

The SHA-256 on the PDF's cover, in the list and in the API (`sha256`) is the SHA-256 of the JSON
download. To check a copy of the report, compare them:

```sh
sha256sum qualor-compliance-payments-api-20271012-0192a3b4.json
# the same 64 hex characters as "SHA-256 of the JSON export" on the PDF's cover
```

On Windows, `Get-FileHash <file> -Algorithm SHA256` in PowerShell gives the same value (in
capitals).

The same report always downloads the same bytes: the JSON is stored as it was built, and the
server makes the CSV and the PDF from it the same way every time. Only a later Qualor release may
lay out the CSV or the PDF differently; the JSON and its SHA-256 never change.

Creating, downloading and deleting reports is recorded in the [audit
log](./roles-and-audit.md#what-is-recorded) when the licence lists `audit-log`: each download
with its format and the report's SHA-256.

## Retention

A report is kept for **one year** from when it was created, then deleted automatically. An
Organization admin can delete one earlier with **Delete** (a project's reports too, on its
**Compliance** tab). A pending report cannot be deleted. Deleting a project or an organisation
deletes its reports.

**When the licence lapses** or no longer lists `compliance-export`, the reports are kept, and
nothing is deleted, not even reports older than a year. The **Compliance** tab and **Settings →
Compliance reports** are not shown, and every `/api/v0/ee/compliance` route answers 403
`FEATURE_NOT_LICENSED`. A report that was being built when the licence lapsed is not finished:
after the renewal it shows as failed, so create it again. With a renewed key, everything is back,
and reports past their year are deleted at the next hourly clean-up.

## How the standards are updated

The standards ship with Qualor. The server never downloads them, so it works in air-gapped
networks, and the standards never change between releases. A new edition of a standard, such as
a new CWE Top 25, comes with a Qualor release, as a new standard beside the previous one. Each
standard keeps its two newest editions.

**A report never changes after it is built.** It carries its own categories, titles and the
SHA-256 of the standard data it used, so an old report downloads with the same JSON after an
upgrade. New reports use the standards of the running release.

## The API

The routes are under `/api/v0/ee/compliance`, described in
[`enterprise/openapi.json`](../../enterprise/openapi.json). Reading needs a personal token with
the **Read** scope; creating and deleting need **Admin**.

| Route | What it does |
|---|---|
| `POST /ee/compliance/reports` with `{"projectId": "…", "branchId": "…"}` (`branchId` optional, the main branch without it) or `{"organizationId": "…"}` | creates a report; answers 202 with the report, `"status": "pending"`. 409 `REPORT_PENDING` while another report of the same scope is pending; 409 `NO_ANALYSIS` if the branch has no successful analysis |
| `GET /ee/compliance/reports?projectId=…` or `?organizationId=…` | the reports of a project, or the organisation reports of an organisation, newest first, 20 at a time (`limit` up to 100; pass `nextCursor` as `cursor`) |
| `GET /ee/compliance/reports/{id}` | one report: its status, `sha256`, size, error and summary counts |
| `GET /ee/compliance/reports/{id}/download?format=json` (or `csv`, `pdf`) | the file. 409 `REPORT_NOT_READY` while it is pending or failed |
| `DELETE /ee/compliance/reports/{id}` | deletes a ready or failed report (Organization admins); 204 |

A report you cannot see answers 404, as everywhere in the API.

```sh
H="Authorization: Bearer $QUALOR_TOKEN"
R="$QUALOR_URL/api/v0/ee/compliance/reports"

curl -fsS -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"projectId":"<project id>"}' "$R"                     # → {"id":"<report id>","status":"pending",…}
curl -fsS -H "$H" "$R/<report id>"                             # repeat until "status":"ready"
curl -fsS -H "$H" -o report.json "$R/<report id>/download?format=json"
sha256sum report.json                                          # equals the report's "sha256"
```
