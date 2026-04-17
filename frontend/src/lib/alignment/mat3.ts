// 3x3 행렬 / 벡터 연산 (row-major, Float64Array 9개 요소).
// Kabsch 정렬에 필요한 최소 유틸만 포함.

export type Mat3 = Float64Array;
export type Vec3 = [number, number, number];

export function mat3Create(): Mat3 { return new Float64Array(9); }
export function mat3Identity(out: Mat3): Mat3 {
  out[0]=1; out[1]=0; out[2]=0; out[3]=0; out[4]=1; out[5]=0; out[6]=0; out[7]=0; out[8]=1;
  return out;
}
export function mat3Copy(out: Mat3, a: Mat3): Mat3 { out.set(a); return out; }

// out = a * b
export function mat3Mul(out: Mat3, a: Mat3, b: Mat3): Mat3 {
  const a00=a[0],a01=a[1],a02=a[2],a10=a[3],a11=a[4],a12=a[5],a20=a[6],a21=a[7],a22=a[8];
  const b00=b[0],b01=b[1],b02=b[2],b10=b[3],b11=b[4],b12=b[5],b20=b[6],b21=b[7],b22=b[8];
  out[0]=a00*b00+a01*b10+a02*b20; out[1]=a00*b01+a01*b11+a02*b21; out[2]=a00*b02+a01*b12+a02*b22;
  out[3]=a10*b00+a11*b10+a12*b20; out[4]=a10*b01+a11*b11+a12*b21; out[5]=a10*b02+a11*b12+a12*b22;
  out[6]=a20*b00+a21*b10+a22*b20; out[7]=a20*b01+a21*b11+a22*b21; out[8]=a20*b02+a21*b12+a22*b22;
  return out;
}
export function mat3Transpose(out: Mat3, a: Mat3): Mat3 {
  const a01=a[1],a02=a[2],a12=a[5];
  out[0]=a[0]; out[4]=a[4]; out[8]=a[8];
  out[1]=a[3]; out[2]=a[6]; out[3]=a01;
  out[5]=a[7]; out[6]=a02; out[7]=a12;
  return out;
}
export function mat3Det(a: Mat3): number {
  return a[0]*(a[4]*a[8]-a[5]*a[7]) - a[1]*(a[3]*a[8]-a[5]*a[6]) + a[2]*(a[3]*a[7]-a[4]*a[6]);
}
export function mat3MulVec(out: Vec3, m: Mat3, v: Vec3): Vec3 {
  const x=v[0],y=v[1],z=v[2];
  out[0] = m[0]*x + m[1]*y + m[2]*z;
  out[1] = m[3]*x + m[4]*y + m[5]*z;
  out[2] = m[6]*x + m[7]*y + m[8]*z;
  return out;
}

