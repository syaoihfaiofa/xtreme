#!/bin/bash
set -euo pipefail

MIGRATION_DIR="/migrations"
ORDER=(
  "V1__Create_tables.sql"
  "V2__Init_data.sql"
  "V3__Add_tracking_model.sql"
  "V4__Group_trial_frames_to_scene.sql"
  "V12__Add_data_annotation_comment.sql"
  "V13__Add_scene_location_sample_table.sql"
  "V14__Add_bevfusion_detection_model.sql"
  "V15__Add_bevfusion_detection_model_classes.sql"
  "V18__Add_dataset_sync_mode.sql"
  "V16__Add_dataset_inference_mode.sql"
  "V17__Add_user_role.sql"
  "V19__Add_scene_location_table.sql"
  "V20__Add_parking_slot_tool_type.sql"
  "V21__Add_curb_wall_tool_type.sql"
)

for migration in "${ORDER[@]}"; do
  echo "Running migration: ${migration}"
  mysql -u root -p"${MYSQL_ROOT_PASSWORD}" xtreme1 < "${MIGRATION_DIR}/${migration}"
done
