/**
 * Indica's brand mark — "Ascend".
 *
 * An upward chevron with a detached spark above it: the sense of rising
 * understanding, of being guided up to the next step. Built from two simple
 * shapes so it registers instantly and survives shrinking to a favicon
 * (cognitive-fluency + scalability), and in the tile lockup the glyph is true
 * negative space knocked out of the gradient — Gestalt closure lets the eye
 * complete it, which is what makes a mark engaging rather than inert.
 *
 * Two exports:
 *  - LogoMark: the monoline glyph in `currentColor`, for use on a surface.
 *  - LogoTile: the app-icon lockup — a gradient squircle with the glyph cut out.
 */

/**
 * The "INDICA" wordmark: a display serif set in all-caps with wide letter-
 * spacing — the hallmark of a luxury logotype, where the generous tracking lets
 * each letterform breathe and reads as crafted rather than typed. The initial
 * "I" is isolated in the brand's amber→orange gradient: the Von Restorff
 * (isolation) effect — a single element set apart by colour is recalled better
 * than its neighbours — anchoring the name in memory and tying it to the logo.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={
        "[font-family:var(--font-display),serif] font-medium uppercase tracking-[0.2em] text-[#2b2017] " + className
      }
    >
      <span className="bg-linear-to-br from-amber-500 to-orange-600 bg-clip-text text-transparent">I</span>
      ndica
    </span>
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 34" fill="none" className={className} aria-hidden>
      <path
        d="M8 26 L24 12 L40 26"
        stroke="currentColor"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="5" r="3.2" fill="currentColor" />
    </svg>
  );
}

export function LogoTile({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <defs>
        <linearGradient id="indica-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fbbf24" />
          <stop offset="1" stopColor="#ea580c" />
        </linearGradient>
        {/* White = kept, black = cut away. The glyph becomes a real hole. */}
        <mask id="indica-mask">
          <rect width="48" height="48" fill="white" />
          <path
            d="M12 35 L24 24 L36 35"
            fill="none"
            stroke="black"
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="24" cy="15.5" r="3" fill="black" />
        </mask>
      </defs>
      <rect width="48" height="48" fill="url(#indica-grad)" mask="url(#indica-mask)" />
    </svg>
  );
}
