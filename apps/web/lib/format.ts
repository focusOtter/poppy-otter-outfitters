export function formatPrice(cents: number | undefined): string {
  if (typeof cents !== "number") return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function formatWeight(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams} g`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function categoryHref(category: string): string {
  return `/?category=${encodeURIComponent(category.toLowerCase())}`;
}

/** /auth/login is served by the SDK from proxy.ts, so link to it with a plain <a>, not <Link>. */
export function loginHref(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
