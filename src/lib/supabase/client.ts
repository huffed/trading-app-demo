import { createBrowserClient } from "@supabase/ssr";

let instance: ReturnType<typeof init> | null = null;

function init() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export function createClient() {
  if (!instance) { instance = init(); }
  return instance;
}
