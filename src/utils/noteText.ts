/** Fit the actual wrapped text, using layout dimensions unaffected by canvas zoom. */
export function fitNoteText(field: HTMLTextAreaElement): void {
  if (!field.clientWidth || !field.clientHeight) return;
  if (!field.value.trim()) {
    field.style.fontSize = '14px';
    return;
  }

  let low = 8;
  let high = Math.min(96, field.clientHeight / 1.375);
  // Hide scrollbars while measuring so they cannot change the wrapping width.
  const overflow = field.style.overflow;
  field.style.overflow = 'hidden';
  while (high - low > 0.25) {
    const size = (low + high) / 2;
    field.style.fontSize = `${size}px`;
    if (field.scrollHeight <= field.clientHeight && field.scrollWidth <= field.clientWidth) low = size;
    else high = size;
  }
  field.style.fontSize = `${Math.floor(low * 4) / 4}px`;
  // Very long notes stay accessible by scrolling at the minimum font size.
  field.style.overflow = overflow;
}
