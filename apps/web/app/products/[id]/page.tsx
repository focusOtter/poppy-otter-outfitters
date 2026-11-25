import { notFound } from "next/navigation";
import { cartsApi } from "@/lib/carts-api";
import { productDetails } from "@/lib/product-details";
import { ApiNotice } from "../../components/ApiNotice";
import { Breadcrumbs } from "../../components/product/Breadcrumbs";
import { Gallery } from "../../components/product/Gallery";
import { ProductSpecs } from "../../components/product/ProductSpecs";
import { ProductSummary } from "../../components/product/ProductSummary";
import { RelatedProducts } from "../../components/product/RelatedProducts";

// Agents read this page the same way people do: name, price, photos and "Add to cart" are plain HTML.
export default async function ProductPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const [{ id }, { view }] = await Promise.all([params, searchParams]);
  const products = await cartsApi.products();
  if (!products.ok) return <ApiNotice result={products} returnTo={`/products/${id}`} />;

  const product = products.data.find((p) => p.id === id);
  if (!product) notFound();
  const details = productDetails(product.id);

  return (
    <article className="product">
      <Breadcrumbs category={product.category} />
      <div className="product-layout">
        <Gallery product={product} view={Number(view) || 0} />
        <ProductSummary product={product} details={details} />
      </div>
      <ProductSpecs product={product} details={details} />
      <RelatedProducts product={product} catalog={products.data} />
    </article>
  );
}
