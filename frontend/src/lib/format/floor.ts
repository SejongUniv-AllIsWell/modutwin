// 층 번호 포맷터 — 두 컨벤션을 한 곳에서 관리.
//   floorLabel:   "F1" / "B1"  — 컴팩트, 지도·익스플로어·랜딩
//   floorLabelKo: "1층" / "B1" — 한국어, 대시보드·관리자·메타데이터 피커

export const floorLabel = (n: number): string =>
  n >= 0 ? `F${n}` : `B${Math.abs(n)}`;

export const floorLabelKo = (n: number): string =>
  n < 0 ? `B${Math.abs(n)}` : `${n}층`;
