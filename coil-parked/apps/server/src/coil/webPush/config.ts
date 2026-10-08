/**
 * Web Push configuration.
 *
 * Read from env with safe defaults so the feature works with zero setup (the VAPID keypair
 * is generated + persisted on first boot; see vapid.ts). `resolveConfig` is pure (env passed
 * in) for testability, mirroring coil/autoResume/config.ts.
 *
 * @module coil/webPush/config
 */

export interface WebPushConfig {
  readonly enabled: boolean;
  /** VAPID `sub` claim — a mailto: or https: contact URL for the push service. */
  readonly subject: string;
  /** Explicit VAPID keys via env; when both are set they win over the secret store. */
  readonly publicKeyOverride: string | null;
  readonly privateKeyOverride: string | null;
}

const DEFAULT_SUBJECT = "mailto:web-push@t3code.local";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  return fallback;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): WebPushConfig {
  return {
    enabled: parseBool(env.T3X_WEB_PUSH_ENABLED, true),
    subject: nonEmpty(env.T3X_VAPID_SUBJECT) ?? DEFAULT_SUBJECT,
    publicKeyOverride: nonEmpty(env.T3X_VAPID_PUBLIC_KEY),
    privateKeyOverride: nonEmpty(env.T3X_VAPID_PRIVATE_KEY),
  };
}
