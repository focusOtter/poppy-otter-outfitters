"use server";

import { cardFor } from "@/lib/checkout-options";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth0 } from "@/lib/auth0";
import { ensureGuestToken, getDriver, requireCustomer } from "@/lib/poppy";
import { cartsApi, type ApiResult } from "@/lib/carts-api";
import type { ActionResult } from "@/lib/action-result";

function failure(r: Extract<ApiResult<unknown>, { ok: false }>, returnTo: string): ActionResult {
  const signIn = (r.reason === "sign_in_required" || r.reason === "token_rejected") && r.caller !== "agent_guest";
  return { ok: false, message: r.message, signInReturnTo: signIn ? returnTo : undefined };
}

export async function addToCart(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const productId = String(formData.get("productId") ?? "");
  if (!productId) return { ok: false, message: "Pick a product first." };
  const quantity = Number(formData.get("quantity") ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    return { ok: false, message: "Choose a quantity from 1 to 10." };
  }

  // A person who isn't logged in shops as a guest: the first add creates an anonymous session, and the API keeps
  // the cart under its token until the person signs in (proxy.ts then merges it into the account).
  // Agent guests already have a token: the API keys their cart by Poppy Session.
  const driver = await getDriver();
  let as: { token: string; caller: "guest" } | undefined;
  if (driver.kind === "visitor" || driver.kind === "guest") {
    try {
      as = { token: await ensureGuestToken(), caller: "guest" };
    } catch (err) {
      // An AnonymousSessionError, such as invalid_target when the tenant has no anonymous client grant for the API.
      const code = (err as { code?: string }).code ?? "error";
      console.error(`[guest-cart] couldn't create an anonymous session (${code}): ${(err as Error).message}`);
      return { ok: false, message: "Let's try that again. Retry, or sign in to start your cart.", signInReturnTo: "/" };
    }
  }

  // The API sets a line's quantity (so retried agent requests are safe), so "add" adds to what's already there.
  // A brand-new guest has no cart yet; treat a failed read as empty.
  const current = await cartsApi.cart();
  const existing = current.ok ? (current.data.items.find((line) => line.productId === productId)?.quantity ?? 0) : 0;
  if (existing >= 10) return { ok: false, message: "You already have the maximum of 10 in your cart." };
  const next = Math.min(10, existing + quantity);
  const addedNow = next - existing;

  const r = await cartsApi.addItem(productId, next, as);
  if (!r.ok) return failure(r, "/");
  // The layout, not just /cart: the header's cart badge re-renders from this response.
  revalidatePath("/", "layout");
  const capped = addedNow < quantity ? " (10 is the most per item)" : "";
  return { ok: true, message: `${addedNow === 1 ? "Added to your cart." : `Added ${addedNow} to your cart.`}${capped}` };
}

export async function removeFromCart(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const productId = String(formData.get("productId") ?? "");
  const r = await cartsApi.removeItem(productId);
  if (!r.ok) return failure(r, "/cart");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function checkout(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  // The simulated payment: the test card behind the chosen saved payment method.
  const card = cardFor(String(formData.get("paymentMethodId") ?? "") || undefined);
  const r = await cartsApi.placeOrder(card);
  if (!r.ok) {
    // The API refuses guests with sign_in_required; the agent must take the customer through sign-in.
    if (r.reason === "sign_in_required" && r.caller === "agent_guest") {
      return {
        ok: false,
        message: "Checkout is on the customer's account. Sign in through your agent, then check out."
      };
    }
    // A person's guest cart: orders need an account. The cart moves into the account on sign-in.
    if (r.reason === "sign_in_required" && r.caller === "guest") {
      return { ok: false, message: "Sign in to check out. Your cart comes with you.", signInReturnTo: "/checkout" };
    }
    return failure(r, "/checkout");
  }
  revalidatePath("/", "layout");
  redirect(`/account/orders/${encodeURIComponent(r.data?.id ?? "")}`);
}

export async function disconnectAgent(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const gate = await requireCustomer("Only the customer can disconnect an agent.");
  if (!gate.allowed) return { ok: false, message: gate.message };

  const sessionKey = String(formData.get("sessionKey") ?? "");
  if (!sessionKey) return { ok: false, message: "Pick an agent first." };

  const r = await cartsApi.disconnectAgent(sessionKey);
  if (!r.ok) return failure(r, "/agents");
  revalidatePath("/agents");
  // Ending the Session doesn't revoke the agent's tokens or its approval: it can start a new Session and, while
  // those are valid, sign in again without asking. Revoke its access in Auth0 to stop that.
  return { ok: true, message: "Disconnected. This agent session is over; the agent can start a new one later." };
}

export async function updateDisplayName(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  // Account changes are for the customer only, whatever the agent was approved for.
  const gate = await requireCustomer("Account details are updated by you, from your own login.");
  if (!gate.allowed) return { ok: false, message: gate.message };

  const session = await auth0.getSession();
  if (!session) {
    return { ok: false, message: "Sign in to change your display name.", signInReturnTo: "/account" };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 1 || name.length > 60) {
    return { ok: false, message: "Use 1 to 60 characters." };
  }

  // This sample changes the name in this site's session only, not the Auth0 user profile.
  await auth0.updateSession({ ...session, user: { ...session.user, name } });
  revalidatePath("/", "layout");
  return { ok: true, message: "Display name updated for this session." };
}
