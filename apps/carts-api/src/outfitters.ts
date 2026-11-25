import type { Product } from './catalog.js';

export const OUTFITTERS: readonly Product[] = [
  {
    id: 'eddy-rolltop',
    name: 'Eddy Rolltop Dry Bag',
    category: 'Paddle',
    priceCents: 4800,
    weightGrams: 310,
    images: ['/products/eddy.svg'],
    description: 'A 12-liter dry bag for paddle days. Roll the top three times and clip it shut to keep a spare layer and lunch dry.',
  },
  {
    id: 'snack-raft',
    name: 'Snack Raft Camp Mug',
    category: 'Camp',
    priceCents: 2400,
    weightGrams: 205,
    images: ['/products/mug.svg'],
    description: 'A 350 ml enamel mug with a generous handle, made for a hot drink on a cold riverbank.',
  },
  {
    id: 'riverline-lantern',
    name: 'Riverline Mini Lantern',
    category: 'Camp',
    priceCents: 3600,
    weightGrams: 180,
    images: ['/products/lantern.svg'],
    description: 'A palm-sized, warm-light lantern with a foldaway hook. Clip it to the tent or stand it on the picnic table.',
  },
];
