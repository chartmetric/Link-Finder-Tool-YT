// Unit tests only. Production never falls back to this store.
export function memoryPilotCoordinator() {
  const keys = new Set();
  let total = 0;
  return {
    async claim() { return {runId:'fixture', owner:'fixture', shared:{reservedSpendCents:total,maxSpendCents:1000}}; },
    async reserve({key,cents}) {
      if (keys.has(key)) throw Error('Duplicate fixture admission');
      keys.add(key); total += cents;
      return {reservedSpendCents:total,maxSpendCents:1000};
    },
    async snapshot() { return {reservedSpendCents:total,maxSpendCents:1000}; },
  };
}
