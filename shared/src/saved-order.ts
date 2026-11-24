export function orderBySavedIds<T>(
  items: readonly T[],
  savedIds: readonly string[] | undefined,
  getId: (item: T) => string,
  { newItemsFirst = false }: { newItemsFirst?: boolean } = {},
): T[] {
  if (!savedIds?.length) return [...items];
  const byId = new Map(items.map((item) => [getId(item), item]));
  const saved = savedIds.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    byId.delete(id);
    return [item];
  });
  const remaining = [...byId.values()];
  return newItemsFirst ? [...remaining, ...saved] : [...saved, ...remaining];
}
