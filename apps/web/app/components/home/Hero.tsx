import Image from "next/image";
export function Hero({ showGuestNote }: { showGuestNote: boolean }) {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1 className="text-balance">Take the river route.</h1>
        <p className="hero-lede text-pretty">
          Practical gear for paddling, campfires and the long way back.
        </p>
        <div className="hero-actions">
          <a href="#catalog-heading" className="btn btn-primary">
            Explore the gear
          </a>
        </div>
        {showGuestNote && (
          <p className="hero-note">Shop as a guest. Sign in at checkout and your cart comes with you.</p>
        )}
      </div>
      <div className="hero-media">
        <Image className="hero-img" src="/river.svg" alt="Illustration of an otter floating in a winding river below a pine-covered ridge" width={900} height={620} priority sizes="(max-width: 860px) 92vw, 600px" />
      </div>
    </section>
  );
}
