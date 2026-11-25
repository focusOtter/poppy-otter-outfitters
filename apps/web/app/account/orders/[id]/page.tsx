import Link from "next/link";
import { cartsApi } from "@/lib/carts-api";
import { ApiNotice } from "../../../components/ApiNotice";
import { OrderCard } from "../../../components/orders/OrderCard";
import { PageHeader } from "../../../components/ui/PageHeader";

export const metadata = { title: "Order placed" };

/** The order confirmation page checkout redirects to. Agents read `/account/orders/<id>` as "order placed". */
export default async function OrderConfirmationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [orders, products] = await Promise.all([cartsApi.orders(), cartsApi.products()]);
  if (!orders.ok) {
    return (
      <>
        <PageHeader title="Order placed" />
        <ApiNotice result={orders} returnTo={`/account/orders/${encodeURIComponent(id)}`} />
      </>
    );
  }
  const order = orders.data.find((o) => o.id === id);
  return (
    <>
      <PageHeader title={order ? "Order placed" : "Order not found"}>
        {order ? "Thanks. Your order is confirmed." : "There is no order with that number on this account."}
      </PageHeader>
      {order && (
        <ul className="orders">
          <OrderCard order={order} catalog={products.ok ? products.data : []} />
        </ul>
      )}
      <p className="order-links">
        <Link href="/orders">See all orders</Link>
        <Link href="/">Keep shopping</Link>
      </p>
    </>
  );
}
