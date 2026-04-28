import { NextResponse } from "next/server";

/**
 * Bearer-token gate for admin/cron API routes. Reads CRON_SECRET from env
 * and matches against the `Authorization: Bearer <token>` header.
 *
 * Returns a Response when auth fails (caller should `return` it). Returns
 * null when auth passes (caller proceeds). Misconfigured env (no secret
 * set) is treated as a 500 — fail-closed so a missing secret in prod
 * doesn't open a backdoor.
 */
export function verifyAdminAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured", code: "server_misconfigured" },
      { status: 500 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 }
    );
  }
  return null;
}
