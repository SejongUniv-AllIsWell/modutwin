#!/bin/bash
# door-ml 컨테이너 진입점.
# 1. HF_TOKEN 검사
# 2. SAM3 체크포인트 캐시 확인 / 없으면 다운로드
# 3. FastAPI 서버 시작

set -e

# ── 1. HF_TOKEN 필수 확인 ──────────────────────────────────────────────────────
if [ -z "$HF_TOKEN" ]; then
  echo "[door-ml] ERROR: HF_TOKEN 환경변수가 설정되지 않았습니다."
  echo "  facebook/sam3 는 gated 모델이므로 HuggingFace 접근 토큰이 필요합니다."
  echo "  1) https://huggingface.co/facebook/sam3 에서 access request 승인"
  echo "  2) https://huggingface.co/settings/tokens 에서 Read 토큰 생성"
  echo "  3) .env 파일에  HF_TOKEN=hf_xxxx  추가 후 컨테이너 재시작"
  exit 1
fi

export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"   # huggingface_hub 0.x 호환
export HF_TOKEN="$HF_TOKEN"

# ── 2. SAM3 체크포인트 사전 다운로드 (캐시 히트 시 즉시 스킵) ─────────────────
echo "[door-ml] SAM3 체크포인트 확인 중..."
python3 - <<'EOF'
import os
from huggingface_hub import hf_hub_download
token = os.environ["HF_TOKEN"]
print("  -> sam3.pt 다운로드/캐시 확인...")
hf_hub_download(repo_id="facebook/sam3", filename="sam3.pt",  token=token)
hf_hub_download(repo_id="facebook/sam3", filename="config.json", token=token)
print("  -> 완료.")
EOF

# ── 3. FastAPI 서버 시작 ───────────────────────────────────────────────────────
echo "[door-ml] 서버 시작 (0.0.0.0:8000)"
exec python3 main.py
