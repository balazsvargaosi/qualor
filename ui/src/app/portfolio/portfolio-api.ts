import { Injectable, inject } from '@angular/core';
import { ok } from '../api/api';
import {
  EeApi,
  type PortfolioOverview,
  type PortfolioProjectRow,
  type PortfolioSort,
} from '../api/ee';
import type { KeysetPage } from '../shared/keyset';

/** Whose portfolio (4E-2 §2): one organisation's projects, or those of every organisation. */
export type PortfolioScope = { scope: 'organization'; organizationId: string } | { scope: 'all' };
export type PortfolioGranularity = 'week' | 'month';
export type PortfolioFormat = 'csv' | 'pdf';

/** 4E-2 §3: a page of the projects table holds at most 100 rows; the page asks for 50. */
const PAGE_SIZE = 50;
const EXPORT = '/api/v0/ee/portfolio/export';

/** The typed portfolio calls of the enterprise API (4E-2 §3), for the portfolio page only. */
@Injectable({ providedIn: 'root' })
export class PortfolioApi {
  private readonly ee = inject(EeApi);

  overview(scope: PortfolioScope, granularity: PortfolioGranularity): Promise<PortfolioOverview> {
    return ok(
      this.ee.client.GET('/api/v0/ee/portfolio', { params: { query: { ...scope, granularity } } }),
    );
  }

  projects(
    scope: PortfolioScope,
    sort: PortfolioSort,
    cursor: string | null,
  ): Promise<KeysetPage<PortfolioProjectRow>> {
    return ok(
      this.ee.client.GET('/api/v0/ee/portfolio/projects', {
        params: { query: { ...scope, sort, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
      }),
    );
  }

  /** The file's address: a plain download link, as the audit log and compliance reports export. */
  exportHref(
    scope: PortfolioScope,
    granularity: PortfolioGranularity,
    format: PortfolioFormat,
  ): string {
    const query = new URLSearchParams({ ...scope, granularity, format });
    return `${EXPORT}?${query.toString()}`;
  }
}
