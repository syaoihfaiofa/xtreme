FROM python:3.11-slim AS exporter

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements-export.txt .
RUN python -m pip install --no-cache-dir -r requirements-export.txt

COPY keypoint_lifted ./keypoint_lifted

ENTRYPOINT ["python", "-m", "keypoint_lifted.export_onnx"]


FROM nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir --upgrade pip \
    && python3 -m pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY keypoint_lifted ./keypoint_lifted

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
    CMD curl --silent --fail http://localhost:5000/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
