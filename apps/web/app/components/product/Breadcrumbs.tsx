import Link from "next/link";
import { categoryHref } from "@/lib/format";

export function Breadcrumbs({ category }: { category?: string }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href="/">River and camp gear</Link>
      {category && (
        <>
          <span aria-hidden>/</span>
          <Link href={categoryHref(category)}>{category}</Link>
        </>
      )}
    </nav>
  );
}
