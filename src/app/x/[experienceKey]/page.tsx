import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { api } from "../../../../convex/_generated/api";
import {
  decodeExperienceKey,
  presentationFromExperienceDetails,
} from "@/lib/coast";
import { getConvexHttpClient } from "@/lib/convex";

import { RedirectToSource } from "./redirect-client";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ experienceKey: string }>;
};

async function getExperience(experienceKey: string) {
  const externalId = decodeExperienceKey(experienceKey);
  if (externalId === null) return null;
  const experience = await getConvexHttpClient().query(
    api.dataset.getExperienceDetails,
    { externalId, nowMs: Date.now() },
  );
  return experience === null ? null : presentationFromExperienceDetails(experience);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const presentation = await getExperience((await params).experienceKey);
  if (presentation === null) return { title: "COAST" };
  const fallbackImage = new URL(
    "/coast-card.svg",
    process.env.COAST_DELIVERY_URL ?? "https://mayor-blue.vercel.app",
  ).toString();
  const image = presentation.imageUrl ?? fallbackImage;
  return {
    title: presentation.title,
    description: presentation.description,
    openGraph: {
      title: presentation.title,
      description: presentation.description,
      url: presentation.canonicalUrl,
      images: [{ url: image }],
    },
    twitter: { card: "summary_large_image", images: [image] },
    robots: { index: false, follow: false },
  };
}

export default async function ExperiencePreview({ params }: PageProps) {
  const presentation = await getExperience((await params).experienceKey);
  if (presentation === null) notFound();
  return <RedirectToSource sourceUrl={presentation.canonicalUrl} />;
}
