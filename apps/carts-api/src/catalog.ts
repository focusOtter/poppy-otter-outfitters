import type { CartLine, PricedCartLine } from './storage/index.js';

export interface Product {
  id: string;
  name: string;
  priceCents: number;
  /** Image paths served by the storefront (apps/web/public/products). The first is the main image. */
  images: string[];
  /** A short description for the product page. */
  description: string;
  /** A shelf in the store, such as `Beans` or `Grinders`. Agents can filter `GET /products?category=`. */
  category: string;
  /** Shipping weight in grams (net weight for beans). */
  weightGrams: number;
}

const img = (id: string, count: number, ext = 'png') =>
  Array.from({ length: count }, (_, i) => `/products/${id}-${i + 1}.${ext}`);

// Static seed data for the Drift Bean Demo specialty coffee store.
export const PRODUCTS: readonly Product[] = Object.freeze([
  { id: 'beans-konga', name: 'Konga Natural, Yirgacheffe', priceCents: 2800, category: 'Beans', weightGrams: 250, images: img('beans-konga', 3), description: 'A sun-dried Ethiopian heirloom lot from the Konga cooperative. Blueberry, jasmine and dark chocolate, roasted light for filter.' },
  { id: 'beans-pink-bourbon', name: 'Pink Bourbon, Huila', priceCents: 3200, category: 'Beans', weightGrams: 250, images: img('beans-pink-bourbon', 3), description: 'A rare Colombian varietal grown at 1,850 m and washed after a 72-hour ferment. Red grapefruit, hibiscus and panela.' },
  { id: 'beans-geisha', name: 'Geisha Lot 7, Boquete', priceCents: 6800, category: 'Beans', weightGrams: 100, images: img('beans-geisha', 3), description: 'A competition-grade Panamanian Geisha from a single hillside plot. Bergamot, white peach and honeysuckle. Released in numbered tins.' },
  { id: 'beans-house', name: 'Drift Bean House Espresso', priceCents: 6400, category: 'Beans', weightGrams: 1000, images: img('beans-house', 3), description: 'Our everyday espresso: washed Brazil and Guatemala, roasted medium for milk and straight shots. Cocoa, toffee and roasted hazelnut.' },
  { id: 'machine-atelier', name: 'Atelier Dual-Boiler Espresso Machine', priceCents: 345000, category: 'Machines', weightGrams: 26000, images: img('machine-atelier', 3), description: 'A hand-assembled dual-boiler machine with a saturated group, PID control on both boilers and a rotary pump quiet enough for 6 a.m.' },
  { id: 'brewer-cadence', name: 'Cadence Precision Brewer', priceCents: 38900, category: 'Machines', weightGrams: 3400, images: img('brewer-cadence', 3), description: 'A batch brewer that pours like a barista: a pulsed spray head, a 93 °C hold and a bloom stage you can tune from the dial.' },
  { id: 'grinder-meridian', name: 'Meridian 83 mm Flat-Burr Grinder', priceCents: 169000, category: 'Grinders', weightGrams: 11500, images: img('grinder-meridian', 3), description: 'Large titanium-coated flat burrs, stepless adjustment and a single-dose hopper. Built to switch from espresso to filter in a turn.' },
  { id: 'grinder-pocket', name: 'Pocket Conical Hand Grinder', priceCents: 28900, category: 'Grinders', weightGrams: 640, images: img('grinder-pocket', 3), description: 'A machined aluminium hand grinder with 48 mm hardened steel burrs and a click-free dial. Grinds a cup of filter in under a minute.' },
  { id: 'kettle-vessel', name: 'Vessel Gooseneck Kettle', priceCents: 21900, category: 'Accessories', weightGrams: 1100, images: img('kettle-vessel', 3), description: 'A brushed-steel pour-over kettle with a walnut handle, a counterbalanced spout and temperature hold to the degree.' },
  { id: 'scale-tare', name: 'Tare Brew Scale', priceCents: 14900, category: 'Accessories', weightGrams: 450, images: img('scale-tare', 3), description: 'A 0.1 g scale with a built-in shot timer, flow rate readout and a splash-proof glass top that sits flush on a drip tray.' },
  { id: 'tamper-walnut', name: 'Calibrated Walnut Tamper', priceCents: 12900, category: 'Accessories', weightGrams: 520, images: img('tamper-walnut', 3), description: 'A 58.5 mm stainless base on a turned walnut handle, with a spring that clicks at 15 kg so every puck is tamped the same.' },
  { id: 'cups-porcelain', name: 'Porcelain Tasting Cup Set', priceCents: 9600, category: 'Accessories', weightGrams: 900, images: img('cups-porcelain', 3), description: 'Four thin-walled porcelain cups, hand-glazed in matte bone. Shaped to open up aromatics for espresso, cortado and cupping.' },
]);

export const CATEGORIES: readonly string[] = Object.freeze([...new Set(PRODUCTS.map((p) => p.category))]);

/** Prices cart lines against the catalog. Lines for unknown products are dropped. */
export function priceLines(lines: CartLine[], products: readonly Product[] = PRODUCTS): { items: PricedCartLine[]; totalCents: number } {
  const items = lines.flatMap((line) => {
    const product = products.find((p) => p.id === line.productId);
    if (!product) {
      return [];
    }
    return [{ ...line, name: product.name, priceCents: product.priceCents, lineTotalCents: product.priceCents * line.quantity }];
  });
  return { items, totalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0) };
}
