FROM nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/centernet/lib

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir --upgrade pip \
    && python3 -m pip install --no-cache-dir -r requirements.txt \
    && python3 -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu118 torch==2.1.2 torchvision==0.16.2

COPY app.py .
COPY centernet ./centernet
COPY config ./config
COPY models ./models

EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=5 \
    CMD curl --silent --fail http://localhost:5000/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
