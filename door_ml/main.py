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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect", response_model=DetectResponse)
async def detect(
    file: UploadFile = File(...),
    prompt: str = "white door",
    sam3_prob: float = 0.55,
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

        exit_code = pipeline_main([
            "--ply", ply_path,
            "--output_json", output_path,
            "--cache_dir", os.path.join(tmpdir, "cache"),
            "--prompt", prompt,
            "--sam3_prob", str(sam3_prob),
            "--camera_mode", "walk",
            "--n_coarse", "32",
            "--n_walk_positions", "4",
        ])

        if exit_code != 0:
            raise RuntimeError("pipeline exited with non-zero code")

        with open(output_path, encoding="utf-8") as f:
            data = json.load(f)

        corners = data["door_corners_3d"]
        return DetectResponse(
            left_top=CornerPoint(x=corners["left_top"][0],    y=corners["left_top"][1],    z=corners["left_top"][2]),
            right_top=CornerPoint(x=corners["right_top"][0],  y=corners["right_top"][1],   z=corners["right_top"][2]),
            right_bottom=CornerPoint(x=corners["right_bottom"][0], y=corners["right_bottom"][1], z=corners["right_bottom"][2]),
            left_bottom=CornerPoint(x=corners["left_bottom"][0],   y=corners["left_bottom"][1],  z=corners["left_bottom"][2]),
        )

    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"파이프라인 실행 실패: {exc}") from exc
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
