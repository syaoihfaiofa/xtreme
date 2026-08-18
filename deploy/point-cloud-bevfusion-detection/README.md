# point-cloud-bevfusion-detection

A `LIDAR_DETECTION` model service for Xtreme1 that runs the custom
BEVFusion LiDAR-only 3-class detector (`Car` / `Cone` / `Pillar`) directly
on the uploaded point cloud.

## Pipeline

1. Download `pointCloudUrl` from Xtreme1 (`.pcd` or binary float32).
2. Pad to 5 channels when needed (`x y z intensity timestamp`).
3. Apply the same single-frame preprocessing used at deployment time:
   `FilterVehicleBlindZone` + `PointsRangeFilter`.
4. Run `mmdet3d.apis.inference_detector` with the trained BEVFusion
   checkpoint.
5. Return oriented 3D boxes in Xtreme1 format.

## API

`POST /pointCloud/recognition`

`GET /health`

## Running

```bash
cd /PnP/lxzhu/lidar_annos/xtreme1
export HOME=/PnP/lxzhu

docker compose build point-cloud-bevfusion-detection
docker compose --profile model up -d point-cloud-bevfusion-detection
curl -sf http://localhost:8298/health
```

The service mounts only the mmdetection3d repo:

- `${BEVFUSION_DETECTION_REPO_DIR:-/PnP/lxzhu/mmdetection3d}` as `/mmdetection3d`

On first start the entrypoint installs mmcv/mmdet/mmdet3d into the container
and builds `bev_pool` if needed (may take a few minutes). Do **not** mount
host `/opt/conda` unless that path really exists; an empty mount breaks Python.

Switch checkpoints without rebuilding:

```bash
BEVFUSION_DETECTION_CHECKPOINT=work_dirs/bevfusion_lidar_custom_nus_3class/epoch_15.pth \
  docker compose --profile model up -d point-cloud-bevfusion-detection
```

## Registering in the Models page

`V14__Add_bevfusion_detection_model.sql` and
`V15__Add_bevfusion_detection_model_classes.sql` register the model and its
selectable classes. For an existing database:

```bash
docker exec -i xtreme1-mysql-1 mysql -uxtreme1 -pRc4K3L6f xtreme1 \
  < deploy/mysql/migration/V14__Add_bevfusion_detection_model.sql
docker exec -i xtreme1-mysql-1 mysql -uxtreme1 -pRc4K3L6f xtreme1 \
  < deploy/mysql/migration/V15__Add_bevfusion_detection_model_classes.sql
```

After that the model appears at `http://<host>:8190/#/models/list` as
**BEVFusion LiDAR 3-Class Detection**.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BEVFUSION_DETECTION_CONFIG` | `work_dirs/.../bevfusion_lidar_voxel0075_custom-nus-3class.py` | model config path inside repo mount |
| `BEVFUSION_DETECTION_CHECKPOINT` | `work_dirs/.../epoch_20.pth` | checkpoint path inside repo mount |
| `BEVFUSION_DETECTION_SCORE_THRESHOLD` | `0.25` | minimum detection score |
| `BEVFUSION_DETECTION_WORKERS` | `1` | gunicorn workers (keep low for GPU memory) |
| `BEVFUSION_DETECTION_REPO_DIR` | `/PnP/lxzhu/mmdetection3d` | host path mounted to `/mmdetection3d` |
