"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/LanguageContext";
import { CheckCircleIcon } from "@heroicons/react/24/outline";

// One-time banner shown after an account is deleted. Strips the ?deleted=1
// query param from the URL once mounted so a refresh/navigation doesn't
// re-show it.
export default function AccountDeletedBanner() {
  const tx = useT();
  const router = useRouter();

  React.useEffect(() => {
    router.replace("/", { scroll: false });
  }, [router]);

  return (
    <div className="mx-auto mb-6 flex max-w-3xl items-center gap-3 rounded-xl border border-accent-green/30 bg-accent-green-bg/60 p-4 text-sm text-accent-green">
      <CheckCircleIcon className="h-5 w-5 flex-shrink-0" />
      <span>
        {tx("تم حذف حسابك بنجاح. نأمل أن نراك مرة أخرى قريباً.", "Hesabınız başarıyla silindi. Tekrar görüşmek üzere.", "Your account was deleted successfully. See you again.")}
      </span>
    </div>
  );
}
