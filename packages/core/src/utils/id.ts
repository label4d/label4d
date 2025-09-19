export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Simple fallback for environments lacking crypto.randomUUID
  return 'anno-' + Math.random().toString(36).slice(2, 10);
}
