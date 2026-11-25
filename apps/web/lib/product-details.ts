/**
 * Long-form copy for the product page: the store's editorial content. The carts API stays the source of truth for
 * what an agent needs to shop (name, price, category, weight, photos); this is what a person reads before buying.
 */
export type ProductDetails = {
  overview: string[];
  highlights: string[];
  specs: [label: string, value: string][];
  inTheBox: string[];
  care: string;
};

export const PRODUCT_DETAILS: Record<string, ProductDetails> = {
  "beans-konga": {
    overview: [
      "Konga sits at 2,000 metres in the Gedeo zone, where smallholders deliver ripe cherry to raised beds and turn it by hand for three weeks.",
      "We roast it light and rest it ten days, so the fruit reads as blueberry rather than ferment. It shines as a pour-over and holds up as a bright espresso."
    ],
    highlights: ["Tasting notes: blueberry, jasmine, dark chocolate", "Natural process, dried on raised beds", "Roasted light for filter", "Roast date printed on every bag"],
    specs: [
      ["Origin", "Gedeo, Ethiopia"],
      ["Altitude", "1,950–2,100 m"],
      ["Variety", "Ethiopian heirloom"],
      ["Process", "Natural"],
      ["Roast", "Light"]
    ],
    inTheBox: ["250 g whole-bean coffee in a one-way valve bag"],
    care: "Keep sealed, away from light and heat. Best between 10 and 40 days after the roast date. Grind just before brewing."
  },
  "beans-pink-bourbon": {
    overview: [
      "Pink Bourbon is a cross of red and yellow Bourbon that ripens to a salmon pink. It's fussy to grow and rare to find in quantity.",
      "This lot comes from a single family farm above Pitalito. A long, cool ferment before washing gives it a juicy, tea-like cup."
    ],
    highlights: ["Tasting notes: red grapefruit, hibiscus, panela", "72-hour extended ferment, then washed", "Single family farm", "Roasted light-medium"],
    specs: [
      ["Origin", "Huila, Colombia"],
      ["Altitude", "1,850 m"],
      ["Variety", "Pink Bourbon"],
      ["Process", "Washed, extended ferment"],
      ["Roast", "Light-medium"]
    ],
    inTheBox: ["250 g whole-bean coffee in a one-way valve bag"],
    care: "Keep sealed, away from light and heat. Best between 7 and 35 days after the roast date."
  },
  "beans-geisha": {
    overview: [
      "Lot 7 is a single terrace on a slope above Boquete, picked over three passes and dried slowly in the shade. We buy all of it.",
      "Brew it gently, cooler and coarser than you think, and it tastes like bergamot tea with stone fruit. Each tin is numbered."
    ],
    highlights: ["Tasting notes: bergamot, white peach, honeysuckle", "Single-plot, competition-grade lot", "Numbered tin, limited release", "Roasted light for filter"],
    specs: [
      ["Origin", "Boquete, Panama"],
      ["Altitude", "1,700 m"],
      ["Variety", "Geisha"],
      ["Process", "Washed"],
      ["Roast", "Light"]
    ],
    inTheBox: ["100 g whole-bean coffee in a nitrogen-flushed tin", "Tasting card with brew recipe"],
    care: "Open within three months of the roast date. Once opened, keep the lid tight and finish within four weeks."
  },
  "beans-house": {
    overview: [
      "The house espresso is the coffee we pour at the bar every morning: sweet, round and forgiving across a wide range of grind settings.",
      "Washed Brazil gives it body and cocoa; a high-grown Guatemala adds a touch of brightness so it never tastes flat in milk."
    ],
    highlights: ["Tasting notes: cocoa, toffee, roasted hazelnut", "Built for milk drinks and straight shots", "Seasonal components, consistent profile", "Roasted medium"],
    specs: [
      ["Origin", "Brazil and Guatemala"],
      ["Process", "Washed and pulped natural"],
      ["Roast", "Medium"],
      ["Suggested recipe", "18 g in, 38 g out, 28 s"]
    ],
    inTheBox: ["1 kg whole-bean coffee in a one-way valve bag"],
    care: "Decant a week's worth into an airtight canister and keep the rest sealed. Best within six weeks of roast."
  },
  "machine-atelier": {
    overview: [
      "The Atelier is built by hand in small batches: a 1.8 L brew boiler and a 3 L steam boiler, each with its own PID, so shots and milk never compete.",
      "A saturated E61-style group holds temperature to half a degree, and a rotary pump lets you plumb it in or run it from the reservoir."
    ],
    highlights: [
      "Dual boilers with independent PID control",
      "Saturated group for shot-to-shot stability",
      "Quiet rotary pump, plumb-in or reservoir",
      "Pre-infusion and shot timer on the display"
    ],
    specs: [
      ["Boilers", "1.8 L brew, 3 L steam"],
      ["Pump", "Rotary vane"],
      ["Portafilter", "58 mm"],
      ["Reservoir", "3.5 L"],
      ["Power", "1,800 W, 120 V"],
      ["Body", "Brushed stainless steel, walnut accents"]
    ],
    inTheBox: ["Espresso machine", "Single and double portafilters", "Precision baskets", "Blind basket", "Plumb-in kit"],
    care: "Backflush weekly with detergent. Descale every few months unless plumbed in with a filter. Wipe the steam wand after every use."
  },
  "brewer-cadence": {
    overview: [
      "The Cadence brews a full carafe the way you'd pour it by hand: it blooms, pauses, then pulses water evenly across the bed.",
      "A single dial sets bloom time and brew strength, and a double-wall steel carafe keeps it hot without a scorching hot plate."
    ],
    highlights: ["Pulsed showerhead for even extraction", "Holds 93 °C throughout the brew", "Adjustable bloom stage", "Thermal carafe, no hot plate"],
    specs: [
      ["Capacity", "1.25 L, 2–10 cups"],
      ["Brew temperature", "92–96 °C"],
      ["Filter", "Flat-bottom, size 4"],
      ["Carafe", "Double-wall stainless steel"]
    ],
    inTheBox: ["Brewer", "Thermal carafe", "Filter basket", "Starter pack of filters"],
    care: "Rinse the basket and carafe after each brew. Descale monthly in hard-water areas."
  },
  "grinder-meridian": {
    overview: [
      "The Meridian's 83 mm flat burrs grind fast and cool, with a narrow particle spread that makes light roasts taste clear rather than sour.",
      "Stepless adjustment and a low-retention chute mean you can dial in a single dose, then swing to filter and back without waste."
    ],
    highlights: ["83 mm titanium-coated flat burrs", "Stepless micrometric adjustment", "Under 0.1 g retention", "Single-dose hopper and bellows"],
    specs: [
      ["Burrs", "83 mm flat, titanium coated"],
      ["Motor", "Variable speed, 600–1,400 rpm"],
      ["Retention", "Less than 0.1 g"],
      ["Range", "Turkish to cold brew"],
      ["Body", "Machined aluminium"]
    ],
    inTheBox: ["Grinder", "Single-dose hopper", "Dosing cup", "Cleaning brush"],
    care: "Brush out the chute weekly. Run grinder-cleaning tablets every month or two, and never grind anything but coffee."
  },
  "grinder-pocket": {
    overview: [
      "The Pocket is the grinder we take on trips: a machined body, twin bearings that keep the burrs perfectly aligned, and a dial you can set by feel.",
      "48 mm hardened steel burrs mean it grinds filter in under a minute and still manages a fine espresso when you need it."
    ],
    highlights: ["48 mm hardened steel conical burrs", "Click-free external adjustment", "Twin-bearing alignment", "Folding crank and travel case"],
    specs: [
      ["Burrs", "48 mm conical, hardened steel"],
      ["Capacity", "35 g"],
      ["Adjustment", "External dial, stepless"],
      ["Body", "Anodised aluminium"]
    ],
    inTheBox: ["Hand grinder", "Folding crank", "Travel case", "Cleaning brush"],
    care: "Brush the burrs dry after use. Don't wash it with water; take it apart to clean once a month."
  },
  "kettle-vessel": {
    overview: [
      "A good pour-over starts with a slow, steady stream. The Vessel's counterbalanced handle and narrow spout make that easy even when it's full.",
      "Set the temperature to the degree and it holds there for an hour, ready for the second cup."
    ],
    highlights: ["Temperature set and hold, 40–100 °C", "Counterbalanced walnut handle", "Precision gooseneck spout", "Brew stopwatch in the base"],
    specs: [
      ["Capacity", "0.9 L"],
      ["Power", "1,200 W"],
      ["Hold", "Up to 60 minutes"],
      ["Body", "Brushed 304 stainless steel"]
    ],
    inTheBox: ["Kettle", "Heating base"],
    care: "Empty after use and descale with citric acid once a month. Wipe the walnut handle with a dry cloth."
  },
  "scale-tare": {
    overview: [
      "The Tare weighs to a tenth of a gram and starts its timer the moment the first drop lands, so your recipes stop being guesses.",
      "Its glass top wipes clean and it's slim enough to sit on an espresso drip tray under the cup."
    ],
    highlights: ["0.1 g resolution up to 2 kg", "Auto-start shot timer", "Live flow-rate readout", "Splash-proof tempered glass top"],
    specs: [
      ["Range", "0.1–2,000 g"],
      ["Size", "15 × 15 × 1.6 cm"],
      ["Battery", "Rechargeable, USB-C"],
      ["Battery life", "About 40 hours"]
    ],
    inTheBox: ["Scale", "Heat-resistant mat", "USB-C cable"],
    care: "Wipe with a damp cloth. Don't submerge it, and keep it away from steam."
  },
  "tamper-walnut": {
    overview: [
      "An uneven tamp is the most common cause of channelling. The calibrated spring clicks at 15 kg, so every shot starts from the same puck.",
      "The base is machined to 58.5 mm for a close fit in precision baskets, on a handle turned from American walnut."
    ],
    highlights: ["Calibrated spring clicks at 15 kg", "58.5 mm flat stainless base", "Turned American walnut handle", "Fits precision 58 mm baskets"],
    specs: [
      ["Base", "58.5 mm, 304 stainless steel"],
      ["Spring", "15 kg calibrated"],
      ["Handle", "American walnut"]
    ],
    inTheBox: ["Tamper", "Linen pouch"],
    care: "Wipe the base dry after use. Oil the walnut with food-safe oil every few months."
  },
  "cups-porcelain": {
    overview: [
      "Thin walls and a tulip shape gather aroma at the rim, which is why cuppers use them. They make an everyday cortado feel like an occasion.",
      "Each cup is thrown and glazed by hand, so the matte bone finish varies slightly from cup to cup."
    ],
    highlights: ["Set of four, hand-glazed porcelain", "Tulip shape for aromatics", "Matte bone exterior, gloss interior", "Dishwasher safe"],
    specs: [
      ["Capacity", "150 ml each"],
      ["Material", "Hard-paste porcelain"],
      ["Finish", "Matte bone glaze"]
    ],
    inTheBox: ["Four tasting cups"],
    care: "Dishwasher safe on the top rack. Not for the microwave."
  }
};

export function productDetails(id: string): ProductDetails | undefined {
  return PRODUCT_DETAILS[id];
}
