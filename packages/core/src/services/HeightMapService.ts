export class HeightMapService {
  private width = 0;
  private height = 0;
  private data: Float32Array | null = null;
  private defaultHeight = 0;

  loadFromImageData(imageData: ImageData, options?: { defaultHeight?: number }): void {
    const { width, height, data } = imageData;
    this.width = width;
    this.height = height;
    this.defaultHeight = options?.defaultHeight ?? 0;
    this.data = decodeFloat32FromBytes(data, width * height);
  }

  loadFromFloat32Array(array: Float32Array, dimensions: { width: number; height: number }, options?: { defaultHeight?: number }): void {
    const { width, height } = dimensions;
    if (array.length !== width * height) {
      throw new Error('Float array length does not match width * height');
    }
    this.width = width;
    this.height = height;
    this.defaultHeight = options?.defaultHeight ?? 0;
    this.data = new Float32Array(array);
  }

  isLoaded(): boolean {
    return Boolean(this.data);
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  sample(x: number, y: number): number {
    if (!this.data) {
      return this.defaultHeight;
    }
    const clampedX = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const clampedY = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const index = clampedY * this.width + clampedX;
    return this.data[index] ?? this.defaultHeight;
  }
}

function decodeFloat32FromBytes(bytes: Uint8ClampedArray | Uint8Array, expectedPixels: number): Float32Array {
  if (bytes.byteLength < expectedPixels * 4) {
    throw new Error('Height map source must provide 4 channels per pixel');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floats = new Float32Array(expectedPixels);
  for (let index = 0; index < expectedPixels; index += 1) {
    const byteOffset = index * 4;
    floats[index] = view.getFloat32(byteOffset, true);
  }
  return floats;
}
