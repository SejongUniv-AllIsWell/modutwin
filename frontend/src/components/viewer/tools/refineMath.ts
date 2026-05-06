export type Vec3 = [number, number, number];
export type Color4 = [number, number, number, number];

export interface Plane {
  normal: Vec3;
  d: number;
  center: Vec3;
}

export const dot3 = (a: Vec3, b: Vec3): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

export const normalize3 = (v: Vec3): Vec3 => {
  const len = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
  if (len < 1e-8) return [0,1,0];
  return [v[0]/len, v[1]/len, v[2]/len];
};

export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1]*b[2]-a[2]*b[1],
  a[2]*b[0]-a[0]*b[2],
  a[0]*b[1]-a[1]*b[0],
];

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
export const scale3 = (v: Vec3, s: number): Vec3 => [v[0]*s, v[1]*s, v[2]*s];

export const tangentBasis = (n: Vec3): [Vec3, Vec3] => {
  const up: Vec3 = Math.abs(n[1]) < 0.9 ? [0,1,0] : [1,0,0];
  const t1 = normalize3(cross3(n, up));
  const t2 = cross3(n, t1);
  return [t1, t2];
};

export const rotateVec = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c=Math.cos(angle), s=Math.sin(angle);
  const d=dot3(v,axis);
  const cr=cross3(axis,v);
  return [
    v[0]*c+cr[0]*s+axis[0]*d*(1-c),
    v[1]*c+cr[1]*s+axis[1]*d*(1-c),
    v[2]*c+cr[2]*s+axis[2]*d*(1-c),
  ];
};

export const planeCorners = (center: Vec3, normal: Vec3, size: number): Vec3[] => {
  const [t1,t2]=tangentBasis(normal);
  return [
    add3(add3(center, scale3(t1,-size)), scale3(t2,-size)),
    add3(add3(center, scale3(t1, size)), scale3(t2,-size)),
    add3(add3(center, scale3(t1, size)), scale3(t2, size)),
    add3(add3(center, scale3(t1,-size)), scale3(t2, size)),
  ];
};

function symmetricEigen3x3(mat: number[][]): { values: number[]; vectors: number[][] } {
  const a = mat.map(r => [...r]);
  const v = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter=0; iter<30; iter++) {
    let maxVal=0, p=0, q=1;
    for (let i=0;i<3;i++) for (let j=i+1;j<3;j++) {
      if (Math.abs(a[i][j])>maxVal) { maxVal=Math.abs(a[i][j]); p=i; q=j; }
    }
    if (maxVal < 1e-12) break;
    const apq=a[p][q];
    const diff=a[p][p]-a[q][q];
    let t: number;
    if (Math.abs(diff)<1e-12) t = apq>0 ? 1 : -1;
    else { const phi=diff/(2*apq); t=1/(Math.abs(phi)+Math.sqrt(phi*phi+1)); if (phi<0) t=-t; }
    const c=1/Math.sqrt(t*t+1), s=t*c, tau=s/(1+c);
    a[p][p]-=t*apq; a[q][q]+=t*apq; a[p][q]=0; a[q][p]=0;
    for (let r=0;r<3;r++) {
      if (r===p||r===q) continue;
      const arp=a[r][p], arq=a[r][q];
      a[r][p]=a[p][r]=arp - s*(arq + tau*arp);
      a[r][q]=a[q][r]=arq + s*(arp - tau*arq);
    }
    for (let r=0;r<3;r++) {
      const vrp=v[r][p], vrq=v[r][q];
      v[r][p]=vrp - s*(vrq + tau*vrp);
      v[r][q]=vrq + s*(vrp - tau*vrq);
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

export const pcaNormal = (positions: Vec3[]): Vec3 => {
  const n=positions.length;
  const mean: Vec3=[0,0,0];
  for (const p of positions) { mean[0]+=p[0]; mean[1]+=p[1]; mean[2]+=p[2]; }
  mean[0]/=n; mean[1]/=n; mean[2]/=n;
  const cov=[[0,0,0],[0,0,0],[0,0,0]];
  for (const p of positions) {
    const d=[p[0]-mean[0], p[1]-mean[1], p[2]-mean[2]];
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) cov[i][j]+=d[i]*d[j];
  }
  const { values, vectors } = symmetricEigen3x3(cov);
  const minIdx = values[0] <= values[1] && values[0] <= values[2] ? 0 : values[1] <= values[2] ? 1 : 2;
  return normalize3([vectors[0][minIdx], vectors[1][minIdx], vectors[2][minIdx]]);
};

export const computeCellCodes = (posX: Float32Array, posY: Float32Array, posZ: Float32Array, n: number, planes: Plane[]): Uint32Array => {
  const codes = new Uint32Array(n);
  for (let i=0;i<n;i++) {
    let code=0;
    for (let p=0;p<planes.length;p++) {
      const { normal, d } = planes[p];
      if (normal[0]*posX[i]+normal[1]*posY[i]+normal[2]*posZ[i] > d) code |= (1<<p);
    }
    codes[i]=code;
  }
  return codes;
};

export const findKeepCell = (codes: Uint32Array): number => {
  const counts = new Map<number, number>();
  for (let i=0;i<codes.length;i++) counts.set(codes[i], (counts.get(codes[i])??0)+1);
  let best=0, bestC=0;
  counts.forEach((c,k)=>{ if (c>bestC){bestC=c;best=k;} });
  return best;
};

export const isClosed = (keepCell: number, numPlanes: number): boolean => numPlanes >= 4 && keepCell === 0;

export const WORLD_AXES: Vec3[] = [[1,0,0],[0,1,0],[0,0,1]];
export const AXIS_COLORS: Color4[] = [[1,0.3,0.3,1],[0.3,1,0.3,1],[0.4,0.6,1,1]];
export const AXIS_COLORS_DIM: Color4[] = [[0.5,0.15,0.15,0.5],[0.15,0.5,0.15,0.5],[0.2,0.3,0.5,0.5]];
export const RING_SEGMENTS = 48;
export const RING_PICK_PX = 18;
