// Frame delays as [num, den] seconds, for APNG's 16-bit fcTL fields.

/** `delay` as it is when it fits 16 bits, else in lowest terms, else the nearest fraction that fits. */
export function apngDelay([num, den]) {
  den ||= 100;
  const fits = () => num <= 65535 && den <= 65535;
  if (fits()) return [num, den];
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(num, den) || 1;
  [num, den] = [num / g, den / g];
  if (fits()) return [num, den];
  const k = Math.max(num, den) / 65535;
  return [Math.min(65535, Math.round(num / k)), Math.max(1, Math.round(den / k))];
}
