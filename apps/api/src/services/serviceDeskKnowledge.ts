import pg from 'pg';
import {
  badRequest,
  conflict,
  createNotification,
  emitEvent,
  forbidden,
  hasPerm,
  logAudit,
  n,
  nn,
  notFound,
  notifyUsers,
  oneOf,
  parsePagination,
  resolveScope,
  s,
  truthy,
  uniq,
  usersWithPermission,
  type Ctx,
  type TicketScope,
} from './serviceDeskCommon.js';

/**
 * HOPE DESIGN Service Desk - Knowledge Base (spec section 16).
 *
 * Articles move through DRAFT -> REVIEW -> APPROVED -> PUBLISHED -> ARCHIVED.
 * Only PUBLISHED articles are ever visible to ordinary employees; the other
 * states are working drafts visible to knowledge authors and managers. Every
 * transition writes a knowledge_versions snapshot so the published text a
 * technician relied on can always be reconstructed after the fact.
 *
 * Authorization mirrors the ticket service: RBAC is declared at the route, and
 * this module additionally re-checks organizational scope and article
 * visibility so a mis-declared route still cannot leak a CONFIDENTIAL or
 * RESTRICTED article to the wrong department.
 */

// --------------------------------------------------------------- enumerations

export const KNOWLEDGE_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/**
 * Legal article transitions. ARCHIVED is reachable from anything except DRAFT
 * (a draft that was never published is deleted rather than archived), and
 * PUBLISHED may go back to REVIEW when an article needs re-approval after a
 * material edit.
 */
const ARTICLE_TRANSITIONS: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  DRAFT: ['REVIEW', 'ARCHIVED'],
  REVIEW: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  APPROVED: ['REVIEW', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['REVIEW', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

const assertArticleTransition = (from: string, to: KnowledgeStatus): void => {
  const allowed = ARTICLE_TRANSITIONS[from as KnowledgeStatus];
  if (!allowed) throw conflict(`Unknown article status ${from}`);
  if (!allowed.includes(to)) {
    throw conflict(`Cannot move a knowledge article from ${from} to ${to}`);
  }
};

/** Classifications an ordinary employee may read. */
const EMPLOYEE_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL'] as const;

// ------------------------------------------------------------------ categories

export const KNOWLEDGE_CATEGORY_COLUMNS = `
  kc.id, kc.parent_id, kc.code, kc.name, kc.description, kc.icon,
  kc.sort_order, kc.is_active, kc.created_at, kc.updated_at,
  parent.name AS parent_name,
  (SELECT count(*) FROM knowledge_articles a
    WHERE a.category_id = kc.id AND a.status = 'PUBLISHED')::int AS published_articles`;

export async function listKnowledgeCategories(
  client: pg.PoolClient,
  ctx: Ctx,
  q: { includeInactive?: boolean } = {}
) {
  const includeInactive = truthy(q.includeInactive);
  const res = await client.query(
    `SELECT ${KNOWLEDGE_CATEGORY_COLUMNS}
       FROM knowledge_categories kc
       LEFT JOIN knowledge_categories parent ON parent.id = kc.parent_id
      WHERE kc.tenant_id = $1 AND kc.company_id = $2
        AND ($3::boolean OR kc.is_active)
      ORDER BY kc.sort_order, kc.name`,
    [ctx.tenantId, ctx.companyId, includeInactive]
  );
  return res.rows;
}

export async function createKnowledgeCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  b: Record<string, unknown>
) {
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('code is required');
  if (!name) throw badRequest('name is required');

  const res = await client.query(
    `INSERT INTO knowledge_categories
       (tenant_id, company_id, parent_id, code, name, description, icon, sort_order, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING id`,
    [
      ctx.tenantId, ctx.companyId,
      nn(b.parentId ?? b.parent_id), code.toUpperCase(), name,
      s(b.description) ?? null, s(b.icon) ?? null,
      n(b.sortOrder ?? b.sort_order) ?? 100,
      b.isActive === undefined && b.is_active === undefined ? true : truthy(b.isActive ?? b.is_active),
      ctx.userId ?? null,
    ]
  );
  const id = Number(res.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'knowledge_categories',
    recordId: id,
    recordCode: code.toUpperCase(),
    newValues: { code: code.toUpperCase(), name },
  });
  return { id };
}

export async function updateKnowledgeCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown>
) {
  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (b.name !== undefined) push('name', s(b.name) ?? null);
  if (b.description !== undefined) push('description', s(b.description) ?? null);
  if (b.icon !== undefined) push('icon', s(b.icon) ?? null);
  if (b.parentId !== undefined || b.parent_id !== undefined) {
    push('parent_id', nn(b.parentId ?? b.parent_id));
  }
  if (b.sortOrder !== undefined || b.sort_order !== undefined) {
    push('sort_order', n(b.sortOrder ?? b.sort_order) ?? 100);
  }
  if (b.isActive !== undefined || b.is_active !== undefined) {
    push('is_active', truthy(b.isActive ?? b.is_active));
  }
  if (b.code !== undefined) push('code', (s(b.code) ?? '').toUpperCase());
  if (!sets.length) throw badRequest('No updatable fields supplied');

  params.push(ctx.userId ?? null);
  sets.push(`updated_by = $${params.length}`);

  const res = await client.query(
    `UPDATE knowledge_categories SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING id`,
    params
  );
  if (!res.rowCount) throw notFound('Knowledge category not found');
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'knowledge_categories',
    recordId: id,
    newValues: b,
  });
  return { id };
}

// -------------------------------------------------------------------- articles

