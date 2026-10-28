// Flat ink field — no gradients, no dots, no mask. Purely decorative.
// (Replaces the former radial-gradient dot field, which failed inspection.)
export default function DotGridBackdrop({
  className = "",
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 bg-ink ${className}`}
    />
  );
}
