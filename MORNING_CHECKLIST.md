# 아침 체크리스트 (2026-04-16)

## 점검 결과 요약
- 타입체크: 통과 (EXIT 0)
- 컨테이너: frontend/backend 모두 Up, nginx 200
- OpenAPI: `/refine/refined-upload-url`, `/refine/save` 만 존재 (구 `/align`, `/flatten` 제거 확인)
- 수학 로직:
  - `mat3.ts` Jacobi eigendecomp, SVD: convention(A=V·diag·Vᵀ, A=U·S·Vᵀ) 일관
  - `kabsch.ts`: R = V · diag(1,1,det(VUᵀ)) · Uᵀ, t = qc − R·pc (표준)
  - `apply.ts`: 쿼터니언 컨벤션 `rot_0=w`(gpuSync.ts 주석과 일치), Hamilton 곱, q_new = qR·q_old → 가우시안 covariance가 R·Σ·Rᵀ로 올바르게 변환
  - PlayCanvas `Mat4.data` column-major 기준으로 raw→world 변환식 검증 완료
- 통합:
  - `SplatViewerCore`가 `.ply` 확장자에 대해 Z축 180° 회전을 건 상태에서도 정합은 raw 프레임에서 이루어짐 → 재로딩 후 일관성 유지
  - `DoorAlignModal`의 mouseup listener가 카메라 우클릭 회전(`window` 바인딩, button===2)과 충돌 없음 (캔버스+button===0만 반응)

---

## 내가 결정해야 할 사항

### 1. 천장/바닥 라벨이 물리적으로 뒤집힌 가능성
- 어제 내가 **CeilingFloorModal의 Y 매핑을 뷰어와 같은 방향(raw +Y → 화면 아래)** 으로 플립함
- 그런데 `useRefineTool`의 콜백은 여전히 `const c = hi, f = lo` (ceilingY=큰Y, floorY=작은Y)
- 뷰어의 Z축 180° 회전을 고려하면: 화면 "위"쪽에 있는 splat = raw 작은 Y = 물리적 천장
- 즉 **라벨상 '천장(cyan)'이 실제로는 raw 큰 Y = 물리적 바닥 쪽을 가리킬 수 있음**
- 다만 shell 제거 로직은 둘을 대칭적으로 씀(`Math.min/Math.max`, band 체크) → **기능적으로는 문제 없음**. UI 라벨/색깔만 뒤집힘
- **판단 필요**: 모달 열어서 실제로 '천장'이 화면 위에 보이는지 확인. 라벨이 뒤집혔으면 `RefineViewer`의 콜백에서 `c = lo, f = hi`로 변경

### 2. 문 정합 버튼과 모달 위치 겹침
- 토글 버튼 위치: `absolute top-3 right-3 z-40`
- 모달 위치: `fixed right-3 top-3 z-50`
- 모달이 열리면 버튼이 가려져 보이지 않음 (모달 내 ✕ 버튼으로 닫을 수 있으니 기능은 OK)
- **판단 필요**: 버튼을 다른 위치로 옮길지(예: 하단, 왼쪽), 아니면 모달이 열리면 버튼을 숨길지

### 3. "정제" 탭과 "문 정합"의 UI 분리 여부
- 현재 `viewMode='refine'` 하나의 탭에서 Shell 정제 + 문 정합 모두 접근 가능
- CLAUDE.md의 Refine Pipeline 7단계 중 7번(문 정합)이 원래 이 파이프라인의 일부이긴 함
- **판단 필요**: 이대로 둘지, 아니면 별도 `viewMode='align'`을 만들어서 step 분리할지

### 4. 사용되지 않는 dead code
- `lib/alignment/ransac.ts`, `lib/alignment/plane.ts`는 지금 UI 어디에서도 import 안 됨
- CLAUDE.md에 "2) Alternative: SVD/PCA + RANSAC" 언급되어 있어 **의도적으로 남겨둔 것**
- 추후 segmentation 연동 시 쓸 예정. 삭제하지 말 것
- **판단 불필요**: 참고용 메모

### 5. 문 정합 결과가 "정제 결과 저장" 버튼에 반영되지 않음 (발견된 이슈)
- 구조: `useRefineTool`이 `sourceKeyRef`를 내부적으로 관리. Shell 정제 실행 시 refined.ply의 MinIO key를 저장.
- "정제 결과 저장" 버튼(`saveRefined`)은 `sourceKeyRef.current`를 `/refine/save`로 보내 SceneOutput 행을 생성.
- 어제 만든 `DoorAlignModal`은 `RefineViewer` 레벨에 있어 `useRefineTool`의 `sourceKeyRef`에 접근 불가.
  - `Apply & Save` 누르면 aligned.ply를 MinIO로 PUT하고 `reloadWithUrl(get_url)` 호출 → 뷰어는 새 URL로 재로딩되지만, **`sourceKeyRef`는 Shell 때의 key 그대로 유지**
  - 즉 "정제 결과 저장"을 뒤이어 누르면 Shell 단계 PLY가 DB에 저장되고 **문 정합 결과는 DB에 연결 안 됨**
- MinIO에는 올라가 있고 뷰어에서도 보이지만, SceneOutput.`ply_path`는 aligned.ply를 가리키지 않는 상태
- **판단 필요**: 셋 중 선택
  1. `DoorAlignModal`에서 Apply 후 `urlReq.key`를 prop으로 넘겨 `useRefineTool.sourceKeyRef`를 업데이트 (작은 리팩터)
  2. `DoorAlignModal`이 `Apply & Save`에서 `/refine/save`까지 직접 호출해 SceneOutput을 즉시 확정 (저장 버튼 2개로 분리)
  3. 지금 상태로 두고 워크플로우 안내만 추가 (Shell 저장 → 문 정합 후 재저장)

### 6. 부수 확인 결과
- 백엔드 런타임 로그에 에러/예외 없음
- `core.refine_module`, `_surface_plane`, `flat_opaque` 등 구 import 잔재 전부 제거 확인
- `serializePly`는 원본 property 순서를 보존 (`scene.propertyOrder` 그대로 기록)
- PLY 파서가 모든 property를 Float32Array로 만들므로 `applyRigidToScene`의 in-place 수정이 안전
- PlayCanvas `Mat4.data`는 column-major — `DoorAlignModal.pickNearestSplat`의 `m[0,4,8,12]` 계산이 올바르게 world.x 반환
- `screenToWorld` 좌표계는 CSS pixel 기준 — `getBoundingClientRect()` 기반 `mx/my`와 일치 (DPR 영향 없음)

---

## 아침에 브라우저에서 꼭 확인할 것
1. 정제 뷰어 진입 → 천장/바닥 모달 열고 raw Y 값과 실제 뷰어 상단/하단이 일치하는지
2. 정제 뷰어 진입 → "문 정합" 버튼 클릭 → 모달이 뜨는지, Pick → 캔버스 클릭 → 좌표가 채워지는지
3. 4쌍 모두 채운 뒤 target 좌표 입력 → Compute → RMSD 값이 표시되는지
4. Apply & Save → 새 PLY가 업로드되고 뷰어가 새 URL로 리로드되는지
5. 브러쉬 모드에서 좌표 왜곡 수정이 실제로 풀렸는지 (raw splat의 투영이 맞게 나오는지)
6. Shift 누른 채 WASD 이동 → 속도 표시가 5배로 파란 글자 전환되는지
