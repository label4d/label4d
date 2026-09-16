import { EventEmitter } from '../events/EventEmitter';

export interface Command {
  readonly name: string;
  /** JSONable payload for the oplog; replay rebuilds commands from it. */
  readonly payload: unknown;
  apply(): void;
  undo(): void;
}

export interface HistoryEvents {
  changed: { canUndo: boolean; canRedo: boolean };
}

/** Groups commands into one undo step (model-assist imports, multi-edit). */
export class Transaction implements Command {
  readonly name = 'batch';
  readonly payload: unknown;
  private applied = false;

  constructor(private readonly children: Command[]) {
    this.payload = children.map((c) => ({ name: c.name, payload: c.payload }));
  }

  get size(): number {
    return this.children.length;
  }

  apply(): void {
    if (this.applied) return;
    for (const c of this.children) c.apply();
    this.applied = true;
  }

  undo(): void {
    if (!this.applied) return;
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i].undo();
    this.applied = false;
  }
}

export class History {
  readonly events = new EventEmitter<HistoryEvents>();

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private recorder: ((cmd: Command) => void) | null = null;
  limit = 2000;

  /** Called on every pushed (newly applied) command, never on undo/redo. */
  setRecorder(recorder: ((cmd: Command) => void) | null): void {
    this.recorder = recorder;
  }

  push(cmd: Command): void {
    cmd.apply();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.recorder?.(cmd);
    this.emit();
  }

  pushTransaction(children: Command[]): Transaction {
    const t = new Transaction(children);
    this.push(t);
    return t;
  }

  undo(): Command | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    this.emit();
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.apply();
    this.undoStack.push(cmd);
    this.emit();
    return cmd;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  private emit(): void {
    this.events.emit('changed', { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}

export interface OpRecord {
  seq: number;
  ts: number;
  name: string;
  payload: unknown;
}

export interface SnapshotEnvelope {
  seq: number;
  data: unknown;
}

/**
 * Append-only operation log with periodic snapshots — crash recovery and
 * audit. Recovery = restore snapshot at seq S, then apply ops with seq > S.
 */
export class OpLog {
  private records: OpRecord[] = [];
  private seq = 0;
  private snapshots: SnapshotEnvelope[] = [];
  snapshotEvery = 200;
  /** Produces a full document snapshot (wired to snapshot serialization). */
  snapshotProvider: (() => unknown) | null = null;

  record(name: string, payload: unknown): OpRecord {
    this.seq++;
    const record: OpRecord = { seq: this.seq, ts: Date.now(), name, payload };
    this.records.push(record);
    if (this.seq % this.snapshotEvery === 0 && this.snapshotProvider) {
      this.snapshots.push({ seq: this.seq, data: this.snapshotProvider() });
    }
    return record;
  }

  get latestSeq(): number {
    return this.seq;
  }

  all(): readonly OpRecord[] {
    return this.records;
  }

  snapshotsTaken(): readonly SnapshotEnvelope[] {
    return this.snapshots;
  }

  clear(): void {
    this.records = [];
    this.snapshots = [];
    this.seq = 0;
  }
}
