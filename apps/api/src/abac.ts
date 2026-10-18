/**
 * Pure ABAC condition evaluation.
 *
 * Kept free of any database import so the evaluator can be unit-tested without
 * a live PostgreSQL. `condMatch` decides whether a single attribute value
 * satisfies a condition; `attrMatches` decides whether a whole attribute map
 * satisfies a source map.
 *
 * SEC-002: an object condition is a *conjunction* — every operator must hold.
 * The previous implementation returned on the first operator it saw, so a
 * compound condition such as `{ "$gte": 100, "$lte": 500 }` only enforced the
 * first bound. That is fixed here.
 */

export type RefResolver = (ref: string) => unknown;

export function condMatch(cond: unknown, val: unknown, refValue: RefResolver): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const ops = cond as Record<string, unknown>;
    const keys = Object.keys(ops);
    if (keys.length === 0) return true; // empty operator object imposes no constraint
    for (const op of keys) {
      const operand = ops[op];
      let ok = false;
      switch (op) {
        case '$in':
          ok = Array.isArray(operand) ? operand.includes(val) : false;
          break;
        case '$outside':
        case '$not_in':
          ok = Array.isArray(operand) ? !operand.includes(val) : false;
          break;
        case '$eq':
          ok = val === operand;
          break;
        case '$ne':
          ok = val !== operand;
          break;
        case '$gt':
          ok = typeof val === 'number' && typeof operand === 'number' && val > operand;
          break;
        case '$gte':
          ok = typeof val === 'number' && typeof operand === 'number' && val >= operand;
          break;
        case '$lt':
          ok = typeof val === 'number' && typeof operand === 'number' && val < operand;
          break;
        case '$lte':
          ok = typeof val === 'number' && typeof operand === 'number' && val <= operand;
          break;
        case '$between':
          ok =
            Array.isArray(operand) && operand.length === 2 && typeof val === 'number'
              ? val >= Number(operand[0]) && val <= Number(operand[1])
              : false;
          break;
        case '$exists':
          ok = operand === true ? val !== undefined && val !== null : val === undefined || val === null;
          break;
        case '$missing':
          ok = operand === true ? val === undefined || val === null : val !== undefined && val !== null;
          break;
        case '$ref':
          ok = val === refValue(String(operand));
          break;
        default:
          ok = false;
      }
      if (!ok) return false;
    }
    return true;
  }
  if (Array.isArray(cond)) return cond.includes(val); // legacy membership
  return cond === val;
}

export function attrMatches(
  attr: Record<string, unknown>,
  source: Record<string, unknown>,
  refValue: RefResolver
): boolean {
  for (const [k, cond] of Object.entries(attr)) {
    if (!condMatch(cond, source[k], refValue)) return false;
  }
  return true;
}
