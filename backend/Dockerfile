FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 프로젝트 루트의 core/, utilities/ 모듈을 컨테이너에서 import 할 수 있도록
# docker-compose에서 볼륨 마운트하거나, 빌드 컨텍스트를 프로젝트 루트로 설정해야 함
# → docker-compose.yml에서 volumes로 마운트

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
