# Roadmap

이 문서는 현재 배포 기준 코드에서 아직 남아 있는 제품/기술 과제를 추적한다.
구현 완료된 과거 계획이나 일회성 리팩터링 메모는 여기에 남기지 않는다.

## Core Product Work

### 1. 베이스맵 도어 자동 검출 다중 응답

`detect-temp` SAM3 응답이 현재 단일 도어 가정. door-ml 응답 확장 + 프론트가 다중 도어 누적 처리. 자동 검출 후 호수 휠 피커를 도어별로 N회 띄움.

### 2. 베이스맵 수정 모드 재진입

등록 완료된 basemap 에 도어 추가/삭제/이름 변경. 기존 `doors.json` + MinIO 자산 fetch → 메모리 복원 → 편집 → 새 SceneOutput 으로 re-commit.

### 3. 베이스맵 수정 저장 일관성

basemap 수정 모드에서 도어를 추가/삭제할 때 `doors.json`, 도어 mesh/splat 자산, wall mesh texture punch, 최종 PLY 가 같은 좌표계와 같은 삭제 상태를 공유해야 한다. 현재 수정 모드는 문 metadata 와 door asset 중심으로 동작하므로, wall texture punch 와 main PLY 반영 범위를 명확히 검증하고 필요하면 저장 파이프라인을 보강한다.

### 4. Canonical PLY 와 도어 추출 결과 동기화

다듬기 완료 후 canonical PLY 를 기준으로 후속 단계가 진행된다. 도어 추출/삭제가 발생한 뒤에도 최종 저장용 PLY 가 canonical snapshot 만 보고 이전 상태를 쓰지 않는지 확인한다. 문 추출로 alpha-deleted 된 splat, wall mesh hole, door mesh/splat 이 최종 저장 결과에 모두 반영되어야 한다.

### 5. 도어 라벨 — PlayCanvas 텍스트 메쉬

현재 `useDoorLabels` 가 HTML overlay 로 호수 표시 (worldToScreen + raf). PlayCanvas 텍스트 메쉬로 옮기면 occlusion 처리 가능.

### 6. 저장된 doorFrame 좌표계 정리

현재 정합 중에는 `moduleDoor` / `basemapDoor_*` wrapper 아래에 door mesh + splat 을 묶고, `doorPivotGroup` 으로 대상 문과 `doorFrame` 을 함께 회전한다. 다만 정합 완료 후 저장되는 `doorFrame` 은 world 좌표로 저장되어 floor overview 에서 root-level mesh 로 복원된다. 장기적으로는 `doorFrame` 도 module-local 또는 door-local 좌표로 저장해 `moduleDoor` 계층 아래에서 함께 관리하도록 바꾼다.

이 작업은 basemap 이 움직이지 않는 현재 전제에서는 급하지 않다. 다만 나중에 floor/building 단위 상위 transform 을 도입하거나, module 전체를 부모 객체 중심으로 이동/복사/삭제해야 하는 기능이 들어오면 world 좌표 저장이 stale 해질 수 있다. 그 시점에는 `doorFrame` 을 module-local 또는 door-local 로 저장하고, floor overview 에서 module wrapper 하위로 복원하는 방향으로 전환한다.

### 7. 도어 outline glow 강화

현재 `createDoorOutlineEntity` 가 line strip 3겹 + emissive 로 단순 외곽선. post-process bloom 또는 더 굵은 quad-based outline 으로 강화.

### 8. 창문 segmentation + 투명 텍스처

텍스처 베이크 시 창문 영역 자동 segmentation (SAM3 등) → 알파 0 으로 punch → 창문 너머 보이도록.

## Cleanup and UX

### 9. doorMesh punch 복원 (basemap)

basemap 도어 X 삭제 시 wall 텍스처의 alpha=0 punch 영역에 원본 `cut.rgba` 다시 paste — 현재는 punch 가 남아있음. `lastDoorMeshInputRef` 가 이미 보관 중이므로 bbox 좌표만 추가하면 가능.

### 10. 수동 문 꼭짓점 안정성 검증

수동 4점 픽 완료 후 점들이 작은 직사각형으로 모이는 사례가 있다. raycast 대상 평면, projection basis, point ordering, degenerate rectangle 보정 로직을 분리해서 검증한다. 벽/바닥/천장 여부와 무관하게 네 점이 같은 평면에 있으면 안정적으로 사각형이 유지되어야 한다.

### 11. "n/4 픽" 카운터 → "취소" 버튼

수동 4점 픽 진행 중 표시되는 카운터 UI 를 명시적 "취소" 버튼으로 교체.

### 12. 층 카드 디자인 통일

`/buildings/[name]/page.tsx` 의 층 카드와 `/buildings/[name]/floors/[floorNumber]` 의 좌측 모듈 카드 디자인을 같은 기준으로 유지한다. 상태 경고는 카드 높이를 바꾸지 않고 icon + tooltip 으로 표시한다.

### 13. WallModal 폴리곤 상태 복원

`WallModal` 진입 시 빈 상태로 시작. 다시 열면 이전 폴리곤 자동 복원 (props 로 `initialPolygon` 추가).

### 14. 정합 수동 nudge UI 개선

현재 X/Y/Z + −/+ 버튼 그리드. gizmo 핸들 또는 마우스 드래그로 직관 개선.

