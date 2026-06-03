# N-door 에디터·영속화·뷰어 통합 계획

자동 검출된 N개 문을 **모두 시각화 + 여닫기 가능**하게 하고, 그중 **1개를 정합 문으로 3D 클릭 지정**한다.
정합 문 + 비정합 문 모두 **서버에 저장**되어 최종 디지털 트윈 뷰어에서 여닫힌다.

## 확정 결정 (사용자)

| # | 결정 |
|---|------|
| D1 | 정합 문 지정 = **3D 뷰어에서 문 클릭** |
| D2 | 영속화 = **N개 문 모두 서버 저장** |
| D3 | 여닫기 = **에디터 + 최종 뷰어 모두**, N개 문 전부 |
| D4 | 문 개수 = **클러스터링 자동 검출** (max_doors 입력 제거) — 완료 |
| D5 | 기존 NDoorSelectPanel(택1 선택) **제거** |

## 현재 상태

- 백엔드: door-ml 이 `all_doors`(N개 코너) 반환. 클러스터링 자동, max_doors 제거 완료.
- 프론트: `allExtractedDoors` 상태 + N개 윤곽선 + NDoorSelectPanel(제거 대상).
- 모듈 흐름: **단일 문** (DoorAlignModal 이 picked corners 1세트 → door mesh+splat+alignment+commit-final).
- 베이스맵 흐름: **다중 문** 인프라 존재 (inMemoryDoors, buildDoorEntriesForUpload, persistDoors).

## 핵심 통찰

베이스맵 흐름에 **이미 다중 문 인프라**가 있다. 모듈 흐름에 이를 끌어와
"N개 문 = inMemoryDoors 유사 리스트, 1개에 alignment 플래그" 로 일반화하는 것이 핵심.

## 구현 단계

### Phase F1 — 정리 + N개 시각화 + 클릭 지정 (작은 단위, 먼저)
- [ ] Sam3PromptModal: max_doors UI 제거.
- [ ] UnifiedSplatEditor: detect-temp max_doors 전송 제거. NDoorSelectPanel 제거.
- [ ] N개 문을 컬러 윤곽선으로 항상 표시 (단일 문이어도 1개).
- [ ] **3D 클릭 → 정합 문 지정**: 뷰어 클릭 ray ↔ 각 문 quad 교차 → 가장 가까운 문을
      "정합 문"으로. 선택된 문 = 강조(굵은 윤곽/색), autoExtractedCorners 에 세팅.
- [ ] 정합 문 = 기존 단일-문 흐름(DoorAlignModal) 으로 진행 (mesh+open/close+alignment).

→ 이 단계로 "자동 N검출 + 시각화 + 클릭 지정 + 정합 문 1개 처리" 완성. 테스트 가능.

### Phase F2 — N개 문 door mesh + 여닫기 (에디터)
- [ ] DoorAlignModal 의 door mesh 생성(applyDoorRefine: 벽 punch + 텍스처 crop + 도어 splat
      + hinge wrapper)을 **함수로 추출**해 N회 호출 가능하게 리팩터.
- [ ] 비정합 문에도 door mesh + hinge wrapper 생성 → 에디터에서 여닫기.
- [ ] 문별 hinge edge / swing 방향 기본값 자동 추정 (정합 문은 사용자 조정 가능).

### Phase F3 — N개 문 영속화 (commit-final 다중 문)
- [ ] 모듈 commit-final 을 다중 문으로 확장 (베이스맵 inMemoryDoors 방식 참고).
  - 각 문: corners(A'+Y) + doorMesh 메타 + tex + 도어 splat PLY + hinge 메타.
  - 1개 문에 `is_alignment: true`.
- [ ] backend: `module_register.commit-final` 다중 doors 수용. doors.json 에 N개 직렬화.
- [ ] alignment_transform 은 정합 문 corners 로만 계산 (기존과 동일).

### Phase F4 — 최종 뷰어 N개 문 여닫기
- [ ] 뷰어(floors/[floorNumber]/page.tsx + doorInteraction.ts)가 doors.json 의 N개 문을
      모두 로드 → 각 문 mesh + hinge wrapper + 클릭 여닫기.
- [ ] 기존 단일/다중 문 상호작용 코드 일반화.

## 좌표/프레임 주의

- 검출 코너는 A'+Y (backend 변환 후) → 프론트는 ayToRaw 로 raw 저장 (기존 컨벤션).
- door mesh / hinge 는 splat 프레임(A') 기준.
- commit-final 시 raw → A'+Y 재변환 (기존 단일 문과 동일 경로 N회).

## 엣지 케이스

- 문 0개(클러스터 실패) → legacy iterative 단일-문 fallback (backend 처리됨).
- 정합 문 미지정 상태로 진행 시도 → 가장 score 높은 문 자동 정합 문 + 경고.
- 같은 벽 인접 두 문 → 클러스터/병합이 분리 (backend). 프론트는 그대로 N개 표시.

## 우선순위

F1 (시각화+클릭지정) → F3 (영속화) → F2 (에디터 여닫기) → F4 (뷰어 여닫기).
※ F2/F4 의 door mesh 여닫기는 무겁고 DoorAlignModal/뷰어 리팩터 동반 — 각 단계 후 검증.
