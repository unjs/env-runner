/**
 * Vercel OIDC token utilities. `VERCEL_OIDC_TOKEN` is a short-lived JWT (~12h locally) written to `.env.local` by `vercel env pull` or to `.vercel/.env.development.local` by `vercel pull`. Surface expiry at dev startup so OIDC-federated SDKs (`@vercel/queue`, AWS, GCP, Azure) don't fail with opaque 401s mid-request.
 */

export type VercelOidcStatus = "missing" | "valid" | "expired" | "invalid";

export interface VercelOidcCheckResult {
  status: VercelOidcStatus;
  /** Decoded `exp` claim, when the token could be parsed. */
  expiresAt?: Date;
}

/**
 * Inspect a Vercel OIDC token (defaults to `process.env.VERCEL_OIDC_TOKEN`). Decodes the JWT `exp` claim
 */
export function checkVercelOidcToken(
  token: string | undefined = process.env.VERCEL_OIDC_TOKEN,
): VercelOidcCheckResult {
  if (!token) return { status: "missing" };

  const parts = token.split(".");
  if (parts.length !== 3) return { status: "invalid" };

  let payload: { exp?: number };
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return { status: "invalid" };
  }

  if (typeof payload.exp !== "number") return { status: "invalid" };

  const expiresAt = new Date(payload.exp * 1000);
  if (expiresAt.getTime() <= Date.now()) {
    return { status: "expired", expiresAt };
  }
  return { status: "valid", expiresAt };
}

let _warned = false;

/**
 * Log a one-time warning if the OIDC token is missing, expired, or malformed.
 */
export function warnIfVercelOidcTokenInvalid(token?: string | undefined): VercelOidcCheckResult {
  const result = checkVercelOidcToken(token);
  if (_warned) return result;

  if (result.status === "missing") {
    _warned = true;
    console.warn(
      "[env-runner:vercel] Run `vercel env pull` to set `VERCEL_OIDC_TOKEN`.",
    );
  } else if (result.status === "expired") {
    _warned = true;
    console.warn(
      `[env-runner:vercel] \`VERCEL_OIDC_TOKEN\` expired at ${result.expiresAt!.toISOString()}. Run \`vercel env pull\` to refresh it.`,
    );
  } else if (result.status === "invalid") {
    _warned = true;
    console.warn(
      "[env-runner:vercel] `VERCEL_OIDC_TOKEN` is invalid. Run `vercel env pull` to refresh it.",
    );
  }

  return result;
}
