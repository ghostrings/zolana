/** Real recorded prices only. Time is the horizontal axis, price is the vertical axis. */
export function sparkPath(points: ReadonlyArray<{ at: number; price: string }> | undefined): string | null {
  const values = (points ?? []).map((p) => ({ at: p.at, price: Number(p.price) }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.at - b.at);
  if (values.length < 2) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (last.at <= first.at) return null;
  const min = Math.min(...values.map((p) => p.price));
  const max = Math.max(...values.map((p) => p.price));
  return values.map((p) => {
    const x = 2 + 156 * (p.at - first.at) / (last.at - first.at);
    const y = max === min ? 20 : 35 - 30 * (p.price - min) / (max - min);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}
