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
  failed: { error: unknown };
}

/** Groups commands into one undo step (model-assist imports, multi-edit). */
export class Transaction implements Command {
  readonly name = 'batch';
  readonly payload: { children: Array<{ name: string; payload: unknown }> };
  private applied = false;

  constructor(private readonly children: Command[]) {
    this.payload = { children: children.map((c) => ({ name: c.name, payload: c.payload })) };
  }

  get size(): number {
    return this.children.length;
  }

  apply(): void {
    if (this.applied) return;
    const completed: Command[] = [];
    try {
      for (const c of this.children) { c.apply(); completed.push(c); }
      this.applied = true;
    } catch (error) {
      for (const c of completed.reverse()) c.undo();
      throw error;
    }
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
  private recorder: ((cmd: Command, action: 'apply' | 'undo' | 'redo') => void) | null = null;
  private atomic: (fn: () => void) => void = (fn) => fn();

  setAtomic(atomic: (fn: () => void) => void): void { this.atomic = atomic; }
  limit = 2000;
  pending = false;
  private committer: ((cmd: Command, action: 'apply' | 'undo' | 'redo') => Promise<Command>) | null = null;
  private lastCommit: Promise<void> = Promise.resolve();
  private retry: (() => void) | null = null;
  setCommitter(committer: typeof this.committer): void { this.committer = committer; }
  whenIdle(): Promise<void> { return this.lastCommit; }
  restore(undo: Command[], redo: Command[]): void {
    if (this.pending) throw new Error('Cannot restore a saving history');
    this.undoStack = undo; this.redoStack = redo; this.emit();
  }
  retryFailed(): void { this.retry?.(); }

  private execute(cmd: Command, action: 'apply' | 'undo' | 'redo', accept: (cmd: Command) => void): void {
    if (this.pending) throw new Error('An edit is still being saved');
    if (!this.committer) {
      this.atomic(() => { if (action === 'undo') cmd.undo(); else cmd.apply(); this.recorder?.(cmd, action); });
      accept(cmd); this.emit(); return;
    }
    this.pending = true; this.retry = null; this.emit();
    this.lastCommit = this.committer(cmd, action).then((committed) => { accept(committed); }).catch((error) => {
      this.retry = () => this.execute(cmd, action, accept);
      this.events.emit('failed', { error }); throw error;
    }).finally(() => { this.pending = false; this.emit(); });
    // UI callers may intentionally fire and forget; errors are also exposed through whenIdle().
    void this.lastCommit.catch(() => {});
  }

  /** Records every logical edit, including undo/redo, inside the commit boundary. */
  setRecorder(recorder: ((cmd: Command, action: 'apply' | 'undo' | 'redo') => void) | null): void {
    this.recorder = recorder;
  }

  push(cmd: Command): void {
    this.execute(cmd, 'apply', (committed) => {
      this.undoStack.push(committed);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    });
  }

  pushTransaction(children: Command[]): Transaction {
    const t = new Transaction(children);
    this.push(t);
    return t;
  }

  undo(): Command | null {
    const cmd = this.undoStack[this.undoStack.length - 1];
    if (!cmd) return null;
    this.execute(cmd, 'undo', () => { this.undoStack.pop(); this.redoStack.push(cmd); });
    return cmd;
  }
  redo(): Command | null {
    const cmd = this.redoStack[this.redoStack.length - 1];
    if (!cmd) return null;
    this.execute(cmd, 'redo', () => { this.redoStack.pop(); this.undoStack.push(cmd); });
    return cmd;
  }

  get canUndo(): boolean {
    return !this.pending && this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return !this.pending && this.redoStack.length > 0;
  }

  clear(): void {
    if (this.pending) throw new Error('Cannot clear a saving history');
    this.retry = null;
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
  action: 'apply' | 'undo' | 'redo';
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

  record(name: string, payload: unknown, action: OpRecord['action'] = 'apply'): OpRecord {
    this.seq++;
    const record: OpRecord = { seq: this.seq, ts: Date.now(), name, payload: structuredClone(payload), action };
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
