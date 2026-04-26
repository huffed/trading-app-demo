import { redirect } from "next/navigation";
import { ChatProvider } from "@/components/chat/chat-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { TourProvider } from "@/components/onboarding/tour-provider";
import { WizardProvider } from "@/components/onboarding/wizard-provider";
import { CurrencyInitializer } from "@/components/shared/currency-initializer";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_completed, trading_profile, default_currency")
    .eq("id", user.id)
    .single();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
      <CurrencyInitializer currency={profile?.default_currency ?? "USD"} />
      <TourProvider onboardingCompleted={profile?.onboarding_completed ?? false} />
      <WizardProvider hasTradingProfile={profile?.trading_profile != null} />
      <ChatProvider />
    </div>
  );
}
