import type { Product } from "@/lib/carts-api";
import { ProductGrid } from "../ProductGrid";

/** Up to three products from the same category, or any three others if the category has none. */
export function RelatedProducts({ product, catalog }: { product: Product; catalog: Product[] }) {
  const others = catalog.filter((p) => p.id !== product.id);
  const sameCategory = others.filter((p) => p.category === product.category);
  const shown = (sameCategory.length ? sameCategory : others).slice(0, 3);
  if (!shown.length) return null;

  return (
    <section className="related" aria-labelledby="related-heading">
      <h2 id="related-heading">
        {sameCategory.length ? `More ${product.category?.toLowerCase()}` : "You might also like"}
      </h2>
      <ProductGrid products={shown} />
    </section>
  );
}
