import { NextFunction, Request, Response } from 'express';
import { query } from '../db.js';
import { forbidden, unauthorized } from '../utils.js';

/** Pure permission check (RBAC wildcards included). Deny by default. */
export function can(user: { permissions: string[] } | string[] | undefined, permission: string): boolean {
  if (!user) return false;
  const perms = Array.isArray(user) ? user : user.permissions;
  if (perms.includes('system.admin.all') || perms.includes('*')) return true;
  const [m, r] = permission.split('.');
  return (
    perms.includes(permission) ||
    perms.includes(`${m}.${r}.*`) ||
    perms.includes(`${m}.*`)
  );
}

/**
 * RBAC + ABAC + SoD + scope authorization.
 * Permission format: module.resource.action (e.g. sales.orders.create)
 */
export function requirePermission(permission: string | string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = req.auth;
      if (!user) return next(unauthorized());

      // RBAC ? deny by default (any-of when passed an array)
      const perms = Array.isArray(permission) ? permission : [permission];
      const matched = perms.find((p) => can(user, p));
      if (!matched) {
        return next(forbidden(`Missing permission: ${perms.join(' or ')}`));
      }

      // SoD ? hard conflicts block the action before it is attempted
      const sod = await query(
        `SELECT code, name, enforcement FROM sod_rules
         WHERE tenant_id = $1 AND is_active = true
           AND conflicting_permission = $2
           AND EXISTS (
             SELECT 1 FROM role_permissions rp
             JOIN user_roles ur ON ur.role_id = rp.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE ur.user_id = $3 AND p.code = primary_permission
           )`,
        [user.tenant_id, matched, user.id],
        req.ctx
      );
      if (sod.rows.length > 0 && sod.rows[0].enforcement === 'hard') {
        return next(forbidden(`Segregation of duties conflict: ${sod.rows[0].name}`));
      }

      // ABAC ? evaluate policies (priority ascending, first match wins).
      // Default behaviour is DENY; policies add explicit ALLOW or DENY rules.
      const policies = await query(
        `SELECT code, effect, subject_attributes, resource_attributes, environment_attributes
         FROM policies WHERE tenant_id = $1 AND is_active = true
         ORDER BY priority, id`,
        [user.tenant_id],
        req.ctx
      );
      const parts = matched.split('.');
      const subjectSource: Record<string, unknown> = {
        ...(user.attributes ?? {}),
        user_id: user.id,
        id: user.id,
        company_id: user.company_id,
        branch_id: user.branch_id,
        department_id: user.department_id,
        job_title: user.job_title,
        email: user.email,
        status: user.status,
        mfa_enabled: user.mfa_enabled,
      };
      const resourceSource: Record<string, unknown> = {
        module: parts[0],
        resource: parts[1],
        action: parts[2],
        permission: matched,
        ...(req.ctx.resourceAttributes ?? {}),
      };
      const now = new Date();
      const environmentSource: Record<string, unknown> = {
        time_of_day: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        ip: req.ctx.ip ?? null,
        mfa_verified: !!user.mfa_enabled,
      };
      const sources = {
        subject: subjectSource,
        resource: resourceSource,
        environment: environmentSource,
      };
      const refValue = (ref: string): unknown => {
        const dot = ref.indexOf('.');
        if (dot > 0) {
          const prefix = ref.slice(0, dot);
          const key = ref.slice(dot + 1);
          if (prefix === 'subject' || prefix === 'resource' || prefix === 'environment') {
            return sources[prefix][key];
          }
        }
        return sources.resource[ref] ?? sources.subject[ref] ?? sources.environment[ref];
      };
      const condMatch = (cond: unknown, val: unknown): boolean => {
        if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
          const ops = cond as Record<string, unknown>;
          for (const [op, operand] of Object.entries(ops)) {
            switch (op) {
              case '$in':
                return Array.isArray(operand) ? operand.includes(val) : false;
              case '$outside':
              case '$not_in':
                return Array.isArray(operand) ? !operand.includes(val) : false;
              case '$eq':
                return val === operand;
              case '$ne':
                return val !== operand;
              case '$gt':
                return typeof val === 'number' && typeof operand === 'number' && val > operand;
              case '$gte':
                return typeof val === 'number' && typeof operand === 'number' && val >= operand;
              case '$lt':
                return typeof val === 'number' && typeof operand === 'number' && val < operand;
              case '$lte':
                return typeof val === 'number' && typeof operand === 'number' && val <= operand;
              case '$between':
                return Array.isArray(operand) && operand.length === 2 && typeof val === 'number'
                  ? val >= Number(operand[0]) && val <= Number(operand[1])
                  : false;
              case '$exists':
                return operand === true ? val !== undefined && val !== null : val === undefined || val === null;
              case '$missing':
                return operand === true ? val === undefined || val === null : val !== undefined && val !== null;
              case '$ref':
                return val === refValue(String(operand));
              default:
                return false;
            }
          }
          return true; // empty operator object imposes no constraint
        }
        if (Array.isArray(cond)) return cond.includes(val); // legacy membership
        return cond === val;
      };
      const attrMatches = (attr: Record<string, unknown>, source: Record<string, unknown>): boolean => {
        for (const [k, cond] of Object.entries(attr)) {
          if (!condMatch(cond, source[k])) return false;
        }
        return true;
      };
      for (const row of policies.rows) {
        const subj = (row.subject_attributes ?? {}) as Record<string, unknown>;
        const resA = (row.resource_attributes ?? {}) as Record<string, unknown>;
        const env = (row.environment_attributes ?? {}) as Record<string, unknown>;
        const isUnconditional =
          Object.keys(subj).length === 0 && Object.keys(resA).length === 0 && Object.keys(env).length === 0;
        // An unconditional DENY would lock out the entire tenant, including
        // administrators. Treat it as a no-op so a misconfigured rule can never
        // brick the system.
        if (isUnconditional && row.effect === 'deny') continue;
        if (
          attrMatches(subj, subjectSource) &&
          attrMatches(resA, resourceSource) &&
          attrMatches(env, environmentSource)
        ) {
          if (row.effect === 'deny') return next(forbidden(`Policy ${row.code} denies this action`));
          break; // first matching allow policy wins
        }
      }

      // Scope ? company-scoped roles cannot act outside their company
      const scopeOk = await query(
        `SELECT 1 FROM user_roles ur
         WHERE ur.user_id = $1 AND ur.company_id IS NOT NULL AND ur.company_id <> $2
         LIMIT 1`,
        [user.id, req.ctx.companyId ?? user.company_id],
        req.ctx
      );
      if (scopeOk.rows.length > 0) {
        return next(forbidden('Role scope does not cover this company'));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Restrict list queries to the user's company/branch scope. */
export function scopeFilter(tableAlias = 't') {
  return (req: Request) => {
    const user = req.auth;
    if (!user) return '1=0';
    const conds: string[] = [];
    if (user.company_id) conds.push(`${tableAlias}.company_id = ${user.company_id}`);
    if (user.branch_id) conds.push(`${tableAlias}.branch_id = ${user.branch_id}`);
    return conds.length ? conds.join(' AND ') : '1=1';
  };
}
