import type { Product } from "./carts-api";

/**
 * Products matching a free-text query. Every word must appear in the name, category or description, in any case,
 * so "coffee beans" finds the beans and "grinder" finds both grinders. A word like "coffee" that the whole store
 * matches is ignored, so it never hides results.
 */
export function searchProducts(products: Product[], query: string): Product[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).filter((w) => !STORE_WORDS.has(w));
  if (words.length === 0) return query.trim() ? products : [];
  return products.filter((p) => {
    const haystack = `${p.name} ${p.category ?? ""} ${p.description ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w) || haystack.includes(singular(w)));
  });
}

// Words that describe the whole shop rather than a product.
const STORE_WORDS = new Set(["coffee", "driftbean", "the", "a", "an", "and", "for", "of", "some", "buy"]);

/** "beans" also matches "bean", "grinders" matches "grinder". */
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}
