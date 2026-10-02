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
    const next = mode === 'replace' ? new Set(ids) : new Set(this.ids);
    if (mode !== 'replace') for (const id of ids) {
      if (mode === 'add') next.add(id);
      else if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return false;
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
