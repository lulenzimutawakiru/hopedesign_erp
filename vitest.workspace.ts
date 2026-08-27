// Root-level `npx vitest` (outside apps/api) must run the API suite with its
// own config: single project, sequential test files (fileParallelism: false).
// Without this, root invocations fall back to parallel execution against the
// shared PostgreSQL database, which cross-contaminates payroll/HR test data.
export default ['apps/api/vitest.config.ts'];
