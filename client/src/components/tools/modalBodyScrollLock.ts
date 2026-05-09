/** Nested modals: avoid clearing body overflow while another dialog is still open. */

let bodyScrollLocks = 0;

export function lockModalBodyScroll(): void {
  bodyScrollLocks += 1;
  if (bodyScrollLocks === 1) document.body.style.overflow = "hidden";
}

export function unlockModalBodyScroll(): void {
  bodyScrollLocks = Math.max(0, bodyScrollLocks - 1);
  if (bodyScrollLocks === 0) document.body.style.overflow = "";
}