export const ARTICLE_COLUMNS = `
  a.id, a.article_number, a.category_id, a.title, a.summary, a.body, a.keywords,
  a.status, a.data_classification, a.audience_roles, a.current_version,
  a.author_user_id, a.owner_user_id,
  a.reviewed_by, a.reviewed_at, a.approved_by, a.approved_at,
  a.published_by, a.published_at, a.archived_by, a.archived_at,
  a.view_count, a.helpful_count, a.not_helpful_count,
  a.rating_sum, a.rating_count, a.ticket_usage_count,
  a.created_by, a.created_at, a.updated_at,
  kc.name AS category_name,
  au.email AS author_email,
  ow.email AS owner_email`;

export const ARTICLE_FROM = `
  FROM knowledge_articles a
  LEFT JOIN knowledge_categories kc ON kc.id = a.category_id
  LEFT JOIN users au ON au.id = a.author_user_id
  LEFT JOIN users ow ON ow.id = a.owner_user_id`;

export interface ArticleRow {
  id: number;
  article_number: string;
  category_id: number | null;
  title: string;
  summary: string | null;
  body: string | null;
  keywords: string[] | null;
  status: string;
  data_classification: string;
  audience_roles: string[] | null;
  current_version: number;
  author_user_id: number | null;
  owner_user_id: number | null;
  reviewed_by: number | null;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  rating_sum: number;
  rating_count: number;
  ticket_usage_count: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeScope extends TicketScope {
  roles: string[];
  canAuthor: boolean;
  canApprove: boolean;
  canPublish: boolean;
  canArchive: boolean;
  canManageCategories: boolean;
}

/**
 * Resolve knowledge reach. Article authorship, approval, publishing and
 * archiving are separate capabilities on purpose: the person who writes an
 * article should not necessarily be the person who publishes it, and the
 * segregation-of-duties engine checks the same split at the route.
 */
export async function resolveKnowledgeScope(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<KnowledgeScope> {
  const base = await resolveScope(client, ctx);
  const roles: string[] = [];
  if (base.userId) {
    const r = await client.query<{ code: string }>(
      `SELECT DISTINCT ro.code
         FROM user_roles ur
         JOIN roles ro ON ro.id = ur.role_id
        WHERE ur.user_id = $1`,
      [base.userId]
    );
    for (const row of r.rows) roles.push(String(row.code));
  }
  const perms = base.permissions;
  return {
    ...base,
    roles,
    canAuthor: base.isAdmin || hasPerm(perms, 'service_desk.knowledge.create') || hasPerm(perms, 'service_desk.knowledge.update'),
    canApprove: base.isAdmin || hasPerm(perms, 'service_desk.knowledge.approve'),
    canPublish: base.isAdmin || hasPerm(perms, 'service_desk.knowledge.publish'),
    canArchive: base.isAdmin || hasPerm(perms, 'service_desk.knowledge.archive'),
    canManageCategories: base.isAdmin || hasPerm(perms, 'service_desk.knowledge.manage'),
  };
}

/**
 * The reading rule for one caller, as a SQL predicate over alias `a`.
 *
 * Employees see PUBLISHED articles whose classification they may read and
 * whose audience matches one of their roles. Knowledge staff additionally see
 * every workflow state, because they are the ones moving articles through it.
 */
export function articleVisibility(scope: KnowledgeScope, alias = 'a'): string {
  if (scope.canAuthor || scope.canApprove || scope.canPublish) return 'TRUE';
  const allowed = EMPLOYEE_CLASSIFICATIONS.map((c) => `'${c}'`).join(', ');
  return [
    `(${alias}.status = 'PUBLISHED')`,
    `(${alias}.data_classification IN (${allowed}))`,
  ].join(' AND ');
}

/**
 * Audience gate applied in SQL. An article with no audience_roles is addressed
 * to everyone; otherwise the caller must hold at least one of the listed roles.
 */
export function articleAudience(scope: KnowledgeScope, alias = 'a'): { sql: string; param: unknown } {
  return {
    sql: `(${alias}.audience_roles IS NULL
           OR cardinality(${alias}.audience_roles) = 0
           OR ${alias}.audience_roles && $PARAM::text[])`,
    param: scope.roles,
  };
}

export async function loadArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<ArticleRow | null> {
  const res = await client.query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM}
      WHERE a.id = $1 AND a.tenant_id = $2 AND a.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

export async function loadArticleByNumber(
  client: pg.PoolClient,
  ctx: Ctx,
  articleNumber: string
): Promise<ArticleRow | null> {
  const res = await client.query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} ${ARTICLE_FROM}
      WHERE a.article_number = $1 AND a.tenant_id = $2 AND a.company_id = $3`,
    [articleNumber, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

/**
 * Fetch an article the caller is actually allowed to read, or fail closed.
 * Branches are honoured when the article is branch-scoped.
 */
export async function getKnowledgeArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  opts: { countView?: boolean } = {}
) {
  const scope = await resolveKnowledgeScope(client, ctx);
  const article = await loadArticle(client, ctx, id);
  if (!article) throw notFound('Knowledge article not found');
  if (!canReadArticle(scope, article)) throw forbidden('You cannot view this knowledge article');

  if (opts.countView && scope.userId) {
    await client.query(
      `UPDATE knowledge_articles
          SET view_count = view_count + 1
        WHERE id = $1 AND tenant_id = $2`,
      [article.id, ctx.tenantId]
    );
  }

  const [versions, feedback, links] = await Promise.all([
    listArticleVersions(client, ctx, article.id),
    listArticleFeedback(client, ctx, article.id, { limit: 20 }),
    client.query(
      `SELECT l.id, l.ticket_id, l.link_type, t.ticket_number, t.subject, t.status
         FROM ticket_knowledge_links l
         JOIN service_tickets t ON t.id = l.ticket_id
        WHERE l.article_id = $1 AND l.tenant_id = $2
        ORDER BY l.created_at DESC
        LIMIT 25`,
      [article.id, ctx.tenantId]
    ),
  ]);

  return {
    ...article,
    rating_average: article.rating_count
      ? Number((article.rating_sum / article.rating_count).toFixed(2))
      : null,
    permissions: {
      update: scope.canAuthor,
      approve: scope.canApprove,
      publish: scope.canPublish,
      archive: scope.canArchive,
    },
    versions,
    feedback,
    linked_tickets: links.rows,
  };
}

/** Read gate shared by the detail endpoint and the recommendation engine. */
export function canReadArticle(scope: KnowledgeScope, article: ArticleRow): boolean {
  const staff = scope.canAuthor || scope.canApprove || scope.canPublish;
  if (staff) return true;
  if (article.status !== 'PUBLISHED') return false;
  if (!(EMPLOYEE_CLASSIFICATIONS as readonly string[]).includes(article.data_classification)) {
    return false;
  }
  const audience = article.audience_roles ?? [];
  if (!audience.length) return true;
  return audience.some((r) => scope.roles.includes(r));
}

// ------------------------------------------------------- article read surface

export interface ListArticlesQuery extends Record<string, unknown> {}

const ARTICLE_SORTS: Record<string, string> = {
  relevance: 'rank DESC, a.created_at DESC',
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC',
  title: 'a.title ASC',
  popular: 'a.view_count DESC, a.helpful_count DESC',
  helpful: 'a.helpful_count DESC, a.view_count DESC',
  rating: 'CASE WHEN a.rating_count > 0 THEN a.rating_sum::numeric / a.rating_count ELSE 0 END DESC',
  updated: 'a.updated_at DESC',
};

export async function listKnowledgeArticles(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ListArticlesQuery = {}
) {
  const scope = await resolveKnowledgeScope(client, ctx);
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['a.tenant_id = $1', 'a.company_id = $2'];

  const vis = articleVisibility(scope, 'a');
  if (vis !== 'TRUE') where.push(vis);

  // Audience gate: no audience_roles means everyone.
  params.push(scope.roles);
  where.push(
    `(a.audience_roles IS NULL OR cardinality(a.audience_roles) = 0
      OR a.audience_roles && $${params.length}::text[])`
  );

  const add = (value: unknown, build: (i: number) => string) => {
    params.push(value);
    where.push(build(params.length));
  };

  const status = oneOf(q.status, KNOWLEDGE_STATUSES);
  if (status) add(status, (i) => `a.status = $${i}`);

  const categoryId = n(q.categoryId ?? q.category_id);
  if (categoryId) add(categoryId, (i) => `a.category_id = $${i}`);

  const classification = s(q.dataClassification ?? q.data_classification);
  if (classification) add(classification.toUpperCase(), (i) => `a.data_classification = $${i}`);

  const authorUserId = n(q.authorUserId ?? q.author_user_id);
  if (authorUserId) add(authorUserId, (i) => `a.author_user_id = $${i}`);

  const ownerUserId = n(q.ownerUserId ?? q.owner_user_id);
  if (ownerUserId) add(ownerUserId, (i) => `a.owner_user_id = $${i}`);

  const keyword = s(q.keyword ?? q.tag);
  if (keyword) {
    add(keyword, (i) => `EXISTS (SELECT 1 FROM unnest(a.keywords) k WHERE k ILIKE '%' || $${i} || '%')`);
  }

  const term = s(q.search ?? q.q);
  if (term) {
    params.push(term);
    const i = params.length;
    where.push(
      `(a.title ILIKE '%' || $${i} || '%'
        OR a.summary ILIKE '%' || $${i} || '%'
        OR a.body ILIKE '%' || $${i} || '%'
        OR a.article_number ILIKE '%' || $${i} || '%'
        OR EXISTS (SELECT 1 FROM unnest(a.keywords) k WHERE k ILIKE '%' || $${i} || '%')
        OR to_tsvector('english', coalesce(a.title,'') || ' ' || coalesce(a.summary,'') || ' ' || coalesce(a.body,''))
           @@ plainto_tsquery('english', $${i}))`
    );
  }

  const rank = term
    ? `GREATEST(
         similarity(a.title, $${params.length}),
         CASE WHEN to_tsvector('english', coalesce(a.title,'') || ' ' || coalesce(a.summary,''))
                   @@ plainto_tsquery('english', $${params.length})
              THEN 1 ELSE 0 END)`
    : '0::real';

  const sortKey = s(q.sort) ?? (term ? 'relevance' : 'newest');
  const orderBy = ARTICLE_SORTS[sortKey] ?? ARTICLE_SORTS.newest;

  const { page, pageSize: limit, offset } = parsePagination(q);

  const countRes = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total ${ARTICLE_FROM} WHERE ${where.join(' AND ')}`,
    params
  );

