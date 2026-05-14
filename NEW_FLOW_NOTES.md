# 모듈/베이스맵 등록 신흐름 — 작업 진행 메모 (2026-05-14)

## ✅ 이번 세션 완료

### 베이스맵 다중 도어 흐름
- 진입 모달 (`/buildings/[name]/page.tsx`): basemap 등록 시 module_name 입력 칸 제거
- `DoorAlignModal` (basemap 모드):
  - `inMemoryDoors` state 도입 — 추출 즉시 메모리 리스트에 push
  - 호수 휠 피커 모달 (`DoorUnitNamePickerModal`) — iOS 알람 스타일, N01~N99
  - 도어 목록 UI 박스 — 미설정/설정 시각 구분 (노란 강조 + ⚠️ 또는 🚪), 행 클릭 시 휠 피커 재오픈
  - X 삭제 — 도어 entity / outline / splat layer 정리 (벽 텍스처 punch 복원은 TODO)
  - 기존 "문 저장" 버튼 basemap 모드 숨김
  - **"Basemap 등록 완료"** 별도 버튼 — 호수 미설정 도어 있으면 비활성, 클릭 시 일괄 영속:
    1. `ensureUploadId` (`/uploads/register-local-basemap`)
    2. `onCommitRefined` — basemap PLY + mesh.json + tex_*.png 업로드
    3. 각 도어: `tex_<doorId>.png` + `<doorId>.ply` 업로드
    4. `PUT /uploads/{id}/doors` — 모든 도어 메타 (doorMesh/doorSplat 참조 포함)
    5. `onSetupSaveDone` → `/basemaps/register`
  - **완료 모달** — "Basemap 등록이 완료되었습니다. 이동할 페이지를 선택해주세요." + 가로 3 버튼 (메인/건물/대시보드)
- `UnifiedSplatEditor`: `basemapFloorNumber`, `onBasemapDone` 라우팅 콜백 추가
- 도어 outline helper 생성 (`lib/gs/doorOutline.ts`) — 노란 line strip (basic). 라벨 + glow 는 미구현.
- `surfaceColor()` 벽 단일 색 = 세이지 그린 (`#86efac`)
- Backend manifest: `__basemap__` placeholder Module 항상 숨김 ([buildings.py:1044](backend/app/api/buildings.py#L1044))

### 기타
- 옛 "601호" 패치된 basemap + 모든 modules/uploads/tasks/scenes/basemaps 청소 완료
- MinIO `buildings/` 비움

## 📌 별도 세션 필요 (큰 작업)

### Task 4 — 벽면 N개 자유도 (모듈 + 베이스맵)

데이터 모델 변경이 핵심이라 본 세션에선 보류. 영향 파일:
- `lib/gs/planes.ts` ✅ `surfacePlanesFromPolygon` 신규 추가 완료
- `refineTypes.ts` — `WALL_SURFACES` 정적 상수 → 동적 함수
- `useRefineTool.tsx` — `wallPolygon` state 도입, polygon 픽킹 UI 활성화 (basemapMode 의존성 제거)
- `gatherRefinedAssets`/`commitRefinedToServer` — wallAngle Y 베이크 제거 (A'+Y → A')
- `commit-final` 백엔드 — 6 고정 multipart → 가변 텍스처
- `AlignPanel` — A'+Y 좌표 변환 단순화 (R_y 제거)
- 베이크/clipping/flatten 코드 — 동적 surfaceId 호환 검증

WallModal 의 polygon UI 는 이미 basemap 모드에서 동작 — module 모드에도 같은 UI 적용 필요 + downstream N벽 처리 추가.

### 도어 outline glow + 라벨

- 현재 `createDoorOutlineEntity` 가 노란 line strip 생성 — PlayCanvas BasicMaterial + LineList. glow 는 halo line 두 줄로 시도했으나 실제 효과는 약함.
- 호수 라벨 (PlayCanvas text mesh) — fontAsset 없이 구현 어려움. HTML overlay 가 빠른 대안.

### 벽 텍스처 복원 (도어 X 삭제 시)

- 현재는 도어 mesh entity / splat layer 만 정리. 벽 텍스처의 alpha=0 punch 는 그대로 남음 → 구멍.
- `extractDoorRegionTexture` 가 반환하는 cut.bbox + cut.rgba 를 메모리에 보관 → 삭제 시 wall mesh emissiveMap 에 다시 paste 하면 복원 가능.
- `lastDoorMeshInputRef` 에 이미 cut.rgba 있음. bbox 좌표만 추가 보관하면 가능.

### "n/4 픽" → "취소" 버튼

- 수동 4점 픽킹 진행 중 표시되는 카운터를 명시적 "취소" 버튼으로 교체. 작은 UI 변경.

### basemap 수정 모드 재진입

- 등록 후 도어 추가/삭제/이름 변경 — 기존 doors.json + 자산 fetch → 메모리 복원 → 편집 → re-commit. 별도 흐름.

### SAM3 응답 list 확장

- door-ml 응답 단일 도어 → list 형태로 확장 (`detect-temp` 백엔드 응답 + 프론트 처리). 다중 응답 가능 시 무한 누적 가능.

### 층 선택 페이지 UI

- `/buildings/[name]/page.tsx` 층 카드를 호수 토글과 동일 디자인 (둥근 border, 그라데이션 + 버튼). 30분 작업.

## 🐛 알려진 한계

1. **벽 텍스처 punch 복원 미구현** — X 삭제 시 벽에 구멍 남음 (commit-final 까지 가져가도 됨, 동일 결과)
2. **N벽 미적용** — module/basemap 모두 여전히 4벽 bounding rectangle 시스템
3. **basemap 등록 후 수정 불가** — read-only (admin 삭제 후 재등록만 가능)
4. **도어 outline glow 약함** — line render 두께 한계, post-process bloom 필요
5. **호수 라벨 미표시** — PlayCanvas text mesh 미구현
6. **자동 검출 다중 도어 미지원** — SAM3 응답 단일 가정

## 🧪 테스트 시나리오

1. `/explore` → 건물 → 층 → "+ 등록 → basemap 등록"
   - 모달에 층 번호만 (이름 입력 없음) → 확인
2. /viewer 진입 → PLY 선택 → 다듬기 (6면 베이크 필수)
3. 다듬기 완료 → 문 설정
4. SAM3 자동 (또는 수동 4점) → 추출 → 휠 피커 모달 → 호수 선택 → 목록에 추가
5. (반복) 다른 영역 4점 → 추출 → 휠 피커 → 다른 호수 → 목록 누적
6. "Basemap 등록 완료" 클릭 → 일괄 영속 → 완료 모달 → 페이지 선택 (메인/건물/대시보드)
7. 다시 그 층 진입 → basemap PLY + 6면 mesh + N개 도어 mesh + N개 도어 splat 자동 로드
8. 모듈 등록 → 정합 단계 → basemap doors.json 에서 모듈 호수와 매칭되는 도어로 정합

## 📂 변경된 파일

- `frontend/src/lib/gs/planes.ts` — surfacePlanesFromPolygon, surfaceColor 추가
- `frontend/src/lib/gs/doorOutline.ts` — 신규 (도어 outline entity helper)
- `frontend/src/components/viewer/tools/DoorAlignModal.tsx` — 다중 도어 흐름 본체
- `frontend/src/components/viewer/UnifiedSplatEditor.tsx` — basemap props 전달
- `frontend/src/app/buildings/[name]/page.tsx` — basemap 진입 모달의 이름 입력 제거
- `backend/app/api/buildings.py` — manifest 에서 `__basemap__` 모듈 제외
