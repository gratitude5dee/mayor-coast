import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COAST — San Francisco, on text",
  description:
    "COAST is San Francisco’s unofficial mayor for finding what to do, eat, and drink around town.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