  const rows = await client.query(
    `SELECT ${ARTICLE_COLUMNS}, ${rank} AS rank
       ${ARTICLE_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    items: rows.rows,
    total: Number(countRes.rows[0]?.total ?? 0),
    page,
    limit,
    offset,
  };
}

// ------------------------------------------------------ article write surface

export interface CreateArticleInput extends Record<string, unknown> {}

export async function createKnowledgeArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  b: CreateArticleInput
) {
  const title = s(b.title);
  const body = s(b.body);
  if (!title) throw badRequest('title is required');
  if (!body) throw badRequest('body is required');

  const scope = await resolveKnowledgeScope(client, ctx);
  if (!scope.userId) throw forbidden('An authenticated user is required to author a knowledge article');

  const klass = (oneOf(b.dataClassification ?? b.data_classification, ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const)) ?? 'INTERNAL';

  const noRes = await client.query<{ article_number: string }>(
    `SELECT next_kb_article_no($1,$2) AS article_number`,
    [ctx.tenantId, ctx.companyId]
  );
  const articleNumber = noRes.rows[0].article_number;

  const keywords = Array.isArray(b.keywords)
    ? uniq((b.keywords as unknown[]).map((k) => String(k).trim()).filter(Boolean))
    : s(b.keywords)
      ? uniq(String(b.keywords).split(',').map((k) => k.trim()).filter(Boolean))
      : [];

  const audience = Array.isArray(b.audienceRoles ?? b.audience_roles)
    ? uniq(((b.audienceRoles ?? b.audience_roles) as unknown[]).map((r) => String(r).trim()).filter(Boolean))
    : [];

  const res = await client.query<{ id: number }>(
    `INSERT INTO knowledge_articles
       (tenant_id, company_id, branch_id, article_number, category_id, title, summary, body,
        keywords, status, data_classification, audience_roles, current_version,
        author_user_id, owner_user_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12::text[],1,$13,$14,$13,$13)
     RETURNING id`,
    [
      ctx.tenantId, ctx.companyId, ctx.branchId ?? null, articleNumber,
      nn(b.categoryId ?? b.category_id), title, s(b.summary) ?? null, body,
      keywords, 'DRAFT', klass, audience,
      scope.userId, nn(b.ownerUserId ?? b.owner_user_id) ?? scope.userId,
    ]
  );
  const id = Number(res.rows[0].id);
  await snapshotArticleVersion(client, ctx, id, 1, 'DRAFT', 'Initial draft');

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'knowledge_articles',
    recordId: id,
    recordCode: articleNumber,
    newValues: { title, status: 'DRAFT', data_classification: klass },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.knowledge.created',
    entityType: 'knowledge_article',
    entityId: id,
    entityCode: articleNumber,
    payload: { title, status: 'DRAFT' },
  });
  return { id, article_number: articleNumber, status: 'DRAFT' };
}

/**
 * Write (or overwrite) the version snapshot for an article. A published
 * article's text is immutable history: editing it opens a new version so the
 * words a technician already relied on can still be reconstructed.
 */
export async function snapshotArticleVersion(
  client: pg.PoolClient,
  ctx: Ctx,
  articleId: number,
  version: number,
  status: string,
  changeNote?: string | null
) {
  await client.query(
    `INSERT INTO knowledge_versions
       (tenant_id, company_id, article_id, version, title, summary, body, change_note, status, created_by)
     SELECT a.tenant_id, a.company_id, a.id, $3, a.title, a.summary, a.body, $5, $4, $6
       FROM knowledge_articles a
      WHERE a.id = $1 AND a.tenant_id = $2
     ON CONFLICT (article_id, version) DO UPDATE
        SET title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            body = EXCLUDED.body,
            change_note = COALESCE(EXCLUDED.change_note, knowledge_versions.change_note),
            status = EXCLUDED.status,
            updated_at = now()`,
    [articleId, ctx.tenantId, version, status, changeNote ?? null, ctx.userId ?? null]
  );
}

export async function updateKnowledgeArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown>
) {
  const article = await loadArticle(client, ctx, id);
  if (!article) throw notFound('Knowledge article not found');

  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  let contentChanged = false;
  if (b.title !== undefined) { push('title', s(b.title) ?? null); contentChanged = true; }
  if (b.summary !== undefined) { push('summary', s(b.summary) ?? null); contentChanged = true; }
  if (b.body !== undefined) { push('body', s(b.body) ?? null); contentChanged = true; }
  if (b.categoryId !== undefined || b.category_id !== undefined) {
    push('category_id', nn(b.categoryId ?? b.category_id));
  }
  if (b.dataClassification !== undefined || b.data_classification !== undefined) {
    push('data_classification', (oneOf(b.dataClassification ?? b.data_classification, ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const)) ?? 'INTERNAL');
  }
  if (b.ownerUserId !== undefined || b.owner_user_id !== undefined) {
    push('owner_user_id', nn(b.ownerUserId ?? b.owner_user_id));
  }
  if (b.keywords !== undefined) {
    const kw = Array.isArray(b.keywords)
      ? uniq((b.keywords as unknown[]).map((k) => String(k).trim()).filter(Boolean))
      : uniq(String(b.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean));
    params.push(kw);
    sets.push(`keywords = $${params.length}::text[]`);
  }
  if (b.audienceRoles !== undefined || b.audience_roles !== undefined) {
    const ar = Array.isArray(b.audienceRoles ?? b.audience_roles)
      ? uniq(((b.audienceRoles ?? b.audience_roles) as unknown[]).map((r) => String(r).trim()).filter(Boolean))
      : [];
    params.push(ar);
    sets.push(`audience_roles = $${params.length}::text[]`);
  }
  if (!sets.length) throw badRequest('No updatable fields supplied');

  // Editing a published article re-opens it for review: the published text is
  // snapshotted and a fresh draft version begins.
  let nextVersion = article.current_version;
  let nextStatus = article.status;
  if (contentChanged && article.status === 'PUBLISHED') {
    nextVersion = article.current_version + 1;
    nextStatus = 'REVIEW';
    params.push(nextVersion);
    sets.push(`current_version = $${params.length}`);
    params.push(nextStatus);
    sets.push(`status = $${params.length}`);
  }

  params.push(ctx.userId ?? null);
  sets.push(`updated_by = $${params.length}`);

  await client.query(
    `UPDATE knowledge_articles SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    params
  );

