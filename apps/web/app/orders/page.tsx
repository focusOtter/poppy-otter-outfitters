import Link from "next/link";
import { cartsApi } from "@/lib/carts-api";
import { getDriver } from "@/lib/poppy";
import { ApiNotice } from "../components/ApiNotice";
import { OrderCard, orderNumber } from "../components/orders/OrderCard";
import { FilterChips } from "../components/ui/FilterChips";
import { Notice } from "../components/ui/Notice";
import { PageHeader } from "../components/ui/PageHeader";

const FILTERS = [
  { via: undefined, label: "All" },
  { via: "agent", label: "Placed by agents" },
  { via: "person", label: "Placed by you" }
] as const;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ placed?: string; via?: string }> }) {
  const { placed, via } = await searchParams;
  const placedVia = via === "agent" || via === "person" ? via : undefined;
  const driver = await getDriver();

  if (driver.kind === "agent_guest") {
    return (
      <>
        <PageHeader title="Orders" />
        <Notice>{"Orders belong to the customer's account. Sign in through your agent to see them."}</Notice>
      </>
    );
  }
  if (driver.kind === "visitor" || driver.kind === "guest") {
    return (
      <>
        <PageHeader title="Orders" />
        <Notice signInTo="/orders">Sign in to see your orders.</Notice>
      </>
    );
  }

  const [orders, products] = await Promise.all([cartsApi.orders(placedVia), cartsApi.products()]);
  const catalog = products.ok ? products.data : [];
  const chips = FILTERS.map((f) => ({
    label: f.label,
    href: f.via ? `/orders?via=${f.via}` : "/orders",
    current: f.via === placedVia
  }));
  const newestFirst = orders.ok
    ? [...orders.data].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    : [];

  return (
    <>
      <PageHeader title="Orders">Everything you and your agents have ordered.</PageHeader>
      {placed && <p className="form-note ok">Order {orderNumber(placed)} placed.</p>}
      <FilterChips label="Filter orders" chips={chips} />
      {!orders.ok ? (
        <ApiNotice result={orders} returnTo="/orders" />
      ) : newestFirst.length === 0 ? (
        <div className="empty">
          <p>{placedVia === "agent" ? "No agent has placed an order yet." : "No orders yet."}</p>
          <Link href="/" className="btn btn-primary">
            Shop the store
          </Link>
        </div>
      ) : (
        <ul className="orders">
          {newestFirst.map((o) => (
            <OrderCard key={o.id} order={o} catalog={catalog} />
          ))}
        </ul>
      )}
    </>
  );
}
