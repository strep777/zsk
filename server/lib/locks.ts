const locks = new Map<string, Promise<void>>();

export async function withResourceLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => pending);
  locks.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
