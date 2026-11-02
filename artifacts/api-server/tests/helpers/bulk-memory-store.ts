import type { OwnershipStore, QueueState, RunRecord, Transaction } from "../../src/lib/bulk-ownership";

export class MemoryStore implements OwnershipStore {
  now = 1_800_000_000_000;
  queue: QueueState = { fence: 0 };
  records = new Map<string, RunRecord>();
  attempts = new Set<number>();
  unavailable = false;
  private gate = Promise.resolve();
  async transact<T>(id: string, work: (tx: Transaction) => T): Promise<T> {
    const prior = this.gate;
    let release!: () => void;
    this.gate = new Promise(resolve => { release = resolve; });
    await prior;
    try {
      if (this.unavailable) throw new Error("Coordinator unavailable");
      const tx: Transaction = { queue: structuredClone(this.queue), record: structuredClone(this.records.get(id)), now: this.now };
      const result = work(tx);
      this.queue = tx.queue;
      if (tx.record) this.records.set(id, tx.record);
      for (const id of tx.attempts ?? []) this.attempts.add(id);
      return result;
    } finally { release(); }
  }
  async read(id?: string | string[]) {
    if (this.unavailable) throw new Error("Coordinator unavailable");
    return structuredClone({ queue: this.queue, records: [...this.records.values()].filter(r => !id || (Array.isArray(id) ? id.includes(r.run.id) : r.run.id === id)), now: this.now });
  }
  async attempted(ids: number[]) { return ids.filter(id => this.attempts.has(id)); }
}
