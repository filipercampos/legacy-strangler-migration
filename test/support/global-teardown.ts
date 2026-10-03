export default async function globalTeardown(): Promise<void> {
  const containers =
    (globalThis as { __containers__?: { stop(): Promise<unknown> }[] }).__containers__ ?? [];
  await Promise.all(containers.map((container) => container.stop()));
}
