// Detects when the server is serving a newer build than the one this tab loaded.
//
// The ERP is a hash-routed SPA: in-app navigation never re-requests index.html,
// so a tab opened before a deploy keeps running the old bundle indefinitely and
// silently misses newly shipped screens. This compares the build id baked into
// index.html against /build.json and offers a reload when they diverge.
//
// Deliberately framework-free plain DOM: it must still work when the React tree
// is stale, mid-upgrade, or failed to mount.

const BANNER_ID = 'hdg-build-banner';
const POLL_MS = 5 * 60 * 1000;

function loadedBuildId(): string {
  const meta = document.querySelector('meta[name="build-id"]');
  return meta ? String(meta.getAttribute('content') || '') : '';
}

function showBanner(loaded: string, available: string): void {
  if (document.getElementById(BANNER_ID)) return;

  const bar = document.createElement('div');
  bar.id = BANNER_ID;
  bar.className = 'update-banner';
  bar.setAttribute('role', 'status');
  bar.title = 'Loaded build ' + loaded + ', server build ' + available;

  const text = document.createElement('span');
  text.className = 'update-banner-text';
  text.textContent = 'A newer version of Natex Cloud is available.';

  const hint = document.createElement('span');
  hint.className = 'update-banner-hint';
  hint.textContent = 'Reload to pick up the latest screens.';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'update-banner-btn';
  button.textContent = 'Reload now';
  button.addEventListener('click', () => window.location.reload());

  bar.append(text, hint, button);
  document.body.appendChild(bar);
}

async function checkForNewBuild(): Promise<void> {
  const loaded = loadedBuildId();
  if (!loaded) return;
  try {
    const res = await fetch('/build.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { buildId?: string };
    if (body && body.buildId && body.buildId !== loaded) {
      showBanner(loaded, body.buildId);
    }
  } catch {
    // Offline, or /build.json is not deployed yet - never disrupt the session.
  }
}

export function startBuildWatch(): void {
  // No immediate check on load: a freshly served index.html always carries the
  // current build id, so the first /build.json round-trip would only ever match.
  // It is also exactly the moment /api/auth/me and the first route chunks are
  // competing for the connection, so we skip it and rely on the periodic poll,
  // focus and visibility triggers to catch a long-lived tab that predates a
  // deploy.
  window.setInterval(() => void checkForNewBuild(), POLL_MS);
  window.addEventListener('focus', () => void checkForNewBuild());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkForNewBuild();
  });
}