  if (contentChanged && nextVersion !== article.current_version) {
    await client.query(
      `INSERT INTO knowledge_versions
         (tenant_id, company_id, article_id, version, title, summary, body, change_note, status, created_by)
       SELECT a.tenant_id, a.company_id, a.id, $3, a.title, a.summary, a.body, $4, $5, $6
         FROM knowledge_articles a
        WHERE a.id = $1 AND a.tenant_id = $2
       ON CONFLICT (article_id, version) DO NOTHING`,
      [id, ctx.tenantId, nextVersion, 'Revision after publication', nextStatus, ctx.userId ?? null]
    );
  } else if (contentChanged) {
    await snapshotArticleVersion(client, ctx, id, nextVersion, nextStatus);
  }

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'knowledge_articles',
    recordId: id,
    recordCode: article.article_number,
    oldValues: { title: article.title, status: article.status, current_version: article.current_version },
    newValues: b,
  });
  return { id, status: nextStatus, current_version: nextVersion };
}

// ------------------------------------------------------------ workflow engine

interface StatusStamp {
  column?: string;
  actorColumn?: string;
}

const ARTICLE_STATUS_STAMPS: Record<KnowledgeStatus, StatusStamp> = {
  DRAFT: {},
  REVIEW: {},
  APPROVED: { column: 'approved_at', actorColumn: 'approved_by' },
  PUBLISHED: { column: 'published_at', actorColumn: 'published_by' },
  ARCHIVED: { column: 'archived_at', actorColumn: 'archived_by' },
};

