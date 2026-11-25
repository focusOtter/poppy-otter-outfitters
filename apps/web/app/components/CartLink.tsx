"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCartCount } from "./CartCountProvider";

/** The header's cart link. The badge pops when the count goes up, so an add from anywhere on the page is noticed. */
export function CartLink() {
  const { count } = useCartCount();
  const pathname = usePathname();
  const previous = useRef(count);
  const [bump, setBump] = useState(false);

  useEffect(() => {
    if (count > previous.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 700);
      previous.current = count;
      return () => clearTimeout(t);
    }
    previous.current = count;
  }, [count]);

  const label = count === 0 ? "Cart, empty" : `Cart, ${count} ${count === 1 ? "item" : "items"}`;

  return (
    <Link
      href="/cart"
      className={`cart-link${bump ? " is-bumping" : ""}`}
      aria-label={label}
      aria-current={pathname === "/cart" ? "page" : undefined}
    >
      <svg className="cart-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M9 8V6.5a3 3 0 0 1 6 0V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="cart-text">Cart</span>
      {count > 0 && (
        <span className="cart-badge" aria-hidden>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
