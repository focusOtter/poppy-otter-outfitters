import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import { Inter, Roboto_Mono } from "next/font/google";
import { getCartCount } from "@/lib/cart-count";
import { CartCountProvider } from "./components/CartCountProvider";
import { Header } from "./components/Header";
import "./globals.css";

const body = Inter({ subsets: ["latin"], variable: "--font-body" });
const mono = Roboto_Mono({ subsets: ["latin"], variable: "--font-mono" });

const title = "Otter Outfitters | River and camp gear";
const description = "A demo outdoor shop where your personal agent can fill a cart and check out with your approval, powered by Auth0 Personal Agents.";
// Link previews (Slack, X, LinkedIn, iMessage) need absolute image URLs, so resolve them against the public URL.
const ogImage = { url: "/outfitters-og.png", width: 1200, height: 630, alt: "Otter Outfitters: take the river route" };

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_BASE_URL || "http://localhost:3000"),
  title,
  description,
  openGraph: { type: "website", siteName: "Otter Outfitters", title, description, url: "/", images: [ogImage] },
  twitter: { card: "summary_large_image", title, description, images: [ogImage] }
};

export const viewport: Viewport = {
  themeColor: "#eef3eb"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cartCount = await getCartCount();
  return (
    <html lang="en" className={`${body.variable} ${mono.variable}`}>
      <body>
        <aside className="sample-notice" aria-label="Reference website notice">
          <div className="wrap sample-notice-inner">
            <div className="sample-notice-message">
              <Image
                src="/images/poppy-avatar-v2.png"
                alt=""
                width={32}
                height={32}
                className="sample-notice-avatar"
                priority
              />
              <p>
                A reference app for{" "}
                <a
                  href="https://poppyplayground.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sample-notice-link"
                >
                  Poppy (Personal Agent Protocol)
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
                  </svg>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                from Auth0. Products and orders are samples.
              </p>
            </div>
            <nav className="footer-nav" aria-label="Developer">
              <Link href="/debug">Debug</Link>
              <a href="/.well-known/poppy.json">poppy.json</a>
              <a
                href="https://github.com/auth0-samples/auth0-poppy-sample"
                target="_blank"
                rel="noopener noreferrer"
                className="github-link"
              >
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                GitHub
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </nav>
          </div>
        </aside>
        <CartCountProvider count={cartCount}>
          <Header />
          <main className="wrap main">{children}</main>
        </CartCountProvider>
        <footer className="site-footer">
          <div className="wrap footer-inner">
            {/* The legal team's disclaimer, word for word. apps/web-express/src/views.js has the same footer. */}
            <p>
              Disclaimer: This is not a real webshop, it is just a demo site representing a Poppy enabled webshop. Do not
              enter your personal information or any other personal data. Source code available here:{" "}
              <a href="https://github.com/auth0-samples/auth0-poppy-sample" target="_blank" rel="noopener noreferrer">
                github.com/auth0-samples/auth0-poppy-sample
              </a>
            </p>
            <nav className="footer-nav" aria-label="Legal">
              <Link href="/privacy">Privacy</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
