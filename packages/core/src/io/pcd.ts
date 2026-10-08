export interface PointCloudFrame {
  positions: Float32Array; // xyz triplets
  intensity: Float32Array | null;
  /** per-point RGB, 3 bytes/point (0-255), null when the cloud has no color */
  rgb: Uint8Array | null;
  /** Official source point-to-pixel references: two (cameraId,u,v) triples per point. */
  cameraReferences?: Int32Array;
  count: number;
}

interface FieldLayout {
  name: string;
  offset: number;
  size: number;
  type: 'I' | 'U' | 'F';
}

/** PCL packs RGB as 0xRRGGBB (or 0xAARRGGBB for rgba) in a 32-bit slot. */
function unpackRgb(u: number, out: Uint8Array, o: number): void {
  out[o] = (u >> 16) & 0xff;
  out[o + 1] = (u >> 8) & 0xff;
  out[o + 2] = u & 0xff;
}

const FIELD_RE = /\s+/;

/**
 * Parses binary and ascii PCD (PCL) frames. `binary_compressed` is rejected
 * with an explicit error — pre-convert those (pcl_convert_pcd_ascii_binary).
 */
export function parsePcd(data: ArrayBuffer | Uint8Array): PointCloudFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 8) throw new Error('PCD: file too small');

  const probe = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const lines = probe.split(/\r?\n/);
  let fields: string[] = [];
  let sizes: number[] = [];
  let types: string[] = [];
  let pointCount = 0;
  let dataMode = '';
  let headerEnd = 0;

  for (const line of lines) {
    headerEnd += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(FIELD_RE);
    const key = parts[0].toUpperCase();
    if (key === 'FIELDS') fields = parts.slice(1);
    else if (key === 'SIZE') sizes = parts.slice(1).map(Number);
    else if (key === 'TYPE') types = parts.slice(1) as ('I' | 'U' | 'F')[];
    else if (key === 'POINTS') pointCount = parseInt(parts[1], 10) || 0;
    else if (key === 'DATA') {
      dataMode = (parts[1] || '').toLowerCase();
      break;
    }
  }
  if (!fields.length || !dataMode) throw new Error('PCD: malformed header');
  if (dataMode === 'binary_compressed') {
    throw new Error('PCD: binary_compressed unsupported; convert to DATA binary');
  }
  if (headerEnd > bytes.length) throw new Error('PCD: header larger than file');

  const xAt = fields.indexOf('x');
  const yAt = fields.indexOf('y');
  const zAt = fields.indexOf('z');
  const iAt = fields.indexOf('intensity');
  const rgbAt = fields.findIndex((f) => f === 'rgb' || f === 'rgba');
  const rAt = fields.indexOf('r');
  const gAt = fields.indexOf('g');
  const bAt = fields.indexOf('b');
  const hasSplitRgb = rAt >= 0 && gAt >= 0 && bAt >= 0;
  if (xAt < 0 || yAt < 0 || zAt < 0) throw new Error('PCD: missing x/y/z fields');

  const layouts: FieldLayout[] = [];
  let stride = 0;
  for (let i = 0; i < fields.length; i++) {
    const size = sizes[i] ?? 4;
    layouts.push({ name: fields[i], offset: stride, size, type: (types[i] ?? 'F') as 'I' | 'U' | 'F' });
    stride += size;
  }

  const positions = new Float32Array(pointCount * 3);
  const intensity = iAt >= 0 ? new Float32Array(pointCount) : null;
  const rgb = rgbAt >= 0 || hasSplitRgb ? new Uint8Array(pointCount * 3) : null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readField = (layout: FieldLayout, base: number): number => {
    const off = base + layout.offset;
    if (layout.type === 'F') {
      return layout.size === 4 ? view.getFloat32(off, true) : view.getFloat64(off, true);
    }
    if (layout.type === 'U') {
      return layout.size === 1
        ? view.getUint8(off)
        : layout.size === 2
          ? view.getUint16(off, true)
          : view.getUint32(off, true);
    }
    return layout.size === 1
      ? view.getInt8(off)
      : layout.size === 2
        ? view.getInt16(off, true)
        : view.getInt32(off, true);
  };

  let written = 0;
  if (dataMode === 'binary') {
    for (let p = 0; p < pointCount; p++) {
      const base = headerEnd + p * stride;
      if (base + stride > bytes.byteLength) break;
      positions[p * 3] = readField(layouts[xAt], base);
      positions[p * 3 + 1] = readField(layouts[yAt], base);
      positions[p * 3 + 2] = readField(layouts[zAt], base);
      if (intensity) intensity[p] = readField(layouts[iAt], base);
      if (rgb) {
        if (rgbAt >= 0) {
          // packed value: read the raw 32-bit pattern regardless of F/U declaration
          unpackRgb(view.getUint32(base + layouts[rgbAt].offset, true), rgb, p * 3);
        } else {
          rgb[p * 3] = readField(layouts[rAt], base) & 0xff;
          rgb[p * 3 + 1] = readField(layouts[gAt], base) & 0xff;
          rgb[p * 3 + 2] = readField(layouts[bAt], base) & 0xff;
        }
      }
      written++;
    }
  } else {
    const body = new TextDecoder('ascii').decode(bytes.subarray(headerEnd));
    const scratch = new DataView(new ArrayBuffer(4));
    const f32ToBits = (value: number): number => {
      scratch.setFloat32(0, value, true);
      return scratch.getUint32(0, true);
    };
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(FIELD_RE);
      const values = parts.map(Number);
      if (parts.length < fields.length) continue;
      positions[written * 3] = values[xAt];
      positions[written * 3 + 1] = values[yAt];
      positions[written * 3 + 2] = values[zAt];
      if (intensity) intensity[written] = values[iAt];
      if (rgb) {
        if (rgbAt >= 0) {
          // ascii prints the packed value as a float (bit-pattern reinterpreted)
          unpackRgb(f32ToBits(values[rgbAt]), rgb, written * 3);
        } else {
          rgb[written * 3] = values[rAt] & 0xff;
          rgb[written * 3 + 1] = values[gAt] & 0xff;
          rgb[written * 3 + 2] = values[bAt] & 0xff;
        }
      }
      written++;
      if (written >= pointCount) break;
    }
  }

  return {
    positions,
    intensity,
    rgb,
    count: written,
  };
}
