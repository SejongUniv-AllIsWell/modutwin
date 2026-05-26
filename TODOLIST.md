# TODOLIST — 앞으로 구현할 것

## 🟢 핵심 기능

### 1. 베이스맵 도어 자동 검출 다중 응답

`detect-temp` SAM3 응답이 현재 단일 도어 가정. door-ml 응답 확장 + 프론트가 다중 도어 누적 처리. 자동 검출 후 호수 휠 피커를 도어별로 N회 띄움.

### 2. 베이스맵 수정 모드 재진입

등록 완료된 basemap 에 도어 추가/삭제/이름 변경. 기존 `doors.json` + MinIO 자산 fetch → 메모리 복원 → 편집 → 새 SceneOutput 으로 re-commit.

### 3. 도어 라벨 — PlayCanvas 텍스트 메쉬

현재 `useDoorLabels` 가 HTML overlay 로 호수 표시 (worldToScreen + raf). PlayCanvas 텍스트 메쉬로 옮기면 occlusion 처리 가능.

### 4. 도어 outline glow 강화

현재 `createDoorOutlineEntity` 가 line strip 3겹 + emissive 로 단순 외곽선. post-process bloom 또는 더 굵은 quad-based outline 으로 강화.

### 5. 창문 segmentation + 투명 텍스처

텍스처 베이크 시 창문 영역 자동 segmentation (SAM3 등) → 알파 0 으로 punch → 창문 너머 보이도록.

### 6. 정합 frame mesh 색상 결정

현재 `FRAME_COLOR = [0, 1, 0]` (디버깅용 초록). 사용자 노출되는 시각이므로 결정 필요 — 도어 텍스처 median 색 자동 산출 또는 고정 자연색.

## 🟡 정리/개선

### 7. doorMesh punch 복원 (basemap)

basemap 도어 X 삭제 시 wall 텍스처의 alpha=0 punch 영역에 원본 `cut.rgba` 다시 paste — 현재는 punch 가 남아있음. `lastDoorMeshInputRef` 가 이미 보관 중이므로 bbox 좌표만 추가하면 가능.

### 8. "n/4 픽" 카운터 → "취소" 버튼

수동 4점 픽 진행 중 표시되는 카운터 UI 를 명시적 "취소" 버튼으로 교체.

### 9. 층 카드 디자인 통일

`/buildings/[name]/page.tsx` 의 층 카드를 호수 토글과 동일 디자인 (둥근 border, 그라데이션 + 버튼). 30분 작업.

### 10. WallModal 폴리곤 상태 복원

`WallModal` 진입 시 빈 상태로 시작. 다시 열면 이전 폴리곤 자동 복원 (props 로 `initialPolygon` 추가).

### 11. 정합 수동 nudge UI 개선

현재 X/Y/Z + −/+ 버튼 그리드. gizmo 핸들 또는 마우스 드래그로 직관 개선.

### 12. 정합 슬라이더 실시간 frame 반영

현재 "정합 문 두께" 슬라이더 변경 후 "정합" 버튼 다시 눌러야 frame mesh 두께 갱신. 실시간 또는 디바운스 자동 재정합 검토.

## 🔵 리팩토링 기회

### 13. `useRegistrationContext` 커스텀 훅

`UnifiedSplatEditor` 의 `autoFinalizeFromContext` + `ensureUploadForLocal` + `requestMetadata` 가 한 덩어리. `useRegistrationContext(initialContext)` 훅으로 추출하면 모듈/베이스맵 흐름의 등록 처리 일원화.

### 14. DoorAlignModal 파일 분할

3000+줄 거대 파일. `applyDoorRefine` / `revertDoorRefine` / `applyDoorRotation` 등 독립 함수들을 `doorAlignActions.ts` 등으로 분리.

### 15. AlignPanel rectFit 호출 helper

AlignPanel 의 rectFit 호출 + gap push + 애니메이션 셋업 코드가 `runAutoAlign` 안에 집중. `lib/alignment/doorAlign.ts` 같은 모듈에 helper 로 분리.

## 🐛 알려진 한계

- **벽 텍스처 punch 복원 미구현** — basemap 도어 X 삭제 시 벽에 구멍 남음 (commit-final 까지 가져가도 동일 결과).
- **basemap 등록 후 수정 불가** — read-only (admin 삭제 후 재등록만 가능).
- **자동 검출 다중 도어 미지원** — SAM3 응답 단일 가정.
- **호수 라벨 PlayCanvas 미구현** — HTML overlay 로 대체 중.
