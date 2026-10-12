import type { Provider } from '@angular/core';
import { FETCH } from '../app/api/api';
import type { ComplianceReport } from '../app/api/ee';
import type { Me } from '../app/api/types';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Response headers (for example `retry-after`). */
  headers?: Record<string, string>;
}

/** A reply, or a function of the request; a promise lets a test hold an answer back. */
type Responder = FakeReply | ((request: RecordedRequest) => FakeReply | Promise<FakeReply>);

/**
 * A stand-in for the server in component tests: answers `fetch` by method and path, records
 * every request, and answers anything unexpected with the API's 404 problem.
 */
export class FakeServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; path: string | RegExp; responder: Responder }[] = [];

  /** Answers `method` on `path`: an exact path, or a pattern for paths with an id in them. */
  on(method: string, path: string | RegExp, responder: Responder): this {
    this.routes.unshift({ method, path, responder });
    return this;
  }

  requestsTo(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    const recorded: RecordedRequest = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    this.requests.push(recorded);
    const route = this.routes.find(
      (r) =>
        r.method === request.method &&
        (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    const reply: FakeReply = route
      ? typeof route.responder === 'function'
        ? await route.responder(recorded)
        : route.responder
      : { status: 404, body: problem(404, 'NOT_FOUND') };
    const status = reply.status ?? 200;
    const headers = reply.headers ?? {};
    if (status === 204 || reply.body === undefined) return new Response(null, { status, headers });
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        ...headers,
      },
    });
  };
}

export function problem(
  status: number,
  code: string,
  errors?: { path: string; message: string }[],
) {
  return {
    type: `urn:qualor:problem:${code.toLowerCase().replaceAll('_', '-')}`,
    title: code,
    status,
    code,
    ...(errors ? { errors } : {}),
  };
}

export function provideFakeServer(server: FakeServer): Provider[] {
  return [{ provide: FETCH, useValue: server.fetch }];
}

export const ORG_ID = '0190a6c2-0000-7000-8000-000000000001';

/** An organisation admin's permissions, as `GET /auth/me` lists them (rbac-audit.md §3.2). */
export const ORG_ADMIN_PERMISSIONS = [
  'org.audit.read',
  'org.gates.manage',
  'org.members.manage',
  'org.members.read',
  'org.profiles.manage',
  'org.projects.create',
  'org.read',
  'org.scm.manage',
  'org.webhooks.manage',
] as const;

/** A maintainer's (`member`) permissions on a project, as the project DTO lists them (§3.2). */
export const MEMBER_PROJECT_PERMISSIONS = [
  'ai.use',
  'issue.triage',
  'project.analyze',
  'project.read',
] as const;

/** A viewer's permissions on a project: reading only. */
export const VIEWER_PROJECT_PERMISSIONS = ['project.read'] as const;

export function me(
  overrides: { passwordChangeRequired?: boolean; admin?: boolean; demo?: boolean } = {},
): Me {
  return {
    user: {
      id: '0190a6c2-0000-7000-8000-00000000000a',
      username: 'alice',
      displayName: 'Alice',
      email: null,
      isInstanceAdmin: overrides.admin ?? false,
      active: true,
      passwordChangeRequired: overrides.passwordChangeRequired ?? false,
      hasPassword: true,
      sso: { identities: 0, scim: false },
      lastLoginAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    memberships: [
      {
        organizationId: ORG_ID,
        organizationKey: 'default',
        organizationName: 'Default',
        role: overrides.admin ? 'admin' : 'member',
        permissions: overrides.admin ? [...ORG_ADMIN_PERMISSIONS] : ['org.read'],
      },
    ],
    projectGrants: [],
    csrfToken: 'csrf-token',
    demo: overrides.demo ?? false,
  };
}

export function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

/** Lets pending fetches, navigations and change detection finish (the fake fetch is async). */
export async function settle(fixture?: { whenStable(): Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture?.whenStable();
  }
}

/**
 * A secret field (an API key, a token, a webhook secret) that password managers must neither fill
 * nor offer to save: `data-1p-ignore` (1Password) and `data-lpignore` (LastPass); a password
 * input also has `autocomplete="new-password"`, which browsers honour where they ignore `off`.
 */
export function expectNoPasswordManager(field: Element): void {
  expect(field.hasAttribute('data-1p-ignore')).toBe(true);
  expect(field.getAttribute('data-lpignore')).toBe('true');
  if (field instanceof HTMLInputElement && field.type === 'password') {
    expect(field.getAttribute('autocomplete')).toBe('new-password');
  }
}

const COMPLIANCE = '/api/v0/ee/compliance/reports';
const COMPLIANCE_ID = /^\/api\/v0\/ee\/compliance\/reports\/([^/]+)$/;
const COMPLIANCE_DOWNLOAD = /^\/api\/v0\/ee\/compliance\/reports\/([^/]+)\/download$/;
const NO_SEVERITIES = { blocker: 0, high: 0, medium: 0, low: 0, info: 0 };

/** A compliance report as the API shows it (4E-1 §3): a ready project report by default. */
export function complianceReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    id: '0190a6c2-0000-7000-8000-0000000000c1',
    scope: 'project',
    organization: { id: ORG_ID, key: 'default', name: 'Default' },
    project: { id: '0190a6c2-0000-7000-8000-0000000000f1', key: 'acme/x', name: 'X' },
    branch: { id: '0190a6c2-0000-7000-8000-0000000000b1', name: 'main' },
    status: 'ready',
    createdBy: 'Alice',
    createdAt: '2026-10-12T10:00:00.000Z',
    completedAt: '2026-10-12T10:00:05.000Z',
    standards: [{ id: 'owasp-top10-2021', version: '2021', sourceSha256: 'f'.repeat(64) }],
    sha256: 'ab'.repeat(32),
    sizeBytes: 1024,
    error: null,
    summary: complianceSummary(),
    canDelete: false,
    ...overrides,
  };
}

