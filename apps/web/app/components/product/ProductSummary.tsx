import type { Product } from "@/lib/carts-api";
import { formatPrice } from "@/lib/format";
import type { ProductDetails } from "@/lib/product-details";
import { AddToCartForm } from "../AddToCartForm";

const ASSURANCES = [
  { title: "Free shipping over $100", body: "Orders ship within 1 business day." },
  { title: "30-day returns", body: "Used it on a trip and it's not right? Send it back." },
  { title: "2-year warranty", body: "Covers materials and workmanship." }
];

export function ProductSummary({ product, details }: { product: Product; details?: ProductDetails }) {
  return (
    <div className="product-info">
      {product.category && <span className="blaze blaze-inline">{product.category}</span>}
      <h1 className="text-balance">{product.name}</h1>
      <p className="product-price">{formatPrice(product.priceCents)}</p>
      {product.description && <p className="product-desc text-pretty">{product.description}</p>}

      {details && (
        <ul className="highlights">
          {details.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}

      <AddToCartForm productId={product.id} withQuantity />

      <ul className="assurances">
        {ASSURANCES.map((a) => (
          <li key={a.title}>
            <strong>{a.title}</strong>
            <span>{a.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
