import type { GaussianScene, PlyHeader, PlyScalarType } from './types';
import { TYPE_SIZE } from './types';

const TYPE_ALIASES: Record<string, PlyScalarType> = {
  float: 'float', float32: 'float',
  double: 'double', float64: 'double',
  int: 'int', int32: 'int',
  uint: 'uint', uint32: 'uint',
  short: 'short', int16: 'short',
  ushort: 'ushort', uint16: 'ushort',
  char: 'char', int8: 'char',
  uchar: 'uchar', uint8: 'uchar',
};

export function parsePlyHeader(buffer: ArrayBuffer): PlyHeader {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const lines: string[] = [];
  let lineStart = 0;
  let headerEnd = -1;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    const line = decoder.decode(bytes.subarray(lineStart, i));
    lines.push(line);
    lineStart = i + 1;
    if (line.trim() === 'end_header') {
      headerEnd = lineStart;
      break;
    }
  }
  if (headerEnd < 0) throw new Error('PLY: end_header not found');
  if (lines[0].trim() !== 'ply') throw new Error('PLY: missing "ply" magic');

  let format: PlyHeader['format'] = 'binary_little_endian';
  const elements: PlyHeader['elements'] = [];
  const comments: string[] = [];
  let current: PlyHeader['elements'][number] | null = null;

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('format ')) {
      const f = line.split(/\s+/)[1];
      if (f !== 'ascii' && f !== 'binary_little_endian' && f !== 'binary_big_endian') {
        throw new Error(`PLY: unsupported format "${f}"`);
      }
      format = f;
    } else if (line.startsWith('comment ')) {
      comments.push(line.slice('comment '.length));
    } else if (line.startsWith('element ')) {
      if (current) elements.push(current);
      const parts = line.split(/\s+/);
      current = { name: parts[1], count: parseInt(parts[2], 10), properties: [] };
    } else if (line.startsWith('property ')) {
      if (!current) throw new Error('PLY: property before element');
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') throw new Error('PLY: list properties not supported');
      const type = TYPE_ALIASES[parts[1]];
      if (!type) throw new Error(`PLY: unknown type "${parts[1]}"`);
      current.properties.push({ type, name: parts[2] });
    } else if (line === 'end_header') {
      if (current) { elements.push(current); current = null; }
      break;
    }
  }

  return { format, elements, headerByteLength: headerEnd, comments };
}

export function parsePly(buffer: ArrayBuffer): GaussianScene {
  const header = parsePlyHeader(buffer);
  if (header.format === 'ascii') throw new Error('PLY: ASCII not supported');
  if (header.format === 'binary_big_endian') throw new Error('PLY: big-endian not supported');

  const vertex = header.elements.find(e => e.name === 'vertex');
  if (!vertex) throw new Error('PLY: missing "vertex" element');

  const N = vertex.count;
  const props = vertex.properties;
  const stride = props.reduce((s, p) => s + TYPE_SIZE[p.type], 0);
  const bodyLen = N * stride;
  if (header.headerByteLength + bodyLen > buffer.byteLength) {
    throw new Error('PLY: buffer too short for declared vertex count');
  }

  const attrs = new Map<string, Float32Array>();
  for (const p of props) attrs.set(p.name, new Float32Array(N));

  const allFloat = props.every(p => p.type === 'float');
  if (allFloat) {
    // 빠른 경로: 전 속성 float32. 헤더 오프셋이 4의 배수라는 보장이 없으므로
    // body 영역만 slice 해서 독립 버퍼로 복사 후 typed-array view 생성.
    const bodyBuffer = buffer.slice(header.headerByteLength, header.headerByteLength + bodyLen);
    const src = new Float32Array(bodyBuffer);
    const numProps = props.length;
    const arrays = props.map(p => attrs.get(p.name)!);
    for (let i = 0; i < N; i++) {
      const base = i * numProps;
      for (let j = 0; j < numProps; j++) arrays[j][i] = src[base + j];
    }
  } else {
    const view = new DataView(buffer, header.headerByteLength, bodyLen);
    const offsets: number[] = [];
    {
      let o = 0;
      for (const p of props) { offsets.push(o); o += TYPE_SIZE[p.type]; }
    }
    for (let i = 0; i < N; i++) {
      const rowOff = i * stride;
      for (let j = 0; j < props.length; j++) {
        const p = props[j];
        const off = rowOff + offsets[j];
        const arr = attrs.get(p.name)!;
        switch (p.type) {
          case 'float':  arr[i] = view.getFloat32(off, true); break;
          case 'double': arr[i] = view.getFloat64(off, true); break;
          case 'int':    arr[i] = view.getInt32(off, true); break;
          case 'uint':   arr[i] = view.getUint32(off, true); break;
          case 'short':  arr[i] = view.getInt16(off, true); break;
          case 'ushort': arr[i] = view.getUint16(off, true); break;
          case 'char':   arr[i] = view.getInt8(off); break;
          case 'uchar':  arr[i] = view.getUint8(off); break;
        }
      }
    }
  }

  return { numSplats: N, attrs, propertyOrder: props.map(p => p.name) };
}

export async function fetchAndParsePly(url: string): Promise<GaussianScene> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`PLY fetch failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return parsePly(buf);
}
