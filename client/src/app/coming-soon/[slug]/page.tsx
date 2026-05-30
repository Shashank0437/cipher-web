import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ComingSoonView } from "@/components/coming-soon/ComingSoonView";
import type { ComingSoonSlug } from "@/lib/coming-soon-routes";
import { COMING_SOON_PAGES, COMING_SOON_SLUGS, resolveComingSoonBackNav } from "@/lib/coming-soon-routes";

export function generateStaticParams() {
  return COMING_SOON_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const s = slug as ComingSoonSlug;
  if (!COMING_SOON_PAGES[s]) return { title: "Not found | Vrika" };
  const p = COMING_SOON_PAGES[s];
  return {
    title: `${p.title} — Coming soon | Vrika`,
    description: p.teaser,
  };
}

export default async function ComingSoonPageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const s = slug as ComingSoonSlug;
  if (!COMING_SOON_PAGES[s]) notFound();
  const sp = await searchParams;
  const backNav = resolveComingSoonBackNav(sp);
  return <ComingSoonView backNav={backNav} />;
}
