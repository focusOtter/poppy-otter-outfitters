/**
 * A readable name for the signed-in customer. Auth0 sets `name` to the email address for email-and-password
 * accounts, so when there's no real name, derive one from the email: "jane.doe+shop@example.com" -> "Jane Doe".
 */
export function nameFor(user: { name?: unknown; email?: unknown; sub?: unknown }): string {
  const email = typeof user.email === "string" ? user.email : "";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  if (name && !name.includes("@")) return name;
  const local = (email || name).split("@")[0].split("+")[0];
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email || String(user.sub ?? "");
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