/** A report's summary (4E-1 §2.6): one OWASP Top 10 2021 category and nothing else, by default. */
export function complianceSummary(
  overrides: Partial<NonNullable<ComplianceReport['summary']>> = {},
): NonNullable<ComplianceReport['summary']> {
  return {
    findings: { total: 3, bySeverity: { ...NO_SEVERITIES, high: 2, low: 1 }, inNewCode: 1 },
    standards: [
      {
        id: 'owasp-top10-2021',
        categories: [
          {
            id: 'A03',
            title: 'Injection',
            open: 2,
            bySeverity: { ...NO_SEVERITIES, high: 2 },
            inNewCode: 1,
            rules: 1,
            oldestFirstSeenAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        notMapped: { open: 1, bySeverity: { ...NO_SEVERITIES, low: 1 }, inNewCode: 0, rules: 1 },
        distinctTotal: 3,
      },
    ],
    secrets: { open: 0 },
    dependencies: { open: 0, bySeverity: { ...NO_SEVERITIES } },
    triage: { falsePositive: 0, wontFix: 0 },
    truncated: false,
    ...overrides,
  };
}

/**
 * The compliance report API (4E-1 §3) over an in-memory list, newest first: list (by
 * organisation or project), create (a pending report), read, download and delete. A test changes
 * `reports` to play the build job, or answers a route itself with `server.on`, which wins.
 */
export class FakeCompliance {
  readonly reports: ComplianceReport[];
  private created = 0;

  constructor(server: FakeServer, reports: ComplianceReport[] = []) {
    this.reports = [...reports];
    server.on('GET', COMPLIANCE, (r) => {
      const organizationId = r.query.get('organizationId');
      const projectId = r.query.get('projectId');
      const items = this.reports
        .filter((report) =>
          projectId
            ? report.project?.id === projectId
            : report.scope === 'organization' && report.organization.id === organizationId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { body: page(items) };
    });
    server.on('POST', COMPLIANCE, (r) => {
      const body = r.body as { organizationId?: string; projectId?: string; branchId?: string };
      this.created++;
      const report = complianceReport({
        id: `0190a6c2-0000-7000-8000-${String(900 + this.created).padStart(12, '0')}`,
        scope: body.projectId ? 'project' : 'organization',
        project: body.projectId ? { id: body.projectId, key: 'acme/x', name: 'X' } : null,
        branch: body.branchId ? { id: body.branchId, name: 'main' } : null,
        status: 'pending',
        createdAt: new Date(Date.UTC(2026, 9, 13, 0, this.created)).toISOString(),
        completedAt: null,
        sha256: null,
        sizeBytes: null,
        summary: null,
        canDelete: true,
      });
      this.reports.unshift(report);
      return { status: 202, body: report };
    });
    server.on('GET', COMPLIANCE_ID, (r) => {
      const report = this.find(r.path, COMPLIANCE_ID);
      return report ? { body: report } : { status: 404, body: problem(404, 'NOT_FOUND') };
    });
    server.on('GET', COMPLIANCE_DOWNLOAD, (r) => {
      const report = this.find(r.path, COMPLIANCE_DOWNLOAD);
      if (!report) return { status: 404, body: problem(404, 'NOT_FOUND') };
      if (report.status !== 'ready') return { status: 409, body: problem(409, 'REPORT_NOT_READY') };
      return { body: { schemaVersion: 1, id: report.id } };
    });
    server.on('DELETE', COMPLIANCE_ID, (r) => {
      const report = this.find(r.path, COMPLIANCE_ID);
      if (!report) return { status: 404, body: problem(404, 'NOT_FOUND') };
      if (report.status === 'pending') return { status: 409, body: problem(409, 'REPORT_PENDING') };
      this.reports.splice(this.reports.indexOf(report), 1);
      return { status: 204 };
    });
  }

  /** Plays the build job: the report becomes ready with its sha256 and summary. */
  complete(id: string, overrides: Partial<ComplianceReport> = {}): void {
    const at = this.reports.findIndex((r) => r.id === id);
    const report = this.reports[at];
    if (!report) throw new Error(`no report ${id}`);
    this.reports[at] = {
      ...report,
      status: 'ready',
      completedAt: '2026-10-13T00:05:00.000Z',
      sha256: 'cd'.repeat(32),
      sizeBytes: 2048,
      summary: complianceSummary(),
      ...overrides,
    };
  }

  private find(path: string, pattern: RegExp): ComplianceReport | undefined {
    const id = pattern.exec(path)?.[1];
    return this.reports.find((r) => r.id === id);
  }
}