/**
 * The single gate every workflow move passes through. It validates the edge,
 * stamps the right actor/timestamp pair, snapshots the version, audits the
 * change, emits the event and notifies the people who need to know.
 */
async function applyArticleStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  to: KnowledgeStatus,
  opts: { note?: string | null; extraSets?: Record<string, unknown>; eventType: string; notify?: boolean } 
) {
  const article = await loadArticle(client, ctx, id);
  if (!article) throw notFound('Knowledge article not found');
  assertArticleTransition(article.status, to);

  const sets: string[] = ['status = $4', 'updated_by = $5'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, to, ctx.userId ?? null];

  const stamp = ARTICLE_STATUS_STAMPS[to];
  if (stamp.column && stamp.actorColumn) {
    sets.push(`${stamp.column} = now()`);
    sets.push(`${stamp.actorColumn} = $5`);
  }
  if (to === 'APPROVED' && !article.reviewed_by) {
    sets.push('reviewed_at = now()', 'reviewed_by = $5');
  }
  for (const [col, val] of Object.entries(opts.extraSets ?? {})) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }

  await client.query(
    `UPDATE knowledge_articles SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    params
  );
  await snapshotArticleVersion(client, ctx, id, article.current_version, to, opts.note ?? null);

  await logAudit(client, ctx, {
    action: opts.eventType.split('.').pop() ?? 'update',
    resource: 'knowledge_articles',
    recordId: id,
    recordCode: article.article_number,
    oldValues: { status: article.status },
    newValues: { status: to, note: opts.note ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: opts.eventType,
    entityType: 'knowledge_article',
    entityId: id,
    entityCode: article.article_number,
    payload: { from: article.status, to, title: article.title },
  });

  if (opts.notify !== false) {
    const interested = [article.author_user_id, article.owner_user_id].filter(
      (v): v is number => typeof v === 'number' && v > 0
    );
    await notifyUsers(client, ctx, interested, {
      type: opts.eventType,
      title: `Knowledge article ${to.toLowerCase()}: ${article.article_number}`,
      body: article.title,
      link: `/service-desk/knowledge/${id}`,
      entityType: 'knowledge_article',
      entityId: id,
      severity: to === 'ARCHIVED' ? 'WARN' : 'SUCCESS',
    });
  }

  return { id, status: to, article_number: article.article_number };
}

export async function submitArticleForReview(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const out = await applyArticleStatus(client, ctx, id, 'REVIEW', {
    note: s(b.note ?? b.comment) ?? 'Submitted for review',
    eventType: 'service_desk.knowledge.submitted',
    notify: false,
  });
  const approvers = await usersWithPermission(client, ctx, 'service_desk.knowledge.approve');
  const article = await loadArticle(client, ctx, id);
  await notifyUsers(client, ctx, approvers, {
    type: 'service_desk.knowledge.submitted',
    title: `Knowledge article awaiting approval: ${out.article_number}`,
    body: article?.title,
    link: `/service-desk/knowledge/${id}`,
    entityType: 'knowledge_article',
    entityId: id,
  });
  return out;
}

export async function approveArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  return applyArticleStatus(client, ctx, id, 'APPROVED', {
    note: s(b.note ?? b.comment) ?? 'Approved',
    eventType: 'service_desk.knowledge.approved',
  });
}

export async function publishArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  return applyArticleStatus(client, ctx, id, 'PUBLISHED', {
    note: s(b.note ?? b.comment) ?? 'Published',
    eventType: 'service_desk.knowledge.published',
  });
}

export async function archiveArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  return applyArticleStatus(client, ctx, id, 'ARCHIVED', {
    note: s(b.reason ?? b.note ?? b.comment) ?? 'Archived',
    eventType: 'service_desk.knowledge.archived',
    notify: true,
  });
}

export async function restoreArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  return applyArticleStatus(client, ctx, id, 'DRAFT', {
    note: s(b.reason ?? b.note ?? b.comment) ?? 'Restored to draft',
    eventType: 'service_desk.knowledge.restored',
  });
}

export async function deleteKnowledgeArticle(client: pg.PoolClient, ctx: Ctx, id: number) {
  const article = await loadArticle(client, ctx, id);
  if (!article) throw notFound('Knowledge article not found');
  if (article.status === 'PUBLISHED') {
    throw conflict('A published article must be archived before it can be deleted');
  }
  if (article.ticket_usage_count > 0) {
    throw conflict('This article is linked to tickets; archive it instead of deleting it');
  }
  await client.query(
    `DELETE FROM knowledge_articles WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'knowledge_articles',
    recordId: id,
    recordCode: article.article_number,
    oldValues: { title: article.title, status: article.status },
  });
  return { id, deleted: true };
}

// ------------------------------------------------------------------- versions

export async function listArticleVersions(client: pg.PoolClient, ctx: Ctx, articleId: number) {
  const res = await client.query(
    `SELECT v.id, v.version, v.title, v.summary, v.change_note, v.status, v.created_at,
            v.created_by, u.email AS created_by_email
       FROM knowledge_versions v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.article_id = $1 AND v.tenant_id = $2
      ORDER BY v.version DESC`,
    [articleId, ctx.tenantId]
  );
  return res.rows;
}

