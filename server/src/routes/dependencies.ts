import { LICENSE_GROUPS, type LicenseGroupId } from '@qualor/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { accessOf, requireUser } from '../auth/access';
import { branches } from '../db/schema';
import {
  dependencySummary,
  hasInventory,
  listDependencies,
  type DependencyFilter,
} from '../dependencies/query';
import { notFound } from '../http/problem';
import { idParams, noNul, text } from '../http/schemas';
import { projectForUser } from '../projects/access';

const GROUP_IDS = LICENSE_GROUPS.map((g) => g.id) as [LicenseGroupId, ...LicenseGroupId[]];
const booleanParam = z.enum(['true', 'false']).optional();

/** One inventory entry. Later fields (the policy verdict) are added per row, optional. */
const dependencySchema = z.object({
  ecosystem: z.string(),
  /** The lockfile or manifest, repo-relative. */
  path: z.string(),
  line: z.number().int().nullable(),
  name: z.string(),
  version: z.string(),
  /** SPDX ids or expressions as the scanner normalised them; `[]` means unknown. */
  licenses: z.array(z.string()),
  /** `null`: the scanner did not say. */
  direct: z.boolean().nullable(),
});

const summarySchema = z.object({
  total: z.number().int(),
  known: z.number().int(),
  unknown: z.number().int(),
  /** The 20 most frequent licence strings. */
  byLicense: z.array(z.object({ license: z.string(), count: z.number().int() })),
});

const responseSchema = z.object({
  rows: z.array(dependencySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Entries matching the filters. */
  total: z.number().int(),
  /** The whole inventory of the branch, whatever the filters. */
  summary: summarySchema,
  /** `false`: no analysis of the branch has reported a dependency inventory yet. */
  inventory: z.boolean(),
});

const querySchema = z
  .strictObject({
    /** A branch by name; the main branch when neither `branch` nor `mr` is given. */
    branch: text(255).optional(),
    /** A merge request by its number. */
    mr: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    license: text(256).optional(),
    group: z.enum(GROUP_IDS).optional(),
    ecosystem: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    unknown: booleanParam,
    direct: booleanParam,
    q: noNul(z.string().trim().min(1).max(200)).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((q) => q.branch === undefined || q.mr === undefined, {
    message: 'Give branch or mr, not both',
    path: ['mr'],
  });

const EMPTY_SUMMARY = { total: 0, known: 0, unknown: 0, byLicense: [] };

export const dependencyRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (
  app,
  { deps },
) => {
  app.get(
    '/projects/:id/dependencies',
    {
      config: { openapi: { problems: [404] } },
      schema: {
        tags: ['dependencies'],
        summary:
          'The dependency inventory of a branch or merge request (the main branch by default), filtered and paged',
        params: idParams,
        querystring: querySchema,
        response: { 200: responseSchema },
      },
    },
    async (request) => {
      const query = request.query;
      const project = await projectForUser(
        accessOf(deps),
        requireUser(request),
        request.params.id,
        'project.read',
      );

      const named = query.mr !== undefined || query.branch !== undefined;
      const [branch] = await deps.db
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.projectId, project.id),
            query.mr !== undefined
              ? and(eq(branches.kind, 'merge_request'), eq(branches.name, String(query.mr)))
              : query.branch !== undefined
                ? and(eq(branches.kind, 'branch'), eq(branches.name, query.branch))
                : eq(branches.isMain, true),
          ),
        );
      const paging = { page: query.page, pageSize: query.pageSize };
      if (!branch) {
        if (named) throw notFound('Branch');
        // The main branch has no analysis yet.
        return { rows: [], ...paging, total: 0, summary: EMPTY_SUMMARY, inventory: false };
      }

      const filter: DependencyFilter = {
        ...(query.license !== undefined && { license: query.license }),
        ...(query.group !== undefined && { group: query.group }),
        ...(query.ecosystem !== undefined && { ecosystem: query.ecosystem }),
        ...(query.unknown !== undefined && { unknown: query.unknown === 'true' }),
        ...(query.direct !== undefined && { direct: query.direct === 'true' }),
        ...(query.q !== undefined && { q: query.q }),
      };
      const [list, summary] = await Promise.all([
        listDependencies(deps.db, branch.id, filter, paging),
        dependencySummary(deps.db, branch.id),
      ]);
      return {
        rows: list.rows,
        ...paging,
        total: list.total,
        summary,
        inventory: await hasInventory(deps.db, branch.id, summary.total),
      };
    },
  );
};
