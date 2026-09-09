import type { Metadata } from "next";

import AdminDashboard from "../../dashboard";

export const metadata: Metadata = {
  title: "COAST Operations",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function AdminUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <AdminDashboard initialUserId={userId} />;
}
