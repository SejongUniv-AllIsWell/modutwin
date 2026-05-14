# 층 overview 이미지 자동 생성 파이프라인 계획

`building` 페이지의 층 슬라브 이미지를 자동 생성·갱신하는 파이프라인.

이 수정본은 현재 코드 기준으로 바로 구현 가능한 계약을 정리한다. 기존 초안의
`--sh-bands 0`, SOG 파일 구조, aligned PLY 저장 흐름, GPU worker 전제,
dirty race 문제를 수정했다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 변환 도구 | [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform) CLI |
| SH 제거 | `--filter-harmonics 0` 또는 `-H 0`. `--sh-bands 0` 사용 금지 |
| SOG 명세 | PlayCanvas SOG v2. `.sog`는 ZIP bundled variant이며 내부 root에 `meta.json`과 WebP 텍스처 포함 |
| 렌더 입력 | 층 단위 통합 `floor.sog` |
| 렌더러 | GPU worker + Python `gsplat` |
| 서버 이미지 | top-down orthographic webp 1장. 3D tilt는 CSS transform으로만 처리 |
| 재생성 트리거 | `Floor.overview_dirty=True` + `overview_dirty_at` + Celery beat 30초 debounce |
| 합성 안전장치 | opacity >= 0.05, basemap bbox crop, SH0 only, 대형 씬은 streaming/downsample 우선 |
| Frontend 갱신 | 페이지 진입/포커스/visibilitychange 시 `/floor-overview` refetch |

## 현재 상태

- `Floor` 모델에는 이미 `overview_image_path`, `overview_meta_path`,
  `overview_version`, `overview_dirty` 컬럼이 있다.
- `overview_dirty=True`는 `basemaps.py::activate_basemap`,
  `refine.py::save_refined`, `internal_worker.py::worker_task_success`,
  `buildings.py`의 일부 CRUD에서 이미 세팅된다.
- 실제 webp 생성 코드는 없다.
- `frontend/src/app/buildings/[name]/page.tsx`는 `floor.topdown_url`이 없으면
  `/data/1.webp`, `/data/2.webp` 샘플 이미지를 fallback으로 사용한다.
- `worker/pipeline/sog_converter.py`와 worker task에는 PLY를 `.sog` 확장자로
  복사하는 stub이 남아 있다.
- `SceneOutput.sog_path`는 nullable이 아니다. aligned PLY row를 만들 때
  SOG key를 나중에 채우는 방식은 그대로는 DB 저장에 실패한다.

## 전체 흐름

```text
[Admin activates basemap]               [User completes door alignment]
 /admin/basemaps/{id}/activate           DoorAlignModal applyAndSave
           |                                       |
           v                                       v
 mark_floor_overview_dirty(floor_id)      PUT aligned.ply to MinIO
 enqueue/ensure basemap SOG conversion    POST /uploads/{id}/alignment
                                           with aligned_ply_key
                                                   |
                                                   v
                                          create completed Task +
                                          SceneOutput(is_aligned=True,
                                          ply_path=aligned_ply_key,
                                          sog_path=aligned_ply_key)
                                          mark dirty
                                          enqueue scene SOG conversion

                 Floor.overview_dirty=True, overview_dirty_at=now()
                                      |
                                      v
                     Celery beat scan every 30s
                                      |
                                      v
                     rebuild_floor_overview(floor_id)
                                      |
                                      v
                     backend claim returns input manifest:
                     dirty_at, active basemap PLY,
                     visible modules' latest aligned PLYs
                                      |
                                      v
                     aggregate_floor_sog()
                     - load active basemap PLY
                     - load latest aligned module PLYs
                     - opacity/logit filter
                     - basemap bbox crop
                     - streaming/downsample if needed
                     - write SH0-only merged PLY
                     - splat-transform -H 0 -> floor.sog
                                      |
                                      v
                     render_floor_overview()
                     - decode SOG v2
                     - apply viewer baseline Z-180 convention
                     - top-down orthographic gsplat render
                     - save webp + meta.json
                                      |
                                      v
                     callback clears dirty only if
                     Floor.overview_dirty_at <= claimed dirty_at
```

## Phase 1 - DB와 dirty 계약

### 모델 변경

```python
class Basemap(Base):
    ...
    sog_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)

class Floor(Base):
    ...
    floor_sog_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    floor_sog_version: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    overview_dirty_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    overview_error: Mapped[str | None] = mapped_column(Text, nullable=True)
```

