# Reuses the host conda environment with mmdet3d + compiled BEVFusion ops.
# Mount /opt/conda and the mmdetection3d repo via docker-compose volumes.
ARG BASE_IMAGE=pytorch/pytorch:2.1.0-cuda11.8-cudnn8-devel
FROM ${BASE_IMAGE}

WORKDIR /app
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt

COPY *.py gunicorn.conf.py entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV PYTHONPATH=/mmdetection3d

EXPOSE 5000
ENTRYPOINT ["/app/entrypoint.sh"]
