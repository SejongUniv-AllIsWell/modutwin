# core/door_detection/

3DGS PLY 기반 Door 3D Corner 추정 모듈 (plan v2).

## 목적

PLY 한 개를 입력으로 문(door)의 4 corner 3D 좌표(LT/RT/LB/RB)를 raw로 출력.
plane fitting / rectangle fitting / OBB / Gaussian 분류 단계는 의도적으로 **없음** (D1).

## Pipeline

```
PLY
 → Phase 1  Room interior estimation (robust bbox + 26-ray validation)
 → Phase 2  Coarse view generation   (방 안 fibonacci sphere 32 view, RGB only)
 → Phase 3  SAM3 first pass          (confidence ≥ 0.8)
 → Phase 4  Door direction           (mask centroid ray → DBSCAN, 단일 클러스터)
 → Phase 5  Fine view + SAM3 2차     (cluster_dir 방향 lateral baselines, 방 안 clamp)
 → Phase 6  View quality filtering   (mask area/boundary/compactness)
 → Phase 7  2D quadrilateral         (Douglas-Peucker 단일 경로, fallback 금지)
 → Phase 8  Corner ordering          (world up + camera right)
 → Phase 9  World-space ray
 → Phase 10 Robust triangulation     (LSQ + RANSAC, threshold = bbox_diag × 0.005)
 → Phase 11 Quality metrics + JSON
```

## Decisions log (변경 금지)

상세는 `MD_files/door_corner_estimation_plan.md` §0 참조. 핵심:

- D1: raw 4점만 출력. 보정 없음.
- D2: SAM3 confidence ≥ 0.8.
- D3: PLY 렌더만 사용. 학습 원본 이미지 사용 안 함.
- D4: View finding = Coarse → Fine 2-pass.
- D5: 모든 카메라 방 안.
- D6: RANSAC threshold = robust_bbox_diagonal × 0.005.
- D7: Corner ordering = world up + camera right. world up = (0,1,0) 고정.
- D9: 단일 문 가정.
- D10: blind retry 금지. fail-fast.
- D11: 2D corner extraction fallback 금지.

## CLI

```bash
python -m core.door_detection.pipeline \
    --ply path/to/scene.ply \
    --output_json path/to/door_corners.json
```

## Recursive compatibility check

각 phase 완료 시 plan v2 §3 체크리스트 수행.
