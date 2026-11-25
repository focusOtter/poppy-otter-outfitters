import { cartsApi } from "./carts-api";
import { canReadCart, getDriver } from "./poppy";

/** Items in the current cart, for the header badge. */
export async function getCartCount(): Promise<number> {
  const driver = await getDriver();
  if (!canReadCart(driver)) return 0;
  const cart = await cartsApi.cart();
  return cart.ok ? cart.data.items.reduce((sum, line) => sum + line.quantity, 0) : 0;
}