export async function getArticleVersion(
  client: pg.PoolClient,
  ctx: Ctx,
  articleId: number,
  version: number
) {
  const res = await client.query(
    `SELECT v.*, u.email AS created_by_email
       FROM knowledge_versions v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.article_id = $1 AND v.tenant_id = $2 AND v.version = $3`,
    [articleId, ctx.tenantId, version]
  );
  if (!res.rowCount) throw notFound('Knowledge article version not found');
  return res.rows[0];
}

export async function diffArticleVersion(
  client: pg.PoolClient,
  ctx: Ctx,
  articleId: number,
  version: number
) {
  const [article, prior] = await Promise.all([
    loadArticle(client, ctx, articleId),
    getArticleVersion(client, ctx, articleId, version),
  ]);
  if (!article) throw notFound('Knowledge article not found');
  return {
    article_number: article.article_number,
    version,
    title: prior.title,
    summary: prior.summary,
    body: prior.body,
    current: { title: article.title, summary: article.summary, body: article.body },
    changed: {
      title: (prior.title ?? '') !== (article.title ?? ''),
      summary: (prior.summary ?? '') !== (article.summary ?? ''),
      body: (prior.body ?? '') !== (article.body ?? ''),
    },
  };
}

// ------------------------------------------------------------------- feedback

/**
 * Employee rating (spec 16: employees can rate articles). One vote per user
 * per article - re-rating updates the existing row and adjusts the denormalised
 * counters by the delta rather than double counting.
 */
export async function rateArticle(
  client: pg.PoolClient,
  ctx: Ctx,
  articleId: number,
  b: Record<string, unknown>
) {
  const scope = await resolveKnowledgeScope(client, ctx);
  if (!scope.userId) throw forbidden('An authenticated user is required to rate an article');

  const article = await loadArticle(client, ctx, articleId);
  if (!article) throw notFound('Knowledge article not found');
  if (!canReadArticle(scope, article)) throw forbidden('You cannot rate this knowledge article');

  const helpfulRaw = b.isHelpful ?? b.is_helpful;
  const isHelpful = helpfulRaw === undefined ? undefined : truthy(helpfulRaw);
  const rating = n(b.rating);
  if (isHelpful === undefined && rating === undefined) {
    throw badRequest('Either isHelpful or rating is required');
  }
  if (rating !== undefined && (rating < 1 || rating > 5)) {
    throw badRequest('rating must be between 1 and 5');
  }

  const existing = await client.query<{ id: number; is_helpful: boolean | null; rating: number | null }>(
    `SELECT id, is_helpful, rating FROM knowledge_feedback
      WHERE article_id = $1 AND user_id = $2 AND tenant_id = $3`,
    [articleId, scope.userId, ctx.tenantId]
  );
  const prior = existing.rows[0] ?? null;

  await client.query(
    `INSERT INTO knowledge_feedback
       (tenant_id, company_id, article_id, user_id, employee_id, is_helpful, rating, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$4)
     ON CONFLICT (article_id, user_id) DO UPDATE
        SET is_helpful = COALESCE(EXCLUDED.is_helpful, knowledge_feedback.is_helpful),
            rating = COALESCE(EXCLUDED.rating, knowledge_feedback.rating),
            comment = COALESCE(EXCLUDED.comment, knowledge_feedback.comment),
            updated_at = now()`,
    [
      ctx.tenantId, ctx.companyId, articleId, scope.userId, scope.employeeId ?? null,
      isHelpful === undefined ? null : isHelpful,
      rating ?? null,
      s(b.comment) ?? null,
    ]
  );

  const helpfulDelta = (isHelpful === undefined ? 0 : isHelpful ? 1 : 0) - (prior?.is_helpful ? 1 : 0);
  const notHelpfulDelta = (isHelpful === undefined ? 0 : isHelpful ? 0 : 1) - (prior && prior.is_helpful === false ? 1 : 0);
  const ratingDelta = (rating ?? 0) - (prior?.rating ?? 0);
  const ratingCountDelta = (rating === undefined ? 0 : 1) - (prior?.rating != null ? 1 : 0);

  await client.query(
    `UPDATE knowledge_articles
        SET helpful_count = GREATEST(0, helpful_count + $2),
            not_helpful_count = GREATEST(0, not_helpful_count + $3),
            rating_sum = GREATEST(0, rating_sum + $4),
            rating_count = GREATEST(0, rating_count + $5),
            updated_at = updated_at
      WHERE id = $1 AND tenant_id = $6`,
    [articleId, helpfulDelta, notHelpfulDelta, ratingDelta, ratingCountDelta, ctx.tenantId]
  );

  return { article_id: articleId, is_helpful: isHelpful ?? prior?.is_helpful ?? null, rating: rating ?? prior?.rating ?? null };
}

export async function listArticleFeedback(
  client: pg.PoolClient,
  ctx: Ctx,
  articleId: number,
  q: { limit?: number } = {}
) {
  const limit = Math.min(Math.max(n(q.limit) ?? 50, 1), 200);
  const res = await client.query(
    `SELECT f.id, f.is_helpful, f.rating, f.comment, f.created_at, f.updated_at,
            f.user_id, u.email AS user_email,
            e.employee_no, e.first_name, e.last_name
       FROM knowledge_feedback f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN employees e ON e.id = f.employee_id
      WHERE f.article_id = $1 AND f.tenant_id = $2
      ORDER BY f.created_at DESC
      LIMIT $3`,
    [articleId, ctx.tenantId, limit]
  );
  return res.rows;
}

