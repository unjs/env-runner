/**
 * Vercel OIDC token utilities. `VERCEL_OIDC_TOKEN` is a short-lived JWT (~12h locally) written to `.env.local` by `vercel env pull` or to `.vercel/.env.development.local` by `vercel pull`.
 */

export type VercelOidcStatus = "missing" | "valid" | "expired" | "invalid";

export interface VercelOidcCheckResult {
  status: VercelOidcStatus;
  /** Decoded `exp` claim, when the token could be parsed. */
  expiresAt?: Date;
}

let _warned = false;

/**
 * Log a one-time warning if the OIDC token is missing, expired, or malformed.
 */
export function warnIfVercelOidcTokenInvalid(token?: string | undefined): VercelOidcCheckResult {
  const result = _checkVercelOidcToken(token);
  if (_warned) return result;

  if (result.status === "missing") {
    _warned = true;
    console.warn(
      `\x1B[90m[env-runner]\x1B[39m \x1B[33mVERCEL_OIDC_TOKEN\x1B[39m is not set. Run \x1B[36mvercel env pull\x1B[39m to pull the latest environment variables.`,
    );
  } else if (result.status === "expired") {
    _warned = true;
    console.warn(
      `\x1B[90m[env-runner]\x1B[39m \x1B[33mVERCEL_OIDC_TOKEN\x1B[39m expired at ${result.expiresAt!.toISOString()}. Run \x1B[36mvercel env pull\x1B[39m to pull a fresh OIDC token.`,
    );
  } else if (result.status === "invalid") {
    _warned = true;
    console.warn(
      `\x1B[90m[env-runner]\x1B[39m \x1B[33mVERCEL_OIDC_TOKEN\x1B[39m is malformed (not a valid JWT). Run \x1B[36mvercel env pull\x1B[39m to pull a valid OIDC token.`,
    );
  }

  return result;
}

/**
 * Inspect a Vercel OIDC token (defaults to `process.env.VERCEL_OIDC_TOKEN`). Decodes the JWT `exp` claim.
 */
function _checkVercelOidcToken(
  token: string | undefined = process.env.VERCEL_OIDC_TOKEN,
): VercelOidcCheckResult {
  if (!token) return { status: "missing" };

  const parts = token.split(".");
  if (parts.length !== 3) return { status: "invalid" };

  let payload: unknown;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return { status: "invalid" };
  }

  if (!payload || typeof payload !== "object") {
    return { status: "invalid" };
  }
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { status: "invalid" };
  }

  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= Date.now()) {
    return { status: "expired", expiresAt };
  }
  return { status: "valid", expiresAt };
}
