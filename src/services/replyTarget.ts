export function resolveReplyTarget<T extends { id: string }>(
  requestedId: string,
  batch: Array<{ msg: T }>,
  fallback: T
): T | undefined {
  if (!requestedId) return undefined;

  const match = batch.find(item => item.msg.id === requestedId);
  return match?.msg ?? undefined;
}