// 대칭 3x3 행렬의 고유값/고유벡터. Jacobi 회전 반복.
// 입력 A는 파괴되지 않음. V에 고유벡터(열벡터), eig에 고유값(내림차순).
// A = V * diag(eig) * V^T.
export function eigenSym3(A: Mat3, V: Mat3, eig: Float64Array): void {
  // 작업용 복사본 (대칭이므로 상삼각만 사용)
  let a00=A[0], a01=A[1], a02=A[2];
  let a11=A[4], a12=A[5];
  let a22=A[8];

  // V = I
  let v00=1,v01=0,v02=0;
  let v10=0,v11=1,v12=0;
  let v20=0,v21=0,v22=1;

  const MAX_ITER = 40;
  const EPS = 1e-14;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const off = Math.abs(a01) + Math.abs(a02) + Math.abs(a12);
    if (off < EPS) break;

    // 가장 큰 off-diagonal 선택
    let p = 0, q = 1;
    let maxAbs = Math.abs(a01);
    if (Math.abs(a02) > maxAbs) { p=0; q=2; maxAbs = Math.abs(a02); }
    if (Math.abs(a12) > maxAbs) { p=1; q=2; maxAbs = Math.abs(a12); }

    // (p,q)에 해당하는 2x2 블록 대각화
    const app = p===0?a00:p===1?a11:a22;
    const aqq = q===0?a00:q===1?a11:a22;
    const apq = p===0 && q===1 ? a01 : p===0 && q===2 ? a02 : a12;

    if (Math.abs(apq) < EPS) continue;

    const theta = (aqq - app) / (2 * apq);
    const t = theta >= 0
      ? 1 / (theta + Math.sqrt(1 + theta*theta))
      : 1 / (theta - Math.sqrt(1 + theta*theta));
    const c = 1 / Math.sqrt(1 + t*t);
    const s = t * c;

    // 대각선 업데이트
    const appNew = app - t*apq;
    const aqqNew = aqq + t*apq;
    // off-diagonal (p,q) → 0
    // 다른 off-diagonal은 (p,q) 이외의 축 r에 대해 업데이트
    // r은 p,q가 아닌 유일한 인덱스.
    const r = (p===0 && q===1) ? 2 : (p===0 && q===2) ? 1 : 0;

    // a[p,r], a[q,r] 업데이트
    const apr = p===0 && r===1 ? a01 : p===0 && r===2 ? a02 : p===1 && r===0 ? a01 : p===1 && r===2 ? a12 : p===2 && r===0 ? a02 : a12;
    const aqr = q===0 && r===1 ? a01 : q===0 && r===2 ? a02 : q===1 && r===0 ? a01 : q===1 && r===2 ? a12 : q===2 && r===0 ? a02 : a12;

    const aprNew = c*apr - s*aqr;
    const aqrNew = s*apr + c*aqr;

    // 대입
    if (p===0) a00 = appNew; else if (p===1) a11 = appNew; else a22 = appNew;
    if (q===0) a00 = aqqNew; else if (q===1) a11 = aqqNew; else a22 = aqqNew;

    if (p===0 && q===1) a01 = 0;
    else if (p===0 && q===2) a02 = 0;
    else a12 = 0;

    // (p,r), (q,r) 대응 원소 갱신
    const setSym = (i: number, j: number, v: number) => {
      const ii = Math.min(i,j), jj = Math.max(i,j);
      if (ii===0 && jj===1) a01 = v;
      else if (ii===0 && jj===2) a02 = v;
      else if (ii===1 && jj===2) a12 = v;
    };
    setSym(p, r, aprNew);
    setSym(q, r, aqrNew);

    // V = V * R(p,q,c,s)
    // R은 (p,q) 평면에서 회전. V의 p,q 열을 업데이트.
    const getVcol = (col: number, row: number) => {
      if (col===0) return row===0?v00:row===1?v10:v20;
      if (col===1) return row===0?v01:row===1?v11:v21;
      return row===0?v02:row===1?v12:v22;
    };
    const setVcol = (col: number, row: number, val: number) => {
      if (col===0) { if(row===0)v00=val; else if(row===1)v10=val; else v20=val; }
      else if (col===1) { if(row===0)v01=val; else if(row===1)v11=val; else v21=val; }
      else { if(row===0)v02=val; else if(row===1)v12=val; else v22=val; }
    };
    for (let row = 0; row < 3; row++) {
      const vp = getVcol(p, row);
      const vq = getVcol(q, row);
      setVcol(p, row, c*vp - s*vq);
      setVcol(q, row, s*vp + c*vq);
    }
  }

  // 고유값 배열 (내림차순 정렬)
  const evals = [a00, a11, a22];
  const cols: number[][] = [
    [v00, v10, v20],
    [v01, v11, v21],
    [v02, v12, v22],
  ];
  const idx = [0, 1, 2].sort((i, j) => evals[j] - evals[i]);
  for (let k = 0; k < 3; k++) {
    eig[k] = evals[idx[k]];
    V[0*3+k] = cols[idx[k]][0];
    V[1*3+k] = cols[idx[k]][1];
    V[2*3+k] = cols[idx[k]][2];
  }
}

// 3x3 SVD: A = U * diag(S) * V^T. S는 내림차순 양수.
// 방법: A^T * A의 고유분해로 V, S^2 획득 → U = A * V * diag(1/S).
// rank-deficient (S[i] ≈ 0) 시 U의 해당 열은 나머지 열의 외적으로 복원.
export function svd3(A: Mat3, U: Mat3, S: Float64Array, V: Mat3): void {
  // M = A^T * A
  const AT = mat3Create();
  mat3Transpose(AT, A);
  const M = mat3Create();
  mat3Mul(M, AT, A);

  const evs = new Float64Array(3);
  eigenSym3(M, V, evs);
  S[0] = Math.sqrt(Math.max(0, evs[0]));
  S[1] = Math.sqrt(Math.max(0, evs[1]));
  S[2] = Math.sqrt(Math.max(0, evs[2]));

  // U = A * V * diag(1/S)
  const AV = mat3Create();
  mat3Mul(AV, A, V);
  const EPS = 1e-10;
  for (let col = 0; col < 3; col++) {
    if (S[col] > EPS) {
      const inv = 1 / S[col];
      U[0*3+col] = AV[0*3+col] * inv;
      U[1*3+col] = AV[1*3+col] * inv;
      U[2*3+col] = AV[2*3+col] * inv;
    } else {
      U[0*3+col] = 0; U[1*3+col] = 0; U[2*3+col] = 0;
    }
  }
  // 누락된 U 열은 다른 두 열의 외적으로 복원 (정규직교성 유지)
  for (let col = 0; col < 3; col++) {
    if (S[col] <= EPS) {
      const a = (col + 1) % 3, b = (col + 2) % 3;
      const ax = U[0*3+a], ay = U[1*3+a], az = U[2*3+a];
      const bx = U[0*3+b], by = U[1*3+b], bz = U[2*3+b];
      U[0*3+col] = ay*bz - az*by;
      U[1*3+col] = az*bx - ax*bz;
      U[2*3+col] = ax*by - ay*bx;
    }
  }
}
