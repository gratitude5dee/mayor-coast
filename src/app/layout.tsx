import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COAST — San Francisco, on text",
  description:
    "COAST is an unofficial AI concierge for finding what to do, eat, and drink in San Francisco.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
