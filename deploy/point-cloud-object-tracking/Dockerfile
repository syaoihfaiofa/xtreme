ARG BASE_IMAGE=python:3.10-slim
FROM ${BASE_IMAGE}

WORKDIR /app
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt

# Heavy CenterPoint dependencies are optional so the service can still start in
# fallback mode on machines that only need API compatibility checks.
ARG INSTALL_MMLAB=false
RUN if [ "$INSTALL_MMLAB" = "true" ]; then \
      pip install --no-cache-dir -U openmim && \
      mim install "mmengine>=0.7.1" "mmcv>=2.0.0" "mmdet>=3.0.0" "mmdet3d>=1.2.0"; \
    fi

COPY *.py .
RUN mkdir -p /models

EXPOSE 5000
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]
