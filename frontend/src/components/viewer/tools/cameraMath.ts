export const DEG2RAD = Math.PI / 180;

export function _half2Float(h: number): number {
  const s = (h >> 15) & 0x1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) {
    if (m === 0) return s ? -0 : 0;
    return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
  }
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

export const calcForwardVec = (azimuthDeg: number, elevationDeg: number) => {
  const ex = elevationDeg * DEG2RAD;
  const ey = azimuthDeg * DEG2RAD;
  const s1 = Math.sin(-ex);
  const c1 = Math.cos(-ex);
  const s2 = Math.sin(-ey);
  const c2 = Math.cos(-ey);
  return { x: -c1 * s2, y: s1, z: c1 * c2 };
};

export const getLookDir = (azimuthDeg: number, elevationDeg: number) => {
  const f = calcForwardVec(azimuthDeg, elevationDeg);
  return { x: -f.x, y: -f.y, z: -f.z };
};

export const getRightDir = (azimuthDeg: number) => {
  const ey = azimuthDeg * DEG2RAD;
  return { x: Math.cos(ey), y: 0, z: -Math.sin(ey) };
};
