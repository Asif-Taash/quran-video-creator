import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { avatarUrl } from "@/lib/auth/avatar";
import Navbar from "@/components/layout/Navbar";
import AccountSettings from "@/components/account/AccountSettings";

export const metadata = {
  title: "Hesap | Kuran Nuru",
};

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    redirect("/login");
  }
  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      <Navbar />
      <main className="px-4 py-12 md:py-16">
        <AccountSettings
          email={user.email}
          initialName={user.name}
          initialAvatarUrl={avatarUrl(user.avatarPath)}
          initialEmailVerified={Boolean(user.emailVerifiedAt)}
        />
      </main>
    </div>
  );
}
