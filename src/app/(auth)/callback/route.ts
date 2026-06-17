import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Allowed post-auth redirect paths — prevents open-redirect via `next` param. */
const ALLOWED_REDIRECTS = [
  "/dashboard",
  "/trades",
  "/journal",
  "/algorithms",
  "/chart",
  "/backtest",
  "/performance",
  "/reports",
  "/analytics",
  "/settings",
];

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/dashboard";

  // Validate redirect target against whitelist to prevent open-redirect attacks
  const next = ALLOWED_REDIRECTS.some((p) => rawNext.startsWith(p)) ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
