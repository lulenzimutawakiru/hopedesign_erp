/**
 * Shared setup for the web unit suite.
 *
 * `globals: false` in `vitest.config.ts` means Testing Library cannot register
 * its own automatic cleanup hook, so this file does it explicitly. Without it
 * every test would share one document and queries would match the previous
 * test's markup.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React 18 only batches state updates inside `act` when this flag is set, and
// it warns loudly on stderr when a test renders without it.
// `@types/react` does not declare this flag on `globalThis`, so it is asserted
// through a locally typed view rather than widening the global scope.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
