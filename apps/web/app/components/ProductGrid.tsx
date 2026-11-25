import type { Product } from "@/lib/carts-api";
import { ProductCard } from "./ProductCard";

/** `inCart` maps product id to the quantity already in the cart. */
export function ProductGrid({ products, inCart }: { products: Product[]; inCart?: Map<string, number> }) {
  return (
    <ul className="grid">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} inCart={inCart?.get(p.id) ?? 0} />
      ))}
    </ul>
  );
}
