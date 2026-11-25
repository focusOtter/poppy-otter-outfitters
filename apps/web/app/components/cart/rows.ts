import type { Cart, Product } from "@/lib/carts-api";
import type { CartRow } from "./CartLines";

/** Fill in each line's name, photo and price from the catalog. */
export function toRows(cart: Cart, catalog: Product[]): CartRow[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return cart.items.map((i) => {
    const p = byId.get(i.productId);
    const price = i.priceCents ?? p?.priceCents ?? 0;
    return {
      productId: i.productId,
      name: i.name ?? p?.name ?? i.productId,
      image: p?.images?.[0],
      quantity: i.quantity,
      price,
      line: price * i.quantity
    };
  });
}
