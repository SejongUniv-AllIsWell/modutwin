"""
door-ml 서비스 — FastAPI HTTP 서버.

PLY 파일을 받아 door_detection 파이프라인을 실행하고
문의 4개 코너 좌표를 반환한다.

POST /detect
  multipart: file=<ply bytes>
  response: { left_top, right_top, right_bottom, left_bottom }

GET /health
  response: { status: "ok" }
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# core/, utilities/ 는 docker-compose 볼륨 마운트로 /app/core, /app/utilities 에 위치
sys.path.insert(0, "/app")
os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "12.0")

app = FastAPI(title="Door ML Worker")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class CornerPoint(BaseModel):
    x: float
    y: float
    z: float


class DetectResponse(BaseModel):
    left_top: CornerPoint
    right_top: CornerPoint
    right_bottom: CornerPoint
    left_bottom: CornerPoint
    # N-door: 추출된 모든 문 목록. 단일 문이면 길이 1.
    all_doors: list[dict] = []


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect", response_model=DetectResponse)
async def detect(
    file: UploadFile = File(...),
    prompt: str = "white door",
    sam3_prob: float = 0.55,
    interior_min_hits: int = 22,
    interior_perp_ratio: float = 0.01,
    interior_strict: bool = True,
    # 방법 B — 다듬기에서 확정된 A' 천장/바닥 (4개 모두 주면 known-room mode).
    rot_x: float | None = None,
    rot_z: float | None = None,
    floor_y: float | None = None,
    ceiling_y: float | None = None,
    wall_polygon: str | None = None,
):
    """
    PLY 파일을 받아 문의 4개 코너 3D 좌표를 반환한다.
    처리 시간: 약 1~3분 (SAM3 + gsplat 렌더링).
    """
    if not (file.filename or "").lower().endswith(".ply"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=".ply 파일만 지원합니다.")

    tmpdir = tempfile.mkdtemp(prefix="door_detect_")
    ply_path = os.path.join(tmpdir, "scene.ply")
    output_path = os.path.join(tmpdir, "corners.json")

    try:
        with open(ply_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        from core.door_detection.pipeline import main as pipeline_main

        pipeline_args = [
            "--ply", ply_path,
            "--output_json", output_path,
            "--cache_dir", os.path.join(tmpdir, "cache"),
            "--prompt", prompt,
            "--sam3_prob", str(sam3_prob),
            "--interior_min_hits", str(interior_min_hits),
            "--interior_perp_ratio", str(interior_perp_ratio),
            "--camera_mode", "walk",
            "--n_coarse", "32",
            "--n_walk_positions", "4",
        ]
        if not interior_strict:
            pipeline_args.append("--no_interior_strict")

        known_room = (
            rot_x is not None and rot_z is not None
            and floor_y is not None and ceiling_y is not None
        )
        if known_room:
            pipeline_args += [
                "--rot_x", str(rot_x), "--rot_z", str(rot_z),
                "--floor_y", str(floor_y), "--ceiling_y", str(ceiling_y),
            ]
            if wall_polygon:
                pipeline_args += ["--wall_polygon", wall_polygon]

        exit_code = pipeline_main(pipeline_args)

        if exit_code != 0:
            raise RuntimeError("pipeline exited with non-zero code")

        with open(output_path, encoding="utf-8") as f:
            data = json.load(f)

        corners = data["door_corners_3d"]
        # N-door: all_doors 리스트 직렬화 (없으면 primary 1개)
        raw_all = data.get("all_doors", [corners])
        all_doors_resp = [
            {k: {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])} for k, v in door.items()}
            for door in raw_all
        ]
        return DetectResponse(
            left_top=CornerPoint(x=corners["left_top"][0],    y=corners["left_top"][1],    z=corners["left_top"][2]),
            right_top=CornerPoint(x=corners["right_top"][0],  y=corners["right_top"][1],   z=corners["right_top"][2]),
            right_bottom=CornerPoint(x=corners["right_bottom"][0], y=corners["right_bottom"][1], z=corners["right_bottom"][2]),
            left_bottom=CornerPoint(x=corners["left_bottom"][0],   y=corners["left_bottom"][1],  z=corners["left_bottom"][2]),
            all_doors=all_doors_resp,
        )

    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"파이프라인 실행 실패: {exc}") from exc
    finally:
        # 디버그: 마지막 검출의 렌더/캐시를 고정 경로에 보존하고, 선택적으로 호스트
        # 바인드 마운트 경로에도 run별로 export 한다.
        if os.environ.get("DOOR_ML_DEBUG_RENDERS"):
            try:
                keep_dir = "/tmp/door_detect_last"
                shutil.rmtree(keep_dir, ignore_errors=True)
                cache_src = os.path.join(tmpdir, "cache")
                if os.path.isdir(cache_src):
                    shutil.copytree(cache_src, keep_dir)

                export_root = os.environ.get("DOOR_ML_DEBUG_RENDERS_DIR")
                if export_root and os.path.isdir(cache_src):
                    run_export_dir = Path(export_root) / Path(tmpdir).name
                    shutil.rmtree(run_export_dir, ignore_errors=True)
                    run_export_dir.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(cache_src, run_export_dir)
            except Exception:
                pass
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
