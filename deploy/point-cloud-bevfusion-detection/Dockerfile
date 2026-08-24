ARG BASE_IMAGE=pytorch/pytorch:2.1.0-cuda11.8-cudnn8-devel
FROM ${BASE_IMAGE}

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /app/requirements.txt \
    && pip install --no-cache-dir openmim \
    && mim install "mmengine==0.10.5" "mmcv>=2.0.0rc4,<2.2.0" "mmdet>=3.0.0,<3.3.0"

COPY vendor/mmdetection3d /opt/bevfusion/mmdetection3d
ENV TORCH_CUDA_ARCH_LIST=8.6
ENV FORCE_CUDA=1
RUN pip install --no-cache-dir -e /opt/bevfusion/mmdetection3d \
    && cd /opt/bevfusion/mmdetection3d \
    && pip install --no-cache-dir -e projects/BEVFusion

COPY models /models
COPY *.py gunicorn.conf.py entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

ENV PYTHONPATH=/opt/bevfusion/mmdetection3d
ENV BEVFUSION_CONFIG=/models/bevfusion_lidar-cam_voxel0075_custom-nus-3class.py
ENV BEVFUSION_CHECKPOINT=/models/epoch_20.pth
ENV BEVFUSION_CAR_CONFIG=/models/car.json

EXPOSE 5000
ENTRYPOINT ["/app/entrypoint.sh"]
