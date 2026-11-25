import Image from "next/image";
import Link from "next/link";
import { removeFromCart } from "@/app/actions";
import { formatPrice } from "@/lib/format";
import { ActionForm } from "../ActionForm";

export type CartRow = { productId: string; name: string; image?: string; quantity: number; price: number; line: number };

export function CartLines({ rows }: { rows: CartRow[] }) {
  return (
    <ul className="cart-lines" aria-label="Items in your cart">
      {rows.map((r) => (
        <li key={r.productId} className="cart-line">
          {r.image ? (
            <Image src={r.image} alt="" className="cart-thumb" width={224} height={224} sizes="112px" />
          ) : (
            <span className="cart-thumb placeholder" aria-hidden />
          )}
          <div className="cart-line-info">
            <Link href={`/products/${r.productId}`} className="cart-line-name">
              {r.name}
            </Link>
            <span className="muted">
              {r.quantity} x {formatPrice(r.price)}
            </span>
          </div>
          <span className="cart-line-total">{formatPrice(r.line)}</span>
          <ActionForm action={removeFromCart} label="Remove" variant="link" hidden={{ productId: r.productId }} />
        </li>
      ))}
    </ul>
  );
}
