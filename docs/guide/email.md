# Email

Qualor sends email through an SMTP server you choose: a test message, and alerts for instance
administrators. Nothing is sent until an instance administrator or the operator sets up a server.
Qualor never tracks whether a message was opened or a link clicked.

## What Qualor sends

| Message | To | When |
|---|---|---|
| Test message | the address you type | **Send test** in **Settings → Email** |
| Licence expiry | every instance administrator with an email address | 30, 7 and 1 day before the licence expires, when its 14-day grace period starts, and when it ends ([When a licence expires](./enterprise.md#when-a-licence-expires)). Each once per licence key; a step that was missed (email was off then) is not sent late |
| Failing webhook | every instance administrator with an email address | when a webhook delivery gives up after its 7 attempts; at most one a day for each webhook, and only for a webhook that is switched on ([Webhooks](./webhooks-and-api.md#webhooks)) |

Each alert has a switch in **Settings → Email → Alerts for administrators**; both are on. An
administrator without an email address gets nothing: add one in **Settings → Users**. The panel
says how many administrators have none.

Password reset links, invitations and notifications about your projects are **not available
yet**.

Every message has an HTML part and a plain-text part. Its links lead to the address in
`QUALOR_PUBLIC_URL`; without it, a message says where to go in Qualor instead, and
**Settings → Email** warns.

## Set up in Qualor

An instance administrator opens **Settings → Email**:

1. Under **SMTP server**, enter the **Host**, the **Security** and the **Port**, the **Username**
   and **Password** if the server needs them, the **From name** and **From address**, and
   optionally a **Reply-to** address. Press **Save**. The password is stored encrypted with
   `QUALOR_SECRET_KEY` and never shown again: **Replace** enters a new one, **Remove** deletes it.
   An empty **Host** turns email off when you save.
2. Under **Send a test message**, check the address (yours by default) and press **Send test**.
   The page shows the server's answer, or why it refused.

| Security | Port | Use |
|---|---|---|
| STARTTLS | 587 | the usual one: the connection switches to TLS, and Qualor does not send if the server does not offer it |
| TLS | 465 | TLS from the first byte (also called SMTPS) |
| None | 25 | no encryption: only for a relay on your own network |

## Set up with environment variables

The operator can set the server instead. Then **Settings → Email** shows it read-only, marked
**Set by the environment**; the alert switches can still be changed there.

| Variable | Meaning |
|---|---|
| `QUALOR_SMTP_URL` | `smtp://user:password@host:587` (STARTTLS), `smtps://user:password@host:465` (TLS), or `smtp://host:25?security=none` (no TLS). Without a port: 587 for `smtp://`, 465 for `smtps://` |
| `QUALOR_SMTP_FROM` | the sender, `Qualor <qualor@example.com>` or just the address. Required with `QUALOR_SMTP_URL` |
| `QUALOR_SMTP_REPLY_TO` | optional: where replies go |

URL-encode special characters in the user name and the password: `@` as `%40`, `:` as `%3A`,
`/` as `%2F`, `%` as `%25`. A mistake in these variables stops the server at start, and the
message names the variable, never the password.

Examples:

- **Microsoft 365**: `smtp://qualor%40example.com:<password>@smtp.office365.com:587`. The mailbox
  needs SMTP AUTH turned on (Microsoft 365 admin center → the user → Mail → Manage email apps →
  Authenticated SMTP).
- **Gmail or Google Workspace**: `smtp://qualor%40example.com:<app password>@smtp.gmail.com:587`,
  with an app password of that account (it needs 2-step verification), not its normal password.
- **Amazon SES**: `smtps://<SMTP user name>:<SMTP password>@email-smtp.eu-west-1.amazonaws.com:465`,
  with SES's SMTP credentials (not an access key). The From address must be a verified identity.
- **A relay on your network**: `smtp://postfix.internal:25?security=none`.

With Docker Compose, add to `.env`:

```sh
QUALOR_SMTP_URL=smtp://qualor%40example.com:<password>@smtp.office365.com:587
QUALOR_SMTP_FROM=Qualor <qualor@example.com>
```

and uncomment the two `QUALOR_SMTP_…` lines of `compose.yml` ([Install the
server](./install-server.md#the-compose-file)). With Helm, see
[Settings](./install-server.md#settings).

## TLS and private certificate authorities

Qualor always checks the SMTP server's certificate, and speaks TLS 1.2 or later. There is no
setting to accept a certificate that does not verify. When your mail server's certificate comes
from a private certificate authority, give the server that CA in `NODE_EXTRA_CA_CERTS`
([Server settings](./install-server.md#server-settings)).

## Delivery, retries and the log

A message is stored in the same database transaction as what it is about, so an alert is never
lost or sent for something that did not happen. Qualor then sends it on its own: a slow mail
server never delays analyses.

- A temporary failure (the server cannot be reached, does not answer in time, or answers with a
  `4xx` code such as greylisting) is retried 1, 2, 4, 8, 16 and 32 minutes later: 7 attempts.
- A permanent failure (a `5xx` answer, a refused password, a certificate that does not verify, or
  STARTTLS not offered) fails the message at once.
- A message still waiting after 2 days is given up.

**Recent messages** in **Settings → Email** lists every message with when it was queued, the
recipient, the subject and its status (**Delivered**, **Retrying n/7**, **Failed** or **Pending**),
with the server's answer or the error. The body of a message is kept encrypted only while it waits,
and deleted once it was sent or failed; the log keeps the subject, the recipient, the status and
the server's answer for 30 days ([Retention](./install-server.md#retention)).

The API is `GET /api/v0/system/mail` and `PUT /api/v0/system/mail` (the settings; the password is
write-only), `POST /api/v0/system/mail/test` (`{ "to": "you@example.com" }`) and
`GET /api/v0/system/mail/messages` ([REST API](./webhooks-and-api.md#rest-api)); instance
administrators only. Changing the settings and sending a test are in the
[audit log](./roles-and-audit.md#the-audit-log-enterprise-audit-log).

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "The SMTP server could not be reached, or the TLS connection to it failed." | a wrong host or port, a firewall (allow the server's outgoing connections to that port; with the Helm NetworkPolicy, add an egress rule), or a certificate that does not verify | check **Host**, **Port** and **Security**; for a private CA, set `NODE_EXTRA_CA_CERTS` |
| "The SMTP server refused the user name or password." | wrong credentials | Microsoft 365: turn on Authenticated SMTP for the mailbox; Gmail: use an app password |
| STARTTLS refused, or "the server does not offer it" | the server speaks implicit TLS, or no TLS | choose **TLS** (port 465), or **None** for a relay on your own network |
| a `5xx` answer such as "relay not permitted" or "sender not allowed" | the server does not let this account send as the **From address** | use an address the account may send from |
| "The stored password can't be decrypted (QUALOR_SECRET_KEY changed): enter it again." under **Password**, or "The stored SMTP password can no longer be read. Enter it again." after **Send test** | `QUALOR_SECRET_KEY` changed | **Replace** the password |
| "The SMTP server did not answer in time." | the server is slow or a firewall drops the connection | check **Host** and **Port**, that the server is up, and the firewall between Qualor and it |
| "The SMTP server refused the message." | the server refused the sender or the recipient without a reply that says why | check the **From address** and the recipient; look at the mail server's own log |
| messages have no links, and the page warns about `QUALOR_PUBLIC_URL` | `QUALOR_PUBLIC_URL` is not set | set it and restart ([Server settings](./install-server.md#server-settings)) |
| an administrator gets no alerts | no email address, the alert is off, or it was sent already (once per licence step, once a day per webhook) | add the address in **Settings → Users**; check the switches; look at **Recent messages** |