`SceneOutput.sog_path`는 nullable로 바꾸지 않는다. 현재 `refine.save`가 이미
`sog_path=source_key` 방식으로 PLY fallback을 사용하므로 같은 계약을 유지한다.

### Migration

- `basemaps.sog_path`
- `floors.floor_sog_path`
- `floors.floor_sog_version`
- `floors.overview_dirty_at`
- `floors.overview_error`
- 기존 `overview_dirty=True` row는 `overview_dirty_at=now()`로 backfill

### dirty helper

직접 `.values(overview_dirty=True)`를 반복하지 않고 helper로 통일한다.

```python
async def mark_floor_overview_dirty(db: AsyncSession, floor_id: UUID) -> None:
    now = datetime.now(timezone.utc)
    await db.execute(
        sa_update(Floor)
        .where(Floor.id == floor_id)
        .values(
            overview_dirty=True,
            overview_dirty_at=now,
            overview_error=None,
        )
    )
```

적용 대상:

- `basemaps.py::activate_basemap`
- `refine.py::save_refined`
- `internal_worker.py::worker_task_success`
- `buildings.py`의 module 생성, module alignment transform, module visibility, module delete
- 새 aligned 저장 흐름

## Phase 2 - SOG 변환

### CLI 설치

`splat-transform`은 npm package로 설치한다.

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
 && npm install -g @playcanvas/splat-transform \
 && rm -rf /var/lib/apt/lists/*
```

### 변환 명령

```python
subprocess.run(
    [
        "splat-transform",
        "--overwrite",
        input_ply,
        "--filter-harmonics",
        "0",
        output_sog,
    ],
    check=True,
)
```

주의:

- `--sh-bands 0`는 공식 CLI 옵션이 아니다.
- `.sog`는 bundled ZIP이다. 확장자는 `.sog`지만 내부 파일은 `meta.json`과 WebP 텍스처다.
- tiny PLY fixture로 변환 smoke test를 추가한다.

### 변환 task

`worker/tasks/conversion.py`

```python
@app.task(name="tasks.conversion.convert_ply_to_sog", bind=True)
def convert_ply_to_sog(self, owner_kind: str, owner_id: str, ply_key: str):
    # owner_kind: "basemap" | "scene"
    # 1. MinIO download
    # 2. splat-transform --filter-harmonics 0
    # 3. MinIO upload next to input PLY
    # 4. POST /internal/worker/sog-conversions/success
```

Callback:

```text
POST /internal/worker/sog-conversions/success
{
  "owner_kind": "basemap" | "scene",
  "owner_id": "...",
  "ply_key": "...",
  "sog_key": "..."
}
```

- `owner_kind=basemap`: `Basemap.sog_path = sog_key`
- `owner_kind=scene`: `SceneOutput.sog_path = sog_key`
- 둘 다 해당 floor를 다시 dirty mark한다. 단, floor overview 합성은 PLY를 입력으로 쓰므로
  개별 SOG 변환 완료가 overview 렌더의 필수 선행조건은 아니다.

## Phase 3 - aligned PLY 저장 계약

기존 `POST /uploads/{upload_id}/alignment`를 확장한다. 신규
`/aligned-uploaded` endpoint를 따로 만들면 transform 저장과 SceneOutput 생성이 분리되어
race와 중복 호출이 생기기 쉽다.

```python
class AlignmentSaveRequest(BaseModel):
    transform: dict[str, Any]
    rmsd: float | None = None
    matches: list[AlignmentMatch] = Field(default_factory=list)
    aligned_ply_key: str | None = None
```

`aligned_ply_key`가 있으면 backend는:

1. key normalize
2. `refined_prefix(upload.minio_path)` 하위인지 검증
3. MinIO object 존재 확인
4. `upload.alignment_transform` 저장
5. completed `Task(task_type=TaskType.door_alignment)` 생성
6. `SceneOutput(is_aligned=True, ply_path=aligned_ply_key, sog_path=aligned_ply_key)` 생성
7. floor overview dirty mark
8. `convert_ply_to_sog(owner_kind="scene", owner_id=scene.id, ply_key=aligned_ply_key)` dispatch

Frontend `DoorAlignModal.tsx::applyAndSave`:

- `/refine/refined-upload-url` 응답 타입에 `key`를 포함한다.
- aligned PLY PUT 성공 후 기존 `/uploads/{id}/alignment` 요청에
  `aligned_ply_key: urlReq.key`를 추가한다.

## Phase 4 - basemap 활성화 계약

overview 재생성 기준은 approve가 아니라 activate다. 승인된 basemap이 실제 active로
바뀌어야 building overview에 반영된다.

`backend/app/api/basemaps.py::activate_basemap`

1. 기존 active basemap 비활성화
2. 새 basemap 활성화
3. `mark_floor_overview_dirty(floor_id)`
4. `Basemap.sog_path`가 없으면 `convert_ply_to_sog(owner_kind="basemap", ...)` dispatch

approve 시점에 미리 변환을 dispatch해도 되지만, overview dirty는 activate에서 보장한다.

## Phase 5 - Overview worker

현재 `worker/Dockerfile`은 `python:3.11-slim`이라 CUDA `gsplat` 렌더에 부적합하다.
overview 렌더는 별도 GPU worker 이미지로 분리한다.

예시:

```dockerfile
FROM nvidia/cuda:13.0.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3.12-dev python3-pip \
      nodejs npm git libgl1 libglib2.0-0 \
 && ln -sf python3.12 /usr/bin/python3 \
 && ln -sf python3 /usr/bin/python \
 && npm install -g @playcanvas/splat-transform \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --pre torch torchvision --index-url https://download.pytorch.org/whl/nightly/cu130
RUN pip install --no-cache-dir celery redis minio numpy plyfile pillow gsplat
```

CUDA/PyTorch 버전은 서버 GPU에 맞춰 조정한다. 현재 repo의 `door_ml/Dockerfile`
CUDA 13.0 선택 이유를 우선 참고한다.

Celery:

```python
app.conf.task_routes.update({
    "tasks.conversion.*": {"queue": "conversion"},
    "tasks.overview.*": {"queue": "overview"},
})

app.conf.imports = (
    "tasks.training",
    "tasks.alignment",
    "tasks.conversion",
    "tasks.overview",
)

app.conf.beat_schedule = {
    "scan-dirty-floor-overviews": {
        "task": "tasks.overview.scan_dirty_floor_overviews",
        "schedule": 30.0,
    },
}
```

compose에는 worker와 beat를 분리한다.

```yaml
overview-worker:
  build:
    context: ./worker
    dockerfile: Dockerfile.gpu
  command: celery -A celery_app worker -Q overview,conversion -c 1 --loglevel=info

worker-beat:
  build: ./worker
  command: celery -A celery_app beat --loglevel=info
```

## Phase 6 - Backend internal endpoints

모든 endpoint는 기존 `_require_worker_token`을 재사용한다.

```text
GET /internal/worker/floors/dirty-overviews?older_than_seconds=30&limit=20
```

조건:

- `Floor.overview_dirty=True`
- `overview_dirty_at <= now - older_than_seconds`
- active basemap이 있는 floor만 반환

```text
POST /internal/worker/floors/{floor_id}/overview-claim
```

반환:

```json
{
  "floor_id": "...",
  "building_id": "...",
  "dirty_at": "2026-05-14T...",
  "basemap_ply_key": "...",
  "module_ply_keys": ["..."],
  "output_prefix": "floors/{floor_id}/overview"
}
```

입력 선정:

- basemap: `Basemap.is_active=True` row의 `minio_path`
- modules: `Module.is_visible=True`인 module별 최신 `SceneOutput`
- scene 조건: `SceneOutput.is_aligned=True`
- `SceneOutput.ply_path` object가 실제 존재하는 것만 포함
- hidden `__basemap__` module은 제외

Callbacks:

```text
POST /internal/worker/floors/{floor_id}/floor-sog-success
POST /internal/worker/floors/{floor_id}/overview-success
POST /internal/worker/floors/{floor_id}/overview-failure
```

`overview-success` body:

```json
{
  "dirty_at": "claim에서 받은 dirty_at",
  "floor_sog_key": "floors/{floor_id}/floor.sog",
  "overview_image_key": "floors/{floor_id}/overview/1710000000.webp",
  "overview_meta_key": "floors/{floor_id}/overview/1710000000.json"
}
```

Dirty clear 규칙:

- `Floor.overview_dirty_at <= body.dirty_at`일 때만
  `overview_dirty=False`, `overview_image_path`, `overview_meta_path`,
  `overview_version`, `floor_sog_path`, `floor_sog_version` 갱신
- 렌더 중 더 최신 dirty가 들어왔으면 image path는 갱신해도 `overview_dirty=True`는 유지한다.

## Phase 7 - floor.sog 합성

`worker/pipeline/floor_aggregator.py`

```python
def aggregate_floor(manifest: OverviewClaimManifest) -> AggregateResult:
    # 1. download basemap + module PLYs
    # 2. load only SH0 columns: xyz, scale_*, rot_*, opacity, f_dc_*
    # 3. filter opacity: sigmoid(opacity_logit) >= 0.05
    # 4. compute basemap bbox from filtered basemap centers
    # 5. crop modules to basemap bbox + margin
    # 6. streaming append/downsample to avoid full 14GB resident memory
    # 7. write merged SH0-only PLY
    # 8. splat-transform --filter-harmonics 0 merged.ply floor.sog
    # 9. upload floor.sog
```

규칙:

- PLY의 `opacity`는 logit이다. Python 필터는 `sigmoid(opacity) >= 0.05`로 처리한다.
- PLY의 `scale_*`는 log scale이다. merged PLY에 원래 log 값을 유지한다.
- `f_rest_*`는 읽지 않는다. SH0-only PLY를 써서 메모리와 SOG 크기를 줄인다.
- bbox crop은 중심점 기준, margin 기본값은 0.5m.
- downsample은 전체 concat 후가 아니라 chunk/voxel accumulator 방식으로 한다.
  같은 voxel에서는 opacity가 가장 큰 splat 하나를 보존한다.
- active basemap만 있어도 floor.sog와 overview를 생성한다.
- active basemap이 없으면 scan 단계에서 제외한다.

## Phase 8 - SOG v2 decode와 top-down 렌더

`worker/lib/sog_decoder.py`

PlayCanvas SOG v2:

- `.sog`는 ZIP bundled variant
- metadata 파일명은 `meta.json`
- 필수 파일: `means_l.webp`, `means_u.webp`, `scales.webp`, `quats.webp`, `sh0.webp`
- optional higher SH: `shN_centroids.webp`, `shN_labels.webp`
- opacity는 별도 `opacity.webp`가 아니라 `sh0.webp`의 alpha channel

디코딩 규칙:

- `meta.count`까지만 사용
- positions: `means_u/l` 16-bit 값 -> meta range -> symmetric log inverse
- scales: `meta.scales.codebook[index]`로 얻는 선형 scale. `exp()`를 다시 적용하지 않음
- opacity: `sh0.a / 255`. `sigmoid()`를 다시 적용하지 않음
- sh0: `meta.sh0.codebook[index]`는 DC coefficient
- quats: SOG spec은 `[x, y, z, w]` 순서 설명이다. `gsplat` 입력 순서는 fixture로 검증 후 reorder

`worker/pipeline/render_overview.py`

- 서버 이미지는 top-down orthographic이다. CSS에서 `rotateX(30deg)`/hover
  `rotateX(45deg)`를 적용하므로 서버가 30도 isometric 이미지를 만들지 않는다.
- 기존 viewer convention에 맞춰 baseline Z-180을 반영한다.
  - 위치: `(x, y, z) -> (-x, -y, z)`
  - quaternion도 같은 회전을 반영하거나 동등한 camera/view matrix로 처리한다.
- bbox는 opacity >= 0.05인 splat 중심으로 계산한다.
- camera/up convention은 `frontend/src/lib/gs/floorplan.ts`의 top-down 주석을 기준으로 맞춘다.
- `gsplat.rasterization`은 기존 `core/door_detection/render/splat_renderer.py`처럼
  `means`, `quats`, `scales`, `opacities`, `colors`, `viewmats`, `Ks`를 명시한다.
  `eye=`, `target=`, `up=` wrapper API를 가정하지 않는다.

상수:

```python
OVERVIEW_WIDTH = 1024
OVERVIEW_HEIGHT = 768
OVERVIEW_WEBP_QUALITY = 85
OVERVIEW_PADDING_M = 0.5
OVERVIEW_ALPHA_CUTOFF = 0.05
```

출력:

- `floors/{floor_id}/overview/{unix_ms}.webp`
- `floors/{floor_id}/overview/{unix_ms}.json`

## Phase 9 - Frontend

`frontend/src/app/buildings/[name]/page.tsx`

- `/data/1.webp`, `/data/2.webp` fallback 제거
- `floor.topdown_url`만 이미지로 사용
- `topdown_url`이 없고 `overview_dirty=True`면 생성 중 placeholder
- `topdown_url`이 없고 `overview_dirty=False`면 빈 placeholder
- mount, window focus, `visibilitychange`에서 `/floor-overview` refetch
- hover는 CSS 3D transform으로만 처리

```tsx
<button
  style={{ transformStyle: 'preserve-3d' }}
  className={`
    transition-[transform,opacity,box-shadow] duration-300 ease-out origin-center
    ${hovered ? '[transform:rotateX(45deg)_scale(1.04)] z-10' : '[transform:rotateX(30deg)]'}
    ${dimmed ? 'opacity-40' : 'opacity-100'}
  `}
>
  {imageUrl ? <img src={imageUrl} ... /> : <Placeholder dirty={floor.overview_dirty} />}
</button>
```

## 변경 파일 매트릭스

| 파일 | 변경 |
|---|---|
| `backend/app/models/__init__.py` | `Basemap.sog_path`, `Floor.floor_sog_path`, `floor_sog_version`, `overview_dirty_at`, `overview_error` |
| `backend/alembic/versions/xxxx_floor_overview_pipeline.py` | migration + backfill |
| `backend/app/services/floor_overview.py` | dirty helper, input manifest query helper |
| `backend/app/api/basemaps.py` | activate 시 dirty mark + basemap SOG conversion dispatch |
| `backend/app/api/uploads.py` | `/uploads/{id}/alignment`에 `aligned_ply_key` 추가, aligned SceneOutput 생성 |
| `backend/app/api/refine.py` | dirty helper 사용 |
| `backend/app/api/internal_worker.py` | SOG conversion callback, dirty scan, claim, overview callbacks |
| `backend/app/services/celery_service.py` | conversion/overview task dispatch helper |
| `worker/Dockerfile.gpu` | CUDA/torch/gsplat/Pillow/splat-transform 설치 |
| `worker/celery_app.py` | imports, routes, beat schedule |
| `worker/pipeline/sog_converter.py` | stub 제거, `splat-transform --filter-harmonics 0` |
| `worker/pipeline/floor_aggregator.py` | 신규 |
| `worker/lib/sog_decoder.py` | 신규, SOG v2 decoder |
| `worker/pipeline/render_overview.py` | 신규, top-down orthographic renderer |
| `worker/tasks/conversion.py` | 신규 |
| `worker/tasks/overview.py` | 신규 |
| `frontend/src/components/viewer/tools/DoorAlignModal.tsx` | `refined-upload-url` key 사용, alignment request에 `aligned_ply_key` 포함 |
| `frontend/src/app/buildings/[name]/page.tsx` | fallback 제거, CSS 3D hover, focus refetch |

## 테스트 계획

Backend:

- migration upgrade/downgrade
- `mark_floor_overview_dirty`가 `overview_dirty_at`까지 갱신하는지
- `/uploads/{id}/alignment`가 `aligned_ply_key`를 받으면 Task/SceneOutput을 생성하는지
- worker callback token 검증
- overview success callback이 stale dirty를 clear하지 않는지
- dirty scan이 active basemap 없는 floor를 제외하는지

Worker:

- tiny PLY -> SOG 변환 smoke test
- SOG v2 decode count/bbox/opacity 테스트
- floor aggregator가 hidden module, non-aligned SceneOutput, missing object를 제외하는지
- 대형 입력 mock에서 chunk/voxel accumulator가 full concat 없이 동작하는지
- renderer output이 nonblank이고 alpha coverage가 최소 임계값 이상인지

Frontend:

- `topdown_url` 없을 때 sample image를 쓰지 않는지
- focus/visibilitychange refetch 동작
- hover transform이 desktop/mobile 폭에서 레이아웃을 밀지 않는지

수동 검증:

1. basemap만 있는 floor에서 overview webp 생성
2. module 정합 완료 후 같은 floor overview가 dirty -> 새 이미지로 갱신
3. 렌더 중 module visibility 변경 시 첫 callback이 dirty를 지우지 않고 다음 render가 이어지는지
4. generated webp가 PlayCanvas viewer의 top-down 방향과 일치하는지

## 구현 순서

1. DB migration + dirty helper 적용
2. `/uploads/{id}/alignment` 확장과 DoorAlignModal key 전달
3. `splat-transform` 설치와 conversion task/callback
4. overview dirty scan/claim/callback backend 계약
5. floor aggregator
6. SOG v2 decoder
7. top-down `gsplat` renderer
8. frontend fallback 제거와 focus refetch
9. cleanup task: 오래된 overview webp/meta는 최근 3세트만 보존

## 보류 항목

- WebSocket push: focus refetch로 1차 구현 후 필요하면 `floor.overview_ready` 추가
- renderer output 해상도: 기본 `1024x768/q85`, 상수화해서 조정 가능하게 둔다
- SOG quaternion reorder: decoder fixture로 `gsplat` 기대 순서를 확정한 뒤 구현한다
- CPU-only SOG compression 성능: 실제 데이터로 benchmark 후 conversion queue 분리 여부 결정
