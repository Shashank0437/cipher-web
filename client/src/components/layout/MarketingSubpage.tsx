import Link from "next/link";
import type { ReactNode } from "react";

export type TocItem = { href: string; label: string };

export function MarketingSubpage({
  title,
  eyebrow,
  lastUpdated,
  children,
  toc,
  breadcrumbLabel = "Legal",
}: {
  title: string;
  eyebrow?: string;
  lastUpdated?: string;
  children: ReactNode;
  toc?: TocItem[];
  breadcrumbLabel?: string;
}) {
  const hasToc = toc && toc.length > 0;

  return (
    <main className="relative min-h-dvh bg-background font-sans text-on-background antialiased">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_100%_60%_at_50%_-10%,rgba(104,76,182,0.08),transparent),radial-gradient(ellipse_70%_50%_at_100%_80%,rgba(0,109,75,0.05),transparent)]" />
      <div className="relative mx-auto max-w-6xl px-6 py-10 md:py-14">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-on-surface-variant">
          <Link href="/" className="font-medium text-primary transition hover:underline">
            Home
          </Link>
          <span aria-hidden className="text-outline-variant">
            /
          </span>
          <span>{breadcrumbLabel}</span>
          <span aria-hidden className="text-outline-variant">
            /
          </span>
          <span className="font-medium text-on-surface">{title}</span>
        </nav>

        <div
          className={
            hasToc
              ? "mt-8 grid gap-10 lg:grid-cols-[13.75rem_minmax(0,1fr)]"
              : "mt-8"
          }
        >
          {hasToc ? (
            <>
              <div className="col-span-full flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
                {toc!.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="shrink-0 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-1.5 text-xs font-medium text-on-surface-variant transition hover:border-primary/45 hover:text-primary"
                  >
                    {item.label}
                  </a>
                ))}
              </div>
              <aside className="hidden lg:block">
                <div className="sticky top-24 rounded-2xl border border-outline-variant bg-surface-container-lowest/98 p-5 shadow-sm backdrop-blur-sm">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">On this page</p>
                  <ul className="mt-4 space-y-2.5 text-sm leading-snug">
                    {toc!.map((item) => (
                      <li key={item.href}>
                        <a href={item.href} className="text-on-surface-variant transition hover:text-primary hover:underline">
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <Link href="/" className="mt-8 block text-xs font-semibold text-primary hover:underline">
                    ← Back home
                  </Link>
                </div>
              </aside>
            </>
          ) : null}

          <article
            className={
              hasToc
                ? "rounded-[1.75rem] border border-outline-variant bg-surface-container-lowest shadow-[0_12px_40px_-24px_rgba(27,27,33,0.32)]"
                : "mx-auto max-w-3xl rounded-[1.75rem] border border-outline-variant bg-surface-container-lowest shadow-[0_12px_40px_-24px_rgba(27,27,33,0.32)]"
            }
          >
            <header className="border-b border-outline-variant/70 px-6 py-8 md:px-10 md:py-10">
              {!hasToc ? (
                <Link href="/" className="text-sm font-semibold text-primary hover:underline md:text-[15px]">
                  ← Back home
                </Link>
              ) : (
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-on-surface-variant lg:hidden">{breadcrumbLabel}</p>
              )}
              {eyebrow ? (
                <p className={`text-xs font-bold uppercase tracking-[0.28em] text-primary ${hasToc ? "mt-6 lg:mt-0" : "mt-8"}`}>{eyebrow}</p>
              ) : null}
              <h1
                className={`text-3xl font-bold tracking-tight text-on-surface md:text-[2.25rem] md:leading-[1.15] ${eyebrow ? "mt-2" : !hasToc ? "mt-8" : "mt-6 lg:mt-2"}`}
              >
                {title}
              </h1>
              {lastUpdated ? (
                <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
                  <span className="inline-block size-1.5 shrink-0 rounded-full bg-tertiary" aria-hidden />
                  Last updated {lastUpdated}
                </p>
              ) : null}
            </header>
            <div className="prose-marketing px-6 pb-12 pt-2 md:px-10 md:pb-14">
              {children}
            </div>
          </article>

          {hasToc && breadcrumbLabel === "Legal" ? (
            <p className="col-span-full max-w-2xl text-sm leading-relaxed text-on-surface-variant lg:col-start-2">
              Vrika publishes these documents for transparency. Formal agreements with your organization may supersede this
              general language—confirm with counsel for production commitments.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
