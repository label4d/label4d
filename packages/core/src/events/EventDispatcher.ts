import mitt, { Emitter } from 'mitt';
import type { CoreEventMap } from './events';

export class EventDispatcher {
  private readonly emitter: Emitter<CoreEventMap>;

  constructor() {
    this.emitter = mitt<CoreEventMap>();
  }

  on<EventName extends keyof CoreEventMap>(event: EventName, handler: (event: CoreEventMap[EventName]) => void): void {
    this.emitter.on(event, handler);
  }

  off<EventName extends keyof CoreEventMap>(event: EventName, handler: (event: CoreEventMap[EventName]) => void): void {
    this.emitter.off(event, handler);
  }

  emit<EventName extends keyof CoreEventMap>(event: EventName, payload: CoreEventMap[EventName]): void {
    this.emitter.emit(event, payload);
  }
}

export const events = new EventDispatcher();
