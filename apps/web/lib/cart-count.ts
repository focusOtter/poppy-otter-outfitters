import { cartsApi } from "./carts-api";
import { getDriver } from "./poppy";

/** Items in the current cart, for the header badge. A visitor has no cart yet: the first add starts a guest session. */
export async function getCartCount(): Promise<number> {
  const driver = await getDriver();
  if (driver.kind === "visitor") return 0;
  const cart = await cartsApi.cart();
  return cart.ok ? cart.data.items.reduce((sum, line) => sum + line.quantity, 0) : 0;
}
