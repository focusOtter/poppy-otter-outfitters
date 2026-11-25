import Link from "next/link";

export type Chip = { label: string; href: string; current: boolean };

export function FilterChips({ label, chips }: { label: string; chips: Chip[] }) {
  return (
    <nav className="chips" aria-label={label}>
      {chips.map((c) => (
        <Link key={c.href} href={c.href} className="chip" aria-current={c.current ? "page" : undefined}>
          {c.label}
        </Link>
      ))}
    </nav>
  );
}
