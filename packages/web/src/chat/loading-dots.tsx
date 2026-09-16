// Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine.
// MIT license in ../../licenses/beautiful-ui-MIT.txt.
const delays = [90, 180, 270, 0, 90, 180, 90, 180, 270];

export function LoadingDots() {
  return (
    <span aria-hidden="true" className="loading-dots">
      {delays.map((delay, index) => (
        <span key={index} style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}
