/**
 * The webhook secret of an SCM connection, a GitHub App's (github.md §2.2) or a GitLab
 * connection's (6I-4): 16 to 256 printable ASCII characters without spaces. The server checks the
 * same shape (`WEBHOOK_SECRET_PATTERN`, server/src/scm/github/app-auth.ts); the UI never imports
 * the server, so tools/webhook-secret.test.ts keeps the two equal.
 */
export const WEBHOOK_SECRET = /^[\x21-\x7e]{16,256}$/;
