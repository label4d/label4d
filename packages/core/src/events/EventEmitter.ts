type Handler<T> = (payload: T) => void;

/**
 * Typed, instance-scoped emitter. Stores own their emitter; nothing global.
 * Handlers registered during an emit are deferred to the next emit.
 */
export class EventEmitter<E extends object> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(event: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof E>(event: K, handler: Handler<E[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      // Observers run after commit; their failure must not turn a durable commit
      // into a reported save failure or prevent other views from updating.
      try { (handler as Handler<E[K]>)(payload); }
      catch (error) { console.error('Event observer failed', event, error); }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