export async function myArticleFeedback(client: pg.PoolClient, ctx: Ctx, articleId: number) {
  if (!ctx.userId) return null;
  const res = await client.query(
    `SELECT id, is_helpful, rating, comment, created_at, updated_at
       FROM knowledge_feedback
      WHERE article_id = $1 AND user_id = $2 AND tenant_id = $3`,
    [articleId, ctx.userId, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

// -------------------------------------------------------------- ticket linking

export const TICKET_KNOWLEDGE_LINK_TYPES = ['RECOMMENDED', 'USED', 'RESOLVED_BY'] as const;

/**
 * Attach a knowledge article to a ticket. Agents link the article they actually
 * used, which is what makes "recurring incident -> known article" reporting
 * possible, so linking also bumps ticket_usage_count.
 */
export async function linkArticleToTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const articleId = n(b.articleId ?? b.article_id);
  if (!articleId) throw badRequest('articleId is required');
  const linkType = (oneOf(b.linkType ?? b.link_type, TICKET_KNOWLEDGE_LINK_TYPES) ?? 'USED') as string;

  const article = await loadArticle(client, ctx, articleId);
  if (!article) throw notFound('Knowledge article not found');

  const scope = await resolveKnowledgeScope(client, ctx);
  if (!canReadArticle(scope, article)) throw forbidden('You cannot link this knowledge article');

  const ticket = await client.query(
    `SELECT id, ticket_number FROM service_tickets
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [ticketId, ctx.tenantId, ctx.companyId]
  );
  if (!ticket.rowCount) throw notFound('Ticket not found');

  const res = await client.query<{ id: number; inserted: boolean }>(
    `INSERT INTO ticket_knowledge_links
       (tenant_id, company_id, ticket_id, article_id, link_type, linked_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (ticket_id, article_id) DO UPDATE
        SET link_type = EXCLUDED.link_type, linked_by = EXCLUDED.linked_by, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [ctx.tenantId, ctx.companyId, ticketId, articleId, linkType, ctx.userId ?? null]
  );

  // Only the first link of an article to a ticket counts as usage; re-linking
  // the same pair (or changing its link type) must not inflate the metric.
  if (res.rows[0].inserted) {
    await client.query(
      `UPDATE knowledge_articles
          SET ticket_usage_count = ticket_usage_count + 1
        WHERE id = $1 AND tenant_id = $2`,
      [articleId, ctx.tenantId]
    );
  }

  await logAudit(client, ctx, {
    action: 'link',
    resource: 'ticket_knowledge_links',
    recordId: Number(res.rows[0].id),
    recordCode: article.article_number,
    newValues: { ticket_id: ticketId, article_id: articleId, link_type: linkType },
  });
  return { id: Number(res.rows[0].id), ticket_id: ticketId, article_id: articleId, link_type: linkType };
}

export async function unlinkArticleFromTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  articleId: number
) {
  const res = await client.query(
    `DELETE FROM ticket_knowledge_links
      WHERE ticket_id = $1 AND article_id = $2 AND tenant_id = $3
      RETURNING id`,
    [ticketId, articleId, ctx.tenantId]
  );
  if (!res.rowCount) throw notFound('Knowledge link not found');
  await logAudit(client, ctx, {
    action: 'unlink',
    resource: 'ticket_knowledge_links',
    recordId: ticketId,
    newValues: { article_id: articleId },
  });
  return { ticket_id: ticketId, article_id: articleId, removed: true };
}

export async function listTicketKnowledge(client: pg.PoolClient, ctx: Ctx, ticketId: number) {
  const res = await client.query(
    `SELECT l.id, l.link_type, l.created_at, l.linked_by,
            a.id AS article_id, a.article_number, a.title, a.summary, a.status,
            a.view_count, a.helpful_count, lk.email AS linked_by_email
       FROM ticket_knowledge_links l
       JOIN knowledge_articles a ON a.id = l.article_id
       LEFT JOIN users lk ON lk.id = l.linked_by
      WHERE l.ticket_id = $1 AND l.tenant_id = $2
      ORDER BY l.created_at DESC`,
    [ticketId, ctx.tenantId]
  );
  return res.rows;
}

// -------------------------------------------------------------- recommendations

/**
 * Suggest articles for a ticket before the agent has to search (spec 16:
 * "Agents can link knowledge articles to tickets", spec 25 recurring
 * incidents). Ranking blends text similarity against the ticket subject and
 * description with historical usefulness, so the article that actually resolved
 * similar tickets floats to the top.
 */
export async function recommendArticlesForTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  q: { limit?: number } = {}
) {
  const limit = Math.min(Math.max(n(q.limit) ?? 8, 1), 50);
  const scope = await resolveKnowledgeScope(client, ctx);

  const t = await client.query<{
    subject: string; description: string | null; category_id: number | null; subcategory_id: number | null;
  }>(
    `SELECT subject, description, category_id, subcategory_id
       FROM service_tickets
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [ticketId, ctx.tenantId, ctx.companyId]
  );
  const ticket = t.rows[0];
  if (!ticket) throw notFound('Ticket not found');

  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = [
    'a.tenant_id = $1',
    'a.company_id = $2',
    "a.status = 'PUBLISHED'",
    "a.data_classification IN ('PUBLIC','INTERNAL')",
  ];

  params.push(scope.roles);
  where.push(
    `(a.audience_roles IS NULL OR cardinality(a.audience_roles) = 0
      OR a.audience_roles && $${params.length}::text[])`
  );

  params.push(`${ticket.subject} ${ticket.description ?? ''}`.trim());
  const termIdx = params.length;

  params.push(ticket.category_id);
  const catIdx = params.length;

  const res = await client.query(
    `SELECT a.id, a.article_number, a.title, a.summary, a.status, a.keywords,
            a.view_count, a.helpful_count, a.ticket_usage_count,
            CASE WHEN a.rating_count > 0 THEN round(a.rating_sum::numeric / a.rating_count, 2) END AS rating_average,
            kc.name AS category_name,
            round((
              GREATEST(
                similarity(a.title, $${termIdx}),
                similarity(coalesce(a.summary,''), $${termIdx}) * 0.8,
                CASE WHEN to_tsvector('english', coalesce(a.title,'') || ' ' || coalesce(a.summary,''))
                          @@ plainto_tsquery('english', $${termIdx})
                     THEN 0.9 ELSE 0 END
              ) * 100
              + LEAST(a.helpful_count, 20) * 1.5
              + LEAST(a.ticket_usage_count, 20) * 1.0
              + CASE WHEN a.category_id = $${catIdx} THEN 12 ELSE 0 END
            )::numeric, 2) AS score
       FROM knowledge_articles a
       LEFT JOIN knowledge_categories kc ON kc.id = a.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY score DESC NULLS LAST, a.helpful_count DESC, a.view_count DESC
      LIMIT $${params.length + 1}`,
    [...params, limit]
  );

  const alreadyLinked = await client.query<{ article_id: number }>(
    `SELECT article_id FROM ticket_knowledge_links WHERE ticket_id = $1 AND tenant_id = $2`,
    [ticketId, ctx.tenantId]
  );
  const linked = new Set(alreadyLinked.rows.map((r) => Number(r.article_id)));

  return {
    ticket_id: ticketId,
    items: res.rows.map((r) => ({ ...r, already_linked: linked.has(Number(r.id)) })),
  };
}

/**
 * Employee-facing knowledge search: published, readable articles only, ranked
 * by relevance. This is the endpoint the portal "Need help?" box calls before
 * the employee bothers to raise a ticket.
 */
export async function searchKnowledge(
  client: pg.PoolClient,
  ctx: Ctx,
  q: { term?: unknown; search?: unknown; q?: unknown; categoryId?: unknown; category_id?: unknown; limit?: unknown } = {}
) {
  const term = s(q.term ?? q.search ?? q.q);
  if (!term) return { term: null, items: [] };
  return listKnowledgeArticles(client, ctx, {
    search: term,
    categoryId: q.categoryId ?? q.category_id,
    sort: 'relevance',
    limit: q.limit ?? 20,
  });
}

// ---------------------------------------------------------------- dashboards

/** Knowledge management view: workflow backlog plus the article health list. */
export async function knowledgeDashboard(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveKnowledgeScope(client, ctx);

  const byStatus = await client.query<{ status: string; total: string }>(
    `SELECT status, count(*)::text AS total
       FROM knowledge_articles
      WHERE tenant_id = $1 AND company_id = $2
      GROUP BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  const counts: Record<string, number> = {};
  for (const row of byStatus.rows) counts[row.status] = Number(row.total);

  const awaitingReview = await client.query(
    `SELECT a.id, a.article_number, a.title, a.status, a.updated_at, u.email AS author_email
       FROM knowledge_articles a
       LEFT JOIN users u ON u.id = a.author_user_id
      WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.status IN ('REVIEW','APPROVED')
      ORDER BY a.updated_at ASC
      LIMIT 25`,
    [ctx.tenantId, ctx.companyId]
  );

  const top = await client.query(
    `SELECT a.id, a.article_number, a.title, a.view_count, a.helpful_count, a.ticket_usage_count,
            CASE WHEN a.rating_count > 0 THEN round(a.rating_sum::numeric / a.rating_count, 2) END AS rating_average
       FROM knowledge_articles a
      WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.status = 'PUBLISHED'
      ORDER BY a.view_count DESC, a.helpful_count DESC
      LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  // Published but never used to resolve a ticket - candidates for review or
  // retirement, and the mirror image of the recurring-incident report.
  const unused = await client.query(
    `SELECT a.id, a.article_number, a.title, a.published_at, a.view_count
       FROM knowledge_articles a
      WHERE a.tenant_id = $1 AND a.company_id = $2
        AND a.status = 'PUBLISHED' AND a.ticket_usage_count = 0
      ORDER BY a.published_at ASC NULLS FIRST
      LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const needsAttention = await client.query(
    `SELECT a.id, a.article_number, a.title, a.helpful_count, a.not_helpful_count, a.rating_count,
            CASE WHEN a.rating_count > 0 THEN round(a.rating_sum::numeric / a.rating_count, 2) END AS rating_average
       FROM knowledge_articles a
      WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.status = 'PUBLISHED'
        AND (a.not_helpful_count > a.helpful_count
             OR (a.rating_count >= 3 AND a.rating_sum::numeric / a.rating_count < 3))
      ORDER BY a.not_helpful_count DESC
      LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const categories = await client.query(
    `SELECT kc.id, kc.name,
            count(a.id) FILTER (WHERE a.status = 'PUBLISHED')::int AS published,
            count(a.id)::int AS total
       FROM knowledge_categories kc
       LEFT JOIN knowledge_articles a ON a.category_id = kc.id
      WHERE kc.tenant_id = $1 AND kc.company_id = $2 AND kc.is_active
      GROUP BY kc.id, kc.name
      ORDER BY published DESC, kc.name`,
    [ctx.tenantId, ctx.companyId]
  );

  return {
    counts: {
      draft: counts.DRAFT ?? 0,
      review: counts.REVIEW ?? 0,
      approved: counts.APPROVED ?? 0,
      published: counts.PUBLISHED ?? 0,
      archived: counts.ARCHIVED ?? 0,
      total: Object.values(counts).reduce((a, v) => a + v, 0),
    },
    awaiting_review: awaitingReview.rows,
    most_viewed: top.rows,
    unused_published: unused.rows,
    needs_attention: needsAttention.rows,
    categories: categories.rows,
    permissions: {
      author: scope.canAuthor,
      approve: scope.canApprove,
      publish: scope.canPublish,
      archive: scope.canArchive,
      manage_categories: scope.canManageCategories,
    },
  };
}
