// CSS-only hero dot field — no canvas, no JS, no animation.
// Amber dots at 10% alpha on a 24px pitch, fading out toward the fold.
// pointer-events-none + aria-hidden: purely decorative, never intercepts clicks.
export default function DotGridBackdrop({
  className = "",
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{
        backgroundImage:
          "radial-gradient(rgba(245,158,11,0.10) 1.5px, transparent 1.5px)",
        backgroundSize: "24px 24px",
        maskImage:
          "linear-gradient(to bottom, black 0%, black 55%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, black 0%, black 55%, transparent 100%)",
      }}
    />
  );
}
