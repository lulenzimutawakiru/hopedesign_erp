// Bootstrap password policy for seeded accounts (SEC-004).
//
// Seeded accounts ship with `must_change_password = true` and the login flow
// enforces a change server-side, so the bootstrap credential is always
// throwaway. What must never happen is *production* restoring a publicly
// documented, shared password for privileged accounts via `SEED_ON_BOOT`.
const crypto = require("crypto");

/** Documented development/test default. Used only outside production. */
const DEV_DEFAULT = "ChangeMe!2026";

/**
 * Resolve the password used for all seeded bootstrap accounts.
 *
 * - `SEED_ADMIN_PASSWORD`, when set, is used verbatim (the operator supplies a
 *   strong, unique secret before bootstrapping production).
 * - In production the shared dev default is refused: seeding with it would
 *   restore known credentials for `super_administrator` and every demo role.
 * - Outside production the documented default is kept so local setup and the
 *   DB-backed test suite (which logs in with this password) keep working.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveSeedPassword(env = process.env) {
  const explicit = String(env.SEED_ADMIN_PASSWORD || "").trim();
  if (explicit) return explicit;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed with the default credentials in production. " +
        "Set SEED_ADMIN_PASSWORD to a strong, unique bootstrap password " +
        "(SEED_ON_BOOT is intended for an empty database only)."
    );
  }
  return DEV_DEFAULT;
}

/**
 * Cryptographically random bootstrap password (URL-safe, no ambiguous chars).
 * Provided for deploy tooling that wants to generate a secret *before* seeding
 * rather than hand-writing one; the seed itself never prints it.
 *
 * @param {number} [length]
 * @returns {string}
 */
function randomSeedPassword(length = 24) {
  const bytes = Math.ceil((length * 3) / 4);
  return crypto.randomBytes(bytes).toString("base64url").slice(0, length);
}

module.exports = { resolveSeedPassword, randomSeedPassword, DEV_DEFAULT };
