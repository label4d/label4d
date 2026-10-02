import * as THREE from 'three';
import type { TrackStore } from '../model/TrackStore';
import type { SelectionSet } from '../model/SelectionSet';
import type { LabelDef } from '../model/types';
import { colorForLabel, TextBadge } from './shared';

export interface BadgeOptions {
  /** show badges for all active tracks (declutter off); else selected+hover only */
  showAll: boolean;
}

/**
 * In-view attribute labels ("Car #0042 color=red"), rendered as canvas-texture
 * sprites above each box. Density rule: selected + hovered always visible;
 * everything else only when showAll is enabled. Click-to-edit: the UI
 * raycasts `pick()` and opens a schema-driven editor anchored to the badge.
 */
export class AttributeBadgeRenderer {
  readonly group = new THREE.Group();

  private badges = new Map<string, TextBadge>();
  private lastKey = '';

  constructor(private readonly labels: LabelDef[]) {
    this.options = { showAll: false };
  }

  private options: BadgeOptions;

  setOptions(options: Partial<BadgeOptions>): void {
    this.options = { ...this.options, ...options };
  }

  sync(frame: number, store: TrackStore, selection: SelectionSet, hoverId: string | null, hiddenLabels?: Set<string>): void {
    const key = `${frame}:${store.currentVersion}:${selection.currentVersion}:${hoverId ?? ''}:${this.options.showAll}:${hiddenLabels ? [...hiddenLabels].sort().join(',') : ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const active = store.activeTrackIds(frame);
    const wanted = new Set(
      active.filter((id) => {
        if (!(this.options.showAll || selection.has(id) || hoverId === id)) return false;
        if (hiddenLabels && hiddenLabels.has(store.getTrack(id)?.meta.label ?? '')) return false;
        return true;
      })
    );

    for (const [id, badge] of this.badges) {
      if (!wanted.has(id)) {
        this.group.remove(badge.sprite);
        badge.dispose();
        this.badges.delete(id);
      }
    }

    for (const id of wanted) {
      const state = store.resolveState(id, frame);
      const record = store.getTrack(id);
      if (!state || !record) continue;
      let badge = this.badges.get(id);
      if (!badge) {
        badge = new TextBadge();
        this.badges.set(id, badge);
        this.group.add(badge.sprite);
      }
      badge.sprite.position.set(state.pos.x, state.pos.y + state.size.y / 2 + 0.9, state.pos.z);
      const attrEntries = Object.entries(record.meta.attributes).slice(0, 2);
      const attrText = attrEntries.map(([k, v]) => `${k}=${v}`).join(' ');
      badge.setText(`${record.meta.label}·${id.slice(-4)}${attrText ? ' ' + attrText : ''}`, colorForLabel(this.labels, record.meta.label));
    }
  }

  /** Raycast badge sprites; returns the owning track id. */
  pick(raycaster: THREE.Raycaster): string | null {
    const sprites = [...this.badges.entries()].map(([id, badge]) => ({ id, sprite: badge.sprite }));
    const hits = raycaster.intersectObjects(
      sprites.map((s) => s.sprite),
      false
    );
    for (const hit of hits) {
      const found = sprites.find((s) => s.sprite === hit.object);
      if (found) return found.id;
    }
    return null;
  }

  dispose(): void {
    for (const badge of this.badges.values()) badge.dispose();
    this.badges.clear();
  }
}
