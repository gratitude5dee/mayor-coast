import type { Metadata } from "next";

import DrawStudio from "./draw-studio";

export const dynamic = "force-dynamic";

const description = "A little sketch. A whole new image. Open your private COAST drawing canvas.";

// Generic metadata deliberately performs no session lookup or authorization exchange.
export const metadata: Metadata = {
  title: "COAST Draw — make room for an idea",
  description,
  referrer: "no-referrer",
  openGraph: {
    title: "COAST Draw",
    description,
    images: [{ url: new URL("/coast-draw-card.svg", process.env.COAST_PUBLIC_URL ?? "https://mayor-blue.vercel.app").toString(), width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", title: "COAST Draw", description },
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
};

export default async function DrawPage({ params }: { params: Promise<{ sessionId: string }> }) {
  // The adapter is held behind a separate server-side flag and requires a
  // production license. The custom raster canvas remains the production path.
  const licenseKey = process.env.COAST_DRAW_TLDRAW_LICENSE_KEY;
  const tldrawEnabled = process.env.COAST_DRAW_TLDRAW_ENABLED === "true" && Boolean(licenseKey);
  const sessionId = (await params).sessionId;
  if (tldrawEnabled && licenseKey) return <DrawStudio sessionId={sessionId} tldrawEnabled tldrawLicenseKey={licenseKey} />;
  return <DrawStudio sessionId={sessionId} />;
}
