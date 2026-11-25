import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/carts-api";
import { formatPrice, formatWeight } from "@/lib/format";
import { AddToCartForm } from "./AddToCartForm";

export function ProductCard({ product, inCart = 0 }: { product: Product; inCart?: number }) {
  const [first, second] = product.images ?? [];
  return (
    <li className="card">
      <Link href={`/products/${product.id}`} className="card-media" tabIndex={-1} aria-hidden>
        {first ? (
          <>
            <Image className="card-img" src={first} alt="" width={1024} height={1024} sizes="(max-width: 640px) 92vw, (max-width: 1120px) 45vw, 360px" style={{ height: "auto" }} />
            {/* The second photo shows on hover. */}
            {second && <Image className="card-img card-img-alt" src={second} alt="" width={1024} height={1024} sizes="(max-width: 640px) 92vw, (max-width: 1120px) 45vw, 360px" />}
          </>
        ) : (
          <span className="card-img placeholder">{product.name.slice(0, 1)}</span>
        )}
      </Link>
      <div className="card-body">
        {product.category && <p className="card-cat">{product.category}</p>}
        <h2 className="card-title">
          <Link href={`/products/${product.id}`}>{product.name}</Link>
        </h2>
        <p className="card-meta">
          <span className="price">{formatPrice(product.priceCents)}</span>
          {product.weightGrams !== undefined && <span className="weight">{formatWeight(product.weightGrams)}</span>}
        </p>
        <AddToCartForm productId={product.id} variant="secondary" inCart={inCart} />
      </div>
    </li>
  );
}
