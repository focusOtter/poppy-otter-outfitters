import type { ReactNode } from "react";
import type { Product } from "@/lib/carts-api";
import { formatWeight } from "@/lib/format";
import type { ProductDetails } from "@/lib/product-details";

function DetailBlock({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="detail-block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export function ProductSpecs({ product, details }: { product: Product; details?: ProductDetails }) {
  const noun = product.name.split(" ").at(-1)?.toLowerCase();
  const specs: [string, ReactNode][] = [
    ...(product.weightGrams !== undefined ? [["Weight", formatWeight(product.weightGrams)] as [string, ReactNode]] : []),
    ...(details?.specs ?? []),
    ["Item code", <code key="code">{product.id}</code>]
  ];

  return (
    <div className="product-details">
      {details && (
        <DetailBlock id="overview-heading" title={`About the ${noun}`}>
          {details.overview.map((para) => (
            <p key={para.slice(0, 24)} className="text-pretty">
              {para}
            </p>
          ))}
        </DetailBlock>
      )}

      <DetailBlock id="specs-heading" title="Specifications">
        <dl className="specs">
          {specs.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </DetailBlock>

      {details && (
        <>
          <DetailBlock id="box-heading" title="What's in the box">
            <ul className="box-list">
              {details.inTheBox.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </DetailBlock>
          <DetailBlock id="care-heading" title="Care">
            <p className="text-pretty">{details.care}</p>
          </DetailBlock>
        </>
      )}
    </div>
  );
}
