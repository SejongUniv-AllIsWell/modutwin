export type PlyScalarType =
  | 'float' | 'double'
  | 'int' | 'uint'
  | 'short' | 'ushort'
  | 'char' | 'uchar';

export interface PlyProperty {
  name: string;
  type: PlyScalarType;
}

export interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

export interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  elements: PlyElement[];
  headerByteLength: number;
  comments: string[];
}

export interface GaussianScene {
  numSplats: number;
  attrs: Map<string, Float32Array>;
  propertyOrder: string[];
}

export const TYPE_SIZE: Record<PlyScalarType, number> = {
  float: 4, double: 8,
  int: 4, uint: 4,
  short: 2, ushort: 2,
  char: 1, uchar: 1,
};

export const STANDARD_3DGS_PROPS = {
  POS: ['x', 'y', 'z'] as const,
  SH_DC: ['f_dc_0', 'f_dc_1', 'f_dc_2'] as const,
  OPACITY: 'opacity',
  SCALE: ['scale_0', 'scale_1', 'scale_2'] as const,
  ROT: ['rot_0', 'rot_1', 'rot_2', 'rot_3'] as const,
};