### 15. 정합 슬라이더 실시간 frame 반영

현재 "정합 문 두께" 슬라이더 변경 후 "정합" 버튼 다시 눌러야 frame mesh 두께 갱신. 실시간 또는 디바운스 자동 재정합 검토.

## Refactoring Opportunities

### 16. `useRegistrationContext` 커스텀 훅

`UnifiedSplatEditor` 의 `autoFinalizeFromContext` + `ensureUploadForLocal` + `requestMetadata` 가 한 덩어리. `useRegistrationContext(initialContext)` 훅으로 추출하면 모듈/베이스맵 흐름의 등록 처리 일원화.

### 17. DoorAlignModal 파일 분할

3000+줄 거대 파일. `applyDoorRefine` / `revertDoorRefine` / `applyDoorRotation` 등 독립 함수들을 `doorAlignActions.ts` 등으로 분리.

### 18. useRefineTool 파일 분할

다듬기 도구가 canonical PLY, 삭제 마스크, wall mesh bake, UI state 를 한 파일에서 모두 관리한다. 동작 안정화 후 `useCanonicalPly`, `useWallMeshBake`, `useRefineDeletionMasks` 같은 작은 훅/헬퍼로 분리하되, 좌표계와 저장 포맷은 변경하지 않는다.

### 19. AlignPanel rectFit 호출 helper

AlignPanel 의 rectFit 호출 + gap push + 애니메이션 셋업 코드가 `runAutoAlign` 안에 집중. `lib/alignment/doorAlign.ts` 같은 모듈에 helper 로 분리.

## Performance and Operations

### 20. Floor overview 대용량 로딩

층 화면에서 basemap 과 모든 정합 모듈의 PLY, wall mesh, door mesh/splat 을 한 번에 로드하면 브라우저 메모리가 부족해질 수 있다. 기본은 basemap + 가벼운 module preview 를 먼저 표시하고, 선택/근접/토글 시 module 상세 자산을 lazy load 하는 구조를 검토한다.

현재 QA 범위에서 문제가 재발하지 않으면 유지한다. 만약 여러 모듈을 한 층에 올렸을 때 `Array buffer allocation failed`, `getImageData out of memory`, viewer 로드 실패가 다시 발생하면 전체 동시 로딩을 중단하고 다음 구조로 바꾼다: basemap 은 즉시 로드, module PLY/door splat/wall mesh 는 사용자가 선택하거나 카메라가 근접했을 때만 lazy load, 비선택 module 은 경량 bbox/label/thumbnail 로 대체.

### 21. SceneOutput migration 적용 확인

`scene_outputs.sog_path` 는 더 이상 필수 저장값이 아니다. 배포와 QA 전 `0015_nullable_scene_output_sog_path` migration 이 적용되었는지 확인한다. migration 미적용 DB 에서는 `/api/refine/save` 또는 `/api/uploads/commit-final` 이 `sog_path NOT NULL` 제약으로 500 을 낼 수 있다.

조회 경로는 SOG 가 있으면 뷰어용 경량 자산으로 우선 사용하고, 없으면 canonical PLY 로 fallback 한다. `sog_path=final_ply_key` 처럼 PLY 를 SOG 컬럼에 중복 저장하는 임시 호환 코드는 migration 적용 후 제거해야 한다.

### 22. Legacy alignment 저장 경로 정리

현재 정합 완료 정보는 `Module.alignment_transform` 이 기준이다. `Upload.alignment_transform` 과 `/uploads/{id}/alignment` legacy 경로는 과거 흐름 호환용으로 남아 있으므로, `AlignPanel` 의 legacy 분기가 더 이상 실제로 호출되지 않는지 확인한 뒤 별도 migration 으로 제거한다.

### 23. SceneOutput 누적 정책 정리

정제/정합 저장은 새 `SceneOutput` row 를 계속 생성한다. 현재 조회는 최신 row 를 사용하므로 기능은 동작하지만, 장기 운영 전에는 최신 row 만 유지하는 upsert 정책 또는 오래된 row 정리 정책을 정한다.

### 24. Basemap 교체 후 기존 모듈 재정렬

활성 basemap 을 교체하면 기존 모듈의 정합 기준이 바뀔 수 있다. 현재는 활성 basemap 의 `minio_path` 를 직접 조회하고, 교체 시 기존 모듈 재정렬이 필요하다는 응답만 반환한다. 실제 basemap 재정렬 작업이 필요해지면 `basemap_realign` 태스크를 추가해 기존 모듈 transform 을 새 basemap 기준으로 재계산한다.

## Known Limits

- **벽 텍스처 punch 복원 미구현** — basemap 도어 X 삭제 시 벽에 구멍 남음 (commit-final 까지 가져가도 동일 결과).
- **basemap 수정 모드 제한** — 등록된 문 중 정합된 호수는 잠그고, 미정합 문만 추가/삭제/호수 변경한다.
- **자동 검출 다중 도어 미지원** — SAM3 응답 단일 가정.
- **호수 라벨 PlayCanvas 미구현** — HTML overlay 로 대체 중.
- **대용량 floor overview OOM 가능성** — 여러 모듈을 동시에 로드하면 브라우저 메모리 한계에 걸릴 수 있다.
