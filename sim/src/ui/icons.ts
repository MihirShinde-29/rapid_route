import type { CallKind } from '../dispatch/dispatch';

// Small line icons for the call kinds (drawn here, 16 x 16 viewBox, currentColor), used in the call
// list, the map pins and the alerts.
const PATHS: Record<CallKind, string> = {
  // A medical cross.
  medical: '<path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z" fill="currentColor"/>',
  // A flame.
  fire: '<path d="M8 1c1 3 4 4.5 4 8.5A4 4 0 0 1 4 9.5C4 7 6 6.5 6 4c1.2 1 1.6 2.3 1.4 3.6C8.6 6.6 8.8 3.8 8 1z" fill="currentColor"/>',
  // A police badge (a shield with a star).
  crime: '<path d="M8 1l6 2.2V8c0 3.4-2.6 6-6 7-3.4-1-6-3.6-6-7V3.2z" fill="currentColor"/><path d="M8 4.6l1 2 2.2.3-1.6 1.5.4 2.2L8 9.6l-2 1 .4-2.2-1.6-1.5 2.2-.3z" fill="#08131c"/>',
  // Two cars meeting, with a spark.
  crash: '<path d="M1 10l1.2-3h4.2l1.4 3v3H6.5v-1h-4v1H1zM9 9l2.5-4.5L15 6.5v3L13.8 12l-1.1-.6.5-.9-3.4-2-.5.9z" fill="currentColor"/><path d="M8 2l.6 2L10 3l-.8 1.8L11 5.4 9 6l.2 1.8L8 6.6 6.8 7.8 7 6 5 5.4 6.8 4.8 6 3l1.4 1z" fill="#ffcf3a"/>',
};

export function callIcon(kind: CallKind, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('call-icon');
  svg.innerHTML = PATHS[kind];
  return svg;
}
