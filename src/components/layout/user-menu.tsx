"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";

function MenuItems({
  email,
  onProfile,
  onSignOut,
}: {
  email: string | null;
  onProfile: () => void;
  onSignOut: () => void;
}) {
  return (
    <DropdownMenuContent align="end" className="w-56">
      {email && (
        <>
          <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">{email}</div>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onClick={onProfile}>
        <User className="mr-2 h-4 w-4" />
        Profile
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onSignOut}>
        <LogOut className="mr-2 h-4 w-4" />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function UserMenu() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setEmail(user?.email ?? null);
    });
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = email ? email.slice(0, 2).toUpperCase() : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" />}
      >
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">
            {initials ?? <User className="h-4 w-4" />}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <MenuItems
        email={email}
        onProfile={() => router.push("/settings/profile")}
        onSignOut={handleSignOut}
      />
    </DropdownMenu>
  );
}
