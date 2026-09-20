import * as THREE from 'three';

/**
 * 高度/强度着色点云材质：圆点裁切 + 全局统一色域（蓝→红）。
 * 高度模式直接取世界坐标 y；强度模式读 intensity 顶点属性（数据源需有有效强度）。
 * 点尺寸为世界单位（sizeAttenuation），随距离缩小，保证分块间密度/大小平滑衔接。
 */
export interface CloudShaderOptions {
  /** 0=高度着色（世界 y），1=强度着色（intensity 顶点属性） */
  mode?: 0 | 1;
  /** 归一化范围 [min, max]，全局统一，避免分块各自计算暴露边界 */
  range?: [number, number];
  /** 点尺寸（世界单位） */
  pointSize?: number;
  /** Fixed drawing-buffer pixels, for sparse point rendering. */
  fixedPixels?: boolean;
  lowColor?: string;
  highColor?: string;
}

export function createCloudShaderMaterial(options: CloudShaderOptions = {}): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: options.mode ?? 0 },
      uRange: { value: new THREE.Vector2(...(options.range ?? [-3, 10])) },
      uFixedPixels: { value: options.fixedPixels ?? false },
      uPointSize: { value: options.pointSize ?? 0.12 },
      uLowColor: { value: new THREE.Color(options.lowColor ?? '#3a6fd8') },
      uHighColor: { value: new THREE.Color(options.highColor ?? '#e8462a') },
    },
    vertexShader: `
      attribute float intensity;

      uniform int uMode;
      uniform vec2 uRange;
      uniform float uPointSize;
      uniform bool uFixedPixels;

      varying float vT;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec4 viewPosition = viewMatrix * worldPosition;

        float value = uMode == 0 ? worldPosition.y : intensity;
        vT = clamp(
          (value - uRange.x) / max(uRange.y - uRange.x, 0.000001),
          0.0,
          1.0
        );

        gl_Position = projectionMatrix * viewPosition;
        // 世界单位点尺寸：随距离衰减，分块边界大小连续
        gl_PointSize = uFixedPixels ? uPointSize : uPointSize * (300.0 / max(-viewPosition.z, 1.0));
      }
    `,
    fragmentShader: `
      uniform vec3 uLowColor;
      uniform vec3 uHighColor;

      varying float vT;

      void main() {
        // 圆点裁切：方形点内部坐标 0~1，半径外丢弃
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        if (dot(p, p) > 1.0) discard;

        vec3 color = mix(uLowColor, uHighColor, vT);
        gl_FragColor = vec4(color, 1.0);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
  // 缺少 intensity 属性时给默认值，避免 WebGL 缺属性报错
  (material.defaultAttributeValues as Record<string, unknown>).intensity = [0];
  return material;
}
