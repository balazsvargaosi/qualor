import { DOCUMENT, Injectable, inject } from '@angular/core';
import createClient, { type Client } from 'openapi-fetch';
import { Api, FETCH } from './api';
import type { paths } from './schema-ee';

/**
 * The typed client of the enterprise API (`/api/v0/ee/*`, rbac-audit.md §13): openapi-fetch
 * over `schema-ee.ts`, generated from the plugin's OpenAPI document by
 * `pnpm --filter @qualor/ui api:ee`. Same origin, same session and the same middleware as the core
 * client (CSRF header, expired session, password change). The screens that use it appear only
 * while `/system/info` lists their feature, so a community server is never asked.
 */
@Injectable({ providedIn: 'root' })
export class EeApi {
  private readonly fetchImpl = inject(FETCH);

  readonly client: Client<paths> = createClient<paths>({
    baseUrl: inject(DOCUMENT).location.origin,
    fetch: (request) => this.fetchImpl(request),
  });

  constructor() {
    this.client.use(inject(Api).middleware);
  }
}

type JsonOf<R> = R extends { content: { 'application/json': infer T } } ? T : never;

/** The JSON body of an enterprise operation's 200 response. */
export type EeResponse<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: infer Ok };
}
  ? JsonOf<Ok>
  : never;

export type AuditEvent = EeResponse<'/api/v0/ee/audit/events', 'get'>['items'][number];
export type AuditEventsQuery = NonNullable<
  paths['/api/v0/ee/audit/events']['get']['parameters']['query']
>;
export type AuditHead = EeResponse<'/api/v0/ee/audit/head', 'get'>;
export type AuditVerification = EeResponse<'/api/v0/ee/audit/verify', 'get'>;
export type AuditSettings = EeResponse<'/api/v0/ee/audit/settings', 'get'>;
export type AuditStreamStatus = NonNullable<AuditSettings['stream']>['status'];
export type StreamTest = EeResponse<'/api/v0/ee/audit/settings/stream/test', 'post'>;
/** One of your own SSO identities (sso-scim.md §8.1, `GET /ee/sso/me/identities`). */
export type LinkedIdentity = EeResponse<'/api/v0/ee/sso/me/identities', 'get'>[number];
/** The single sign-on settings (§10): password sign-in, break-glass admins, `forced` (§10.4). */
export type SsoSettings = EeResponse<'/api/v0/ee/sso/settings', 'get'>;

/** The JSON body an enterprise operation takes. */
export type EeRequest<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  requestBody?: { content: { 'application/json': infer T } };
}
  ? T
  : never;

/** An SSO connection as the API shows it (sso-scim.md §4, §17.2): never a secret, only `…Set`. */
export type SsoConnection = EeResponse<'/api/v0/ee/sso/connections', 'get'>[number];
export type SsoConnectionInput = EeRequest<'/api/v0/ee/sso/connections', 'post'>;
export type SsoConnectionPatch = EeRequest<'/api/v0/ee/sso/connections/{id}', 'patch'>;
/** **Test** (§4.2): a fixed problem code, and the endpoints or certificates it found. */
export type SsoConnectionTest = EeResponse<'/api/v0/ee/sso/connections/{id}/test', 'post'>;
/** **Read metadata** (§4.3): what the IdP's metadata would set, for review before saving. */
export type SamlMetadataPreview = EeResponse<
  '/api/v0/ee/sso/connections/{id}/saml/metadata',
  'post'
>;
export type SsoCertificate = SamlMetadataPreview['certificates'][number];
/** A group mapping (§9.2). */
export type SsoMapping = EeResponse<'/api/v0/ee/sso/connections/{id}/mappings', 'get'>[number];
export type SsoMappingInput = EeRequest<'/api/v0/ee/sso/connections/{id}/mappings', 'put'>[number];
/** A SCIM token (§12.2): its prefix and dates, never the token. */
export type ScimToken = EeResponse<'/api/v0/ee/scim/tokens', 'get'>[number];
/** A compliance report (4E-1 §3): its state, its standards and the summary the preview shows. */
export type ComplianceReport = EeResponse<'/api/v0/ee/compliance/reports/{id}', 'get'>;
/** A page of compliance reports, newest first. */
export type ComplianceReportPage = EeResponse<'/api/v0/ee/compliance/reports', 'get'>;
/** The summary of a ready report (4E-1 §2.6). */
export type ComplianceSummary = NonNullable<ComplianceReport['summary']>;
/** The portfolio of an organisation or of all (4E-2 §2): totals, trend, organisations, attention. */
export type PortfolioOverview = EeResponse<'/api/v0/ee/portfolio', 'get'>;
/** One trend point: the figures at the period's end, and the period's activity. */
export type PortfolioTrendPoint = PortfolioOverview['trend'][number];
/** The figures over a set of projects (4E-2 §1). */
export type PortfolioAggregate = Omit<PortfolioTrendPoint, 'start' | 'end' | 'analyses' | 'triage'>;
/** A project of the portfolio, on its main branch; ratings are letters A–E. */
export type PortfolioProjectRow = EeResponse<
  '/api/v0/ee/portfolio/projects',
  'get'
>['items'][number];
/** The orders of the portfolio's projects table. */
export type PortfolioSort = NonNullable<
  NonNullable<paths['/api/v0/ee/portfolio/projects']['get']['parameters']['query']>['sort']
>;
