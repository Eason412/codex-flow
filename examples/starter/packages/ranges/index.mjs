// 练习起点：实现尚未满足全部契约，测试给出期望行为。
export function intersectRanges(a, b) {
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return start <= end ? [start, end] : null;
}
