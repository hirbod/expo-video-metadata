export async function safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export function isBlobLikeSource(source: string) {
  return source.startsWith("blob:") || source.startsWith("data:");
}

export function isLocalFileSource(source: string) {
  return source.startsWith("file:") || source.startsWith("content:");
}
