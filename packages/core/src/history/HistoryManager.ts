import { events } from '../events/EventDispatcher';
import type { Command } from './Command';

export class HistoryManager {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];

  push(command: Command): void {
    command.execute();
    this.undoStack.push(command);
    this.redoStack.length = 0;
    this.emitChanges();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) {
      return;
    }
    command.undo();
    this.redoStack.push(command);
    this.emitChanges();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) {
      return;
    }
    command.execute();
    this.undoStack.push(command);
    this.emitChanges();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emitChanges();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private emitChanges(): void {
    events.emit('historyChanged', {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    });
  }
}
