import type { Metadata } from "next";
import AdminDashboard from "./dashboard";
export const metadata: Metadata = { title: "COAST Operations", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function AdminPage() { return <AdminDashboard />; }
