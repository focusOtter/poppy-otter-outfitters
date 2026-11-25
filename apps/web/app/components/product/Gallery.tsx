import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/carts-api";

// Thumbnails are plain links (?view=n), so agents and no-JS visitors can browse photos too.
export function Gallery({ product, view }: { product: Product; view: number }) {
  const images = product.images ?? [];
  const index = Math.min(Math.max(view, 0), Math.max(images.length - 1, 0));
  const alt = (i: number) => (i === 0 ? product.name : `${product.name}, view ${i + 1}`);

  if (!images.length) {
    return (
      <div className="product-gallery">
        <div className="product-img placeholder" aria-hidden>
          {product.name.slice(0, 1)}
        </div>
      </div>
    );
  }

  return (
    <div className="product-gallery">
      <div className="product-img-frame">
        <Image key={images[index]} className="product-img" src={images[index]} alt={alt(index)} width={1024} height={1024} priority sizes="(max-width: 860px) 92vw, 560px" style={{ height: "auto" }} />
      </div>
      {images.length > 1 && (
        <ul className="thumbs" aria-label="More photos">
          {images.map((src, i) => (
            <li key={src}>
              <Link
                href={i === 0 ? `/products/${product.id}` : `/products/${product.id}?view=${i}`}
                scroll={false}
                replace
                className="thumb"
                aria-current={i === index ? "true" : undefined}
              >
                <Image src={src} alt={alt(i)} width={160} height={160} sizes="80px" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
