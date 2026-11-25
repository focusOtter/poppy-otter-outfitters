import { cartsApi } from "@/lib/carts-api";
import { categoryHref } from "@/lib/format";
import { getDriver } from "@/lib/poppy";
import { ApiNotice } from "./components/ApiNotice";
import { Hero } from "./components/home/Hero";
import { ProductGrid } from "./components/ProductGrid";
import { FilterChips } from "./components/ui/FilterChips";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const [{ category }, products, driver] = await Promise.all([searchParams, cartsApi.products(), getDriver()]);
  // A visitor has no session, so no cart to look up yet.
  const cart = driver.kind === "visitor" ? undefined : await cartsApi.cart();
  const inCart = new Map((cart?.ok ? cart.data.items : []).map((i) => [i.productId, i.quantity]));
  const all = products.ok ? products.data : [];
  const categories = [...new Set(all.map((p) => p.category).filter((c): c is string => Boolean(c)))];
  const active = categories.find((c) => c.toLowerCase() === category?.toLowerCase());
  const shown = active ? all.filter((p) => p.category === active) : all;

  const chips = [
    { label: "All", href: "/", current: !active },
    ...categories.map((c) => ({ label: c, href: categoryHref(c), current: c === active }))
  ];

  return (
    <>
      <Hero showGuestNote={driver.kind === "visitor" || driver.kind === "guest"} />

      <section aria-labelledby="catalog-heading" className="catalog">
        <div className="catalog-head">
          <h2 id="catalog-heading">{active ?? "River and camp gear"}</h2>
          <span className="muted">{shown.length} items</span>
        </div>

        {categories.length > 0 && <FilterChips label="Categories" chips={chips} />}

        {!products.ok ? (
          <ApiNotice result={products} returnTo="/" />
        ) : shown.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <ProductGrid products={shown} inCart={inCart} />
        )}
      </section>
    </>
  );
}
