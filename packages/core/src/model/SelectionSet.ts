import { EventEmitter } from '../events/EventEmitter';

export type SelectionMode = 'replace' | 'add' | 'toggle';

/**
 * Global selection fact. Every view and panel reads this; picking anywhere
 * (3D, BEV, camera image, three-view, timeline) funnels into it.
 */
export class SelectionSet {
  readonly events = new EventEmitter<{ changed: { version: number } }>();

  private ids = new Set<string>();
  private version = 0;

  select(ids: readonly string[], mode: SelectionMode = 'replace'): boolean {
    const next = new Set(this.ids);
    let mutated = false;
    for (const id of ids) {
      if (mode === 'replace') {
        if (!next.has(id)) mutated = true;
        next.clear();
        next.add(id);
        mode = 'add';
      } else if (mode === 'add') {
        if (!next.has(id)) {
          next.add(id);
          mutated = true;
        }
      } else {
        if (next.has(id)) {
          next.delete(id);
          mutated = true;
        } else {
          next.add(id);
          mutated = true;
        }
      }
    }
    if (mode === 'replace' && next.size === 0 && this.ids.size > 0) mutated = true;
    if (!mutated) return false;
    this.ids = next;
    this.version++;
    this.events.emit('changed', { version: this.version });
    return true;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  all(): string[] {
    return [...this.ids];
  }

  get first(): string | null {
    return this.ids.values().next().value ?? null;
  }

  get size(): number {
    return this.ids.size;
  }

  get currentVersion(): number {
    return this.version;
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.version++;
    this.events.emit('changed', { version: this.version });
  }
}
