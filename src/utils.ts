export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new RangeError("chunk size must be positive");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
