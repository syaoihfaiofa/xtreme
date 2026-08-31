#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a separate Xtreme1 schema inside the running MySQL container.
# It intentionally does not reuse docker-entrypoint-initdb.d: that hook runs only
# when the MySQL volume is first created, while this script is safe for new schemas.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION_DIR="$ROOT/deploy/mysql/migration"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-mysql.sh <database-name> [--force]

Create a new Xtreme1 database and apply migrations V1 through V26 in the required order.

Environment:
  MYSQL_CONTAINER  Running MySQL container name. Defaults to `docker compose ps -q mysql`.

Options:
  --force          Drop an existing database of the same name before recreating it.

Examples:
  scripts/bootstrap-mysql.sh xtreme1_preview
  MYSQL_CONTAINER=xtreme-mysql-1 scripts/bootstrap-mysql.sh xtreme1_test --force
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

DATABASE="$1"
FORCE="${2:-}"
if [[ ! "$DATABASE" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Database name may contain only letters, numbers, and underscores." >&2
  exit 2
fi
if [[ -n "$FORCE" && "$FORCE" != "--force" ]]; then
  usage >&2
  exit 2
fi

MYSQL_CONTAINER="${MYSQL_CONTAINER:-$(cd "$ROOT" && docker compose ps -q mysql)}"
if [[ -z "$MYSQL_CONTAINER" ]]; then
  echo "MySQL container not found. Start it with: docker compose up -d mysql" >&2
  exit 1
fi
if ! docker inspect -f '{{.State.Running}}' "$MYSQL_CONTAINER" 2>/dev/null | grep -qx true; then
  echo "MySQL container is not running: $MYSQL_CONTAINER" >&2
  exit 1
fi

APP_USER="$(docker exec "$MYSQL_CONTAINER" sh -c 'printf %s "$MYSQL_USER"')"
if [[ ! "$APP_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "MYSQL_USER inside the container must contain only letters, numbers, and underscores." >&2
  exit 1
fi

mysql_query() {
  docker exec -i "$MYSQL_CONTAINER" sh -c \
    'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" -Nse "$1"' sh "$1"
}

database_exists="$(mysql_query "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '$DATABASE'")"
if [[ -n "$database_exists" ]]; then
  table_count="$(mysql_query "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '$DATABASE'")"
  if [[ "$table_count" -gt 0 && "$FORCE" != "--force" ]]; then
    echo "Database '$DATABASE' already contains $table_count tables; refusing to overwrite." >&2
    echo "Re-run with --force only if deleting that database is intended." >&2
    exit 1
  fi
  if [[ "$FORCE" == "--force" ]]; then
    echo "Dropping existing database '$DATABASE'..."
    mysql_query "DROP DATABASE \`$DATABASE\`"
  fi
fi

echo "Creating database '$DATABASE'..."
mysql_query "CREATE DATABASE IF NOT EXISTS \`$DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
mysql_query "GRANT ALL PRIVILEGES ON \`$DATABASE\`.* TO '$APP_USER'@'%'; FLUSH PRIVILEGES"

# Keep this sequence aligned with deploy/mysql/docker-init/01-run-migrations.sh.
MIGRATIONS=(
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
  "V22__Update_bevfusion_lidar_camera_model.sql"
  "V23__Add_image_keypoint_lifted_detection_model.sql"
  "V24__Add_image_keypoint_lifted_polyline_classes.sql"
  "V25__Add_scene_location_roll_pitch.sql"
  "V26__Add_point_cloud_preview_relation.sql"
)

for migration in "${MIGRATIONS[@]}"; do
  path="$MIGRATION_DIR/$migration"
  if [[ ! -f "$path" ]]; then
    echo "Missing migration: $path" >&2
    exit 1
  fi
  echo "Applying $migration"
  docker exec -i "$MYSQL_CONTAINER" sh -c \
    'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$1"' sh "$DATABASE" < "$path"
done

echo "Database '$DATABASE' is ready."
