/**
 * Entity handles with generation counters. A handle is (index, generation);
 * destroying an entity bumps its generation so stale handles fail fast
 * instead of silently addressing a recycled entity.
 */
export type Entity = number;

export type EntityHandle = { index: number; generation: number };

interface Slot {
  generation: number;
  alive: boolean;
}

export class EntityStore {
  private slots: Slot[] = [];
  private freeList: number[] = [];
  private components = new Map<string, Map<Entity, unknown>>();

  create(): Entity {
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop() as number;
      this.slots[index].alive = true;
    } else {
      index = this.slots.length;
      this.slots.push({ generation: 1, alive: true });
    }
    return index;
  }

  handle(e: Entity): EntityHandle {
    return { index: e, generation: this.slots[e]?.generation ?? 0 };
  }

  resolve(h: EntityHandle): Entity | null {
    const slot = this.slots[h.index];
    return slot && slot.alive && slot.generation === h.generation ? h.index : null;
  }

  isAlive(e: Entity): boolean {
    return this.slots[e]?.alive === true;
  }

  destroy(e: Entity): void {
    const slot = this.slots[e];
    if (!slot || !slot.alive) return;
    slot.alive = false;
    slot.generation++;
    for (const column of this.components.values()) column.delete(e);
    this.freeList.push(e);
  }

  get count(): number {
    return this.slots.length - this.freeList.length;
  }

  addComponent<T>(name: string, e: Entity, value: T): void {
    let column = this.components.get(name);
    if (!column) {
      column = new Map();
      this.components.set(name, column);
    }
    column.set(e, value);
  }

  getComponent<T>(name: string, e: Entity): T | undefined {
    return this.components.get(name)?.get(e) as T | undefined;
  }

  removeComponent(name: string, e: Entity): void {
    this.components.get(name)?.delete(e);
  }

  query<T>(name: string): IterableIterator<[Entity, T]> {
    return this.components.get(name)?.entries() as IterableIterator<[Entity, T]>;
  }

  componentSize(name: string): number {
    return this.components.get(name)?.size ?? 0;
  }
}
