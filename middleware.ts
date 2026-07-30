import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/trades/:path*",
    "/journal/:path*",
    "/algorithms/:path*",
    "/chart/:path*",
    "/backtest/:path*",
    "/performance/:path*",
    "/portfolios/:path*",
    "/reports/:path*",
    "/analytics/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
    "/login",
    "/signup",
    "/callback",
    "/api/:path*",
  ],
};
