"use client";

import { createContext, useContext, useOptimistic } from "react";

type CartCount = { count: number; addOptimistic: (quantity: number) => void };

const CartCountContext = createContext<CartCount>({ count: 0, addOptimistic: () => {} });

/**
 * Holds the header badge's count. `count` comes from the server on every render; an add bumps it at once
 * (inside the form's action transition) and React drops the guess when the server's new count arrives.
 */
export function CartCountProvider({ count, children }: { count: number; children: React.ReactNode }) {
  const [optimistic, addOptimistic] = useOptimistic(count, (current, quantity: number) => current + quantity);
  return <CartCountContext.Provider value={{ count: optimistic, addOptimistic }}>{children}</CartCountContext.Provider>;
}

export const useCartCount = () => useContext(CartCountContext);
