/** A documented access restriction is not evidence of account absence. */
export class RestrictedProfileError extends Error {
  constructor() {
    super("Instagram reference profile is restricted. Skipped without retrying; other platforms were not searched. Account availability remains unknown.");
    this.name = "RestrictedProfileError";
  }
}

export function isRestrictedInstagramProfile(status: number, payload: unknown): boolean {
  if (![200, 403, 404].includes(status) || !payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;
  // Match explicit resource-state fields, never HTTP status alone. Supports the
  // provider's older success:false and current success:true response contracts.
  if (body.errorStatus !== 403 && body.errorStatus !== 404) return false;
  const message = typeof body.message === "string" ? body.message.trim().toLowerCase() : "";
  return (body.error === "forbidden" && body.errorStatus === 403
    && (body.age_restricted === true || message === "profile is age restricted"))
    || (body.error === "not_found" && body.errorStatus === 404 && message === "profile is restricted");
}
