import { events } from '../events/EventDispatcher';

interface HighlightState {
  mode: 'flash' | 'pulse';
  active: boolean;
}

export class HighlightService {
  private readonly states = new Map<string, HighlightState>();

  setActive(ids: string[], mode: 'flash' | 'pulse', active: boolean): void {
    for (const id of ids) {
      this.states.set(id, { mode, active });
    }
    if (ids.length > 0) {
      events.emit('highlightChanged', { ids: [...ids], active, mode });
    }
  }

  isActive(ids: string[], mode: 'flash' | 'pulse'): boolean {
    if (ids.length === 0) {
      return false;
    }
    return ids.every((id) => {
      const state = this.states.get(id);
      return state?.active === true && state.mode === mode;
    });
  }

  getStates(): Record<string, HighlightState> {
    return Object.fromEntries(this.states.entries());
  }
}
