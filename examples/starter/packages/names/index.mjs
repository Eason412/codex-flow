// 练习起点：实现尚未满足全部契约，测试给出期望行为。
export function normalizeNames(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
