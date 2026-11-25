import Link from "next/link";

export function EmptyCart() {
  return (
    <div className="empty">
      <p>Your cart is empty.</p>
      <Link href="/" className="btn btn-primary">
        Browse the catalog
      </Link>
    </div>
  );
}
