# Curb/wall Sync Radius Clip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 静态 `GROUND_POLYLINE`（curb/wall）同步时按点云原点圆裁剪，重叠处世界位置不变，长度可通过各帧世界折线合并而变化。

**Architecture:** 在 `TrackSyncUseCase` 增加纯函数：圆裁剪、世界坐标转换、源优先合并。`syncGroundPolyline` 对每帧执行「源折线转世界 → 与该帧已有世界折线合并 → 转局部 → 按 `syncDistance` 裁剪」，有效点少于 2 个则删除。不改前端。

**Tech Stack:** Java 11、JUnit 5、Hutool `JSONArray`/`JSONObject`、现有 `TrackSyncUseCase` 位姿变换

**Spec:** `docs/superpowers/specs/2026-08-21-curb-wall-sync-clip-design.md`

## Global Constraints

- 代码、标识符、注释用 English
- 圆心是目标帧局部 `(0, 0)`，半径是对象 `syncDistance`，距离用 `hypot(x, y)`
- 圆内多段只留 `distanceToGroundShapeFootprint` 最小的一段
- 静态不等于长度冻结：源覆盖重叠段，已有折线在源范围外的翼段保留
- 重叠判定阈值 `0.2` 米
- 工作目录：`/PnP/lxzhu/lidar_annos/xtreme`
- 后端测试：`cd backend && mvn -q -Dtest=TrackSyncUseCaseTest test`
- 不改 `GROUND_POLYGON`、3D 框、前端裁剪
- 每任务独立可测；不要顺手重构无关代码

## File map

| File | Responsibility |
| --- | --- |
| `backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java` | 裁剪、合并、接入 `syncGroundPolyline` |
| `backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java` | 纯函数单测 |

---

### Task 1: Clip polyline to radius

**Files:**
- Modify: `backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java`
- Modify: `backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java`

**Interfaces:**
- Consumes: `distanceToGroundShapeFootprint`, `getDouble` (keep private; clip lives in the same class)
- Produces: `static JSONArray clipGroundPolylineToRadius(JSONArray points, double radius)` — empty array when nothing remains

- [ ] **Step 1: Write the failing tests**

在 `TrackSyncUseCaseTest` 增加：

```java
    @Test
    void clipGroundPolylineToRadius_keepsInsideHalfAndInsertsBoundary() {
        JSONArray points = new JSONArray();
        points.add(point(0, 0, 1));
        points.add(point(20, 0, 1));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(2, clipped.size());
        assertPoint(clipped.getJSONObject(0), 0, 0, 1);
        assertEquals(10, clipped.getJSONObject(1).getDouble("x"), 0.000001);
        assertEquals(0, clipped.getJSONObject(1).getDouble("y"), 0.000001);
        assertEquals(1, clipped.getJSONObject(1).getDouble("z"), 0.000001);
    }

    @Test
    void clipGroundPolylineToRadius_returnsEmptyWhenFullyOutside() {
        JSONArray points = new JSONArray();
        points.add(point(20, 0, 0));
        points.add(point(30, 0, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(0, clipped.size());
    }

    @Test
    void clipGroundPolylineToRadius_keepsChordWhenSegmentCrossesCircle() {
        JSONArray points = new JSONArray();
        points.add(point(-20, 0, 2));
        points.add(point(20, 0, 2));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(2, clipped.size());
        assertEquals(-10, clipped.getJSONObject(0).getDouble("x"), 0.000001);
        assertEquals(10, clipped.getJSONObject(1).getDouble("x"), 0.000001);
        assertEquals(2, clipped.getJSONObject(0).getDouble("z"), 0.000001);
    }

    @Test
    void clipGroundPolylineToRadius_keepsNearestComponent() {
        JSONArray points = new JSONArray();
        points.add(point(-12, 8, 0));
        points.add(point(-8, 8, 0));
        points.add(point(8, 3, 0));
        points.add(point(12, 3, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(2, clipped.size());
        assertEquals(3, clipped.getJSONObject(0).getDouble("y"), 0.000001);
        assertEquals(3, clipped.getJSONObject(1).getDouble("y"), 0.000001);
    }

    @Test
    void clipGroundPolylineToRadius_keepsVertexWithBothExits() {
        JSONArray points = new JSONArray();
        points.add(point(-20, 0, 0));
        points.add(point(0, 0, 4));
        points.add(point(20, 0, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(3, clipped.size());
        assertPoint(clipped.getJSONObject(1), 0, 0, 4);
        assertEquals(-10, clipped.getJSONObject(0).getDouble("x"), 0.000001);
        assertEquals(10, clipped.getJSONObject(2).getDouble("x"), 0.000001);
    }

    @Test
    void clipGroundPolylineToRadius_preservesFullyInsideSegment() {
        JSONArray points = new JSONArray();
        points.add(point(1, 1, 0));
        points.add(point(2, 1, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(2, clipped.size());
        assertPoint(clipped.getJSONObject(0), 1, 1, 0);
        assertPoint(clipped.getJSONObject(1), 2, 1, 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && mvn -q -Dtest=TrackSyncUseCaseTest#clipGroundPolylineToRadius_keepsInsideHalfAndInsertsBoundary test`

Expected: FAIL，方法不存在

- [ ] **Step 3: Implement clip**

在 `TrackSyncUseCase` 中、`distanceToGroundShapeFootprint` 之前加入（package-visible static，供测试调用）。`point3D` 已是 private，clip 复用它：

```java
    static JSONArray clipGroundPolylineToRadius(JSONArray points, double radius) {
        if (points == null || points.size() < 2 || radius <= 0) {
            return new JSONArray();
        }
        List<JSONArray> components = new ArrayList<>();
        JSONArray current = new JSONArray();
        for (int index = 1; index < points.size(); index++) {
            JSONObject start = points.getJSONObject(index - 1);
            JSONObject end = points.getJSONObject(index);
            if (start == null || end == null) {
                throw new IllegalArgumentException(String.format("Ground shape point is invalid: index=%s", index));
            }
            JSONArray piece = clipSegmentToRadius(start, end, radius);
            if (piece.isEmpty()) {
                if (current.size() >= 2) {
                    components.add(current);
                }
                current = new JSONArray();
                continue;
            }
            if (current.isEmpty()) {
                current.addAll(piece);
            } else {
                for (int pieceIndex = 1; pieceIndex < piece.size(); pieceIndex++) {
                    current.add(piece.get(pieceIndex));
                }
            }
        }
        if (current.size() >= 2) {
            components.add(current);
        }
        JSONArray nearest = new JSONArray();
        double nearestDistance = Double.POSITIVE_INFINITY;
        for (JSONArray component : components) {
            double distance = distanceToGroundShapeFootprint(component);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = component;
            }
        }
        return nearest;
    }

    private static JSONArray clipSegmentToRadius(JSONObject start, JSONObject end, double radius) {
        double x1 = getDouble(start, "x");
        double y1 = getDouble(start, "y");
        double z1 = getDouble(start, "z");
        double x2 = getDouble(end, "x");
        double y2 = getDouble(end, "y");
        double z2 = getDouble(end, "z");
        boolean startInside = Math.hypot(x1, y1) <= radius + 0.000000001;
        boolean endInside = Math.hypot(x2, y2) <= radius + 0.000000001;
        List<Double> hits = circleLineHits(x1, y1, x2, y2, radius);
        JSONArray piece = new JSONArray();
        if (startInside) {
            piece.add(point3D(x1, y1, z1));
        }
        for (double t : hits) {
            if (t <= 0.000000001 || t >= 0.999999999) {
                continue;
            }
            piece.add(point3D(x1 + t * (x2 - x1), y1 + t * (y2 - y1), z1 + t * (z2 - z1)));
        }
        if (endInside) {
            piece.add(point3D(x2, y2, z2));
        }
        if (piece.size() >= 2) {
            return piece;
        }
        if (!startInside && !endInside && hits.size() >= 2) {
            JSONArray chord = new JSONArray();
            for (double t : hits) {
                chord.add(point3D(x1 + t * (x2 - x1), y1 + t * (y2 - y1), z1 + t * (z2 - z1)));
            }
            return chord;
        }
        return new JSONArray();
    }

    private static List<Double> circleLineHits(double x1, double y1, double x2, double y2, double radius) {
        double dx = x2 - x1;
        double dy = y2 - y1;
        double a = dx * dx + dy * dy;
        List<Double> hits = new ArrayList<>();
        if (a <= 0.000000001) {
            return hits;
        }
        double b = 2 * (x1 * dx + y1 * dy);
        double c = x1 * x1 + y1 * y1 - radius * radius;
        double discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
            return hits;
        }
        double root = Math.sqrt(Math.max(0, discriminant));
        double t1 = (-b - root) / (2 * a);
        double t2 = (-b + root) / (2 * a);
        if (t1 > t2) {
            double swap = t1;
            t1 = t2;
            t2 = swap;
        }
        if (t1 >= 0 && t1 <= 1) {
            hits.add(t1);
        }
        if (t2 >= 0 && t2 <= 1 && t2 - t1 > 0.000000001) {
            hits.add(t2);
        }
        return hits;
    }
```

把 `point3D` 留在原处即可，clip 与它同文件。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && mvn -q -Dtest=TrackSyncUseCaseTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java
git commit -m "$(cat <<'EOF'
Add radius clip for synced ground polylines

EOF
)"
```

---

### Task 2: Merge world polylines so length can change

**Files:**
- Modify: `backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java`
- Modify: `backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java`

**Interfaces:**
- Consumes: `clipGroundPolylineToRadius`, existing `projectGroundPoints`
- Produces:
  - `static JSONArray polylineToWorld(JSONArray localPoints, Pose pose)`
  - `static JSONArray polylineToLocal(JSONArray worldPoints, Pose pose)`
  - `static JSONArray mergeWorldPolylinesPreferringSource(JSONArray existingWorld, JSONArray sourceWorld)`
  - `static JSONArray resolveSyncedGroundPolyline(JSONArray sourceLocal, Pose sourcePose, JSONArray existingTargetLocal, Pose targetPose, double radius)`
  - overlap snap: `0.2` meters

- [ ] **Step 1: Write the failing tests**

```java
    @Test
    void mergeWorldPolylinesPreferringSource_keepsExistingWing() {
        JSONArray existing = new JSONArray();
        existing.add(point(0, 0, 0));
        existing.add(point(5, 0, 0));
        existing.add(point(10, 0, 0));
        JSONArray source = new JSONArray();
        source.add(point(5, 0, 1));
        source.add(point(10, 0, 1));

        JSONArray merged = TrackSyncUseCase.mergeWorldPolylinesPreferringSource(existing, source);

        assertEquals(3, merged.size());
        assertPoint(merged.getJSONObject(0), 0, 0, 0);
        assertPoint(merged.getJSONObject(1), 5, 0, 1);
        assertPoint(merged.getJSONObject(2), 10, 0, 1);
    }

    @Test
    void mergeWorldPolylinesPreferringSource_appendsLengthenedTip() {
        JSONArray existing = new JSONArray();
        existing.add(point(0, 0, 0));
        existing.add(point(5, 0, 0));
        JSONArray source = new JSONArray();
        source.add(point(0, 0, 0));
        source.add(point(5, 0, 0));
        source.add(point(12, 0, 2));

        JSONArray merged = TrackSyncUseCase.mergeWorldPolylinesPreferringSource(existing, source);

        assertEquals(3, merged.size());
        assertPoint(merged.getJSONObject(2), 12, 0, 2);
    }

    @Test
    void resolveSyncedGroundPolyline_clipsMergedLineInTargetFrame() {
        JSONArray sourceLocal = new JSONArray();
        sourceLocal.add(point(5, 0, 0));
        sourceLocal.add(point(15, 0, 0));
        JSONArray existingLocal = new JSONArray();
        existingLocal.add(point(-5, 0, 0));
        existingLocal.add(point(5, 0, 0));
        TrackSyncUseCase.Pose pose = new TrackSyncUseCase.Pose(0D, 0D, 0D, 0D);

        JSONArray resolved = TrackSyncUseCase.resolveSyncedGroundPolyline(
                sourceLocal, pose, existingLocal, pose, 10);

        assertEquals(3, resolved.size());
        assertEquals(-5, resolved.getJSONObject(0).getDouble("x"), 0.000001);
        assertEquals(10, resolved.getJSONObject(2).getDouble("x"), 0.000001);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && mvn -q -Dtest=TrackSyncUseCaseTest#mergeWorldPolylinesPreferringSource_keepsExistingWing test`

Expected: FAIL，方法不存在

- [ ] **Step 3: Implement merge and resolve**

在 `TrackSyncUseCase` 把 `projectGroundPoints` 改成走转换函数，并增加：

```java
    private static final double POLYLINE_OVERLAP_SNAP_M = 0.2;

    static JSONArray polylineToWorld(JSONArray localPoints, Pose pose) {
        JSONArray worldPoints = new JSONArray();
        for (int index = 0; index < localPoints.size(); index++) {
            JSONObject local = localPoints.getJSONObject(index);
            if (local == null) {
                throw new IllegalArgumentException(String.format("Ground shape point is invalid: index=%s", index));
            }
            double localX = getDouble(local, "x");
            double localY = getDouble(local, "y");
            double localZ = getDouble(local, "z");
            worldPoints.add(point3D(
                    pose.x + localX * Math.cos(pose.yaw) - localY * Math.sin(pose.yaw),
                    pose.y + localX * Math.sin(pose.yaw) + localY * Math.cos(pose.yaw),
                    pose.z + localZ));
        }
        return worldPoints;
    }

    static JSONArray polylineToLocal(JSONArray worldPoints, Pose pose) {
        JSONArray localPoints = new JSONArray();
        for (int index = 0; index < worldPoints.size(); index++) {
            JSONObject world = worldPoints.getJSONObject(index);
            if (world == null) {
                throw new IllegalArgumentException(String.format("Ground shape point is invalid: index=%s", index));
            }
            double dx = getDouble(world, "x") - pose.x;
            double dy = getDouble(world, "y") - pose.y;
            localPoints.add(point3D(
                    dx * Math.cos(pose.yaw) + dy * Math.sin(pose.yaw),
                    -dx * Math.sin(pose.yaw) + dy * Math.cos(pose.yaw),
                    getDouble(world, "z") - pose.z));
        }
        return localPoints;
    }

    static JSONArray projectGroundPoints(JSONArray sourcePoints, Pose sourcePose, Pose targetPose) {
        return polylineToLocal(polylineToWorld(sourcePoints, sourcePose), targetPose);
    }

    static JSONArray mergeWorldPolylinesPreferringSource(JSONArray existingWorld, JSONArray sourceWorld) {
        if (sourceWorld == null || sourceWorld.isEmpty()) {
            return existingWorld == null ? new JSONArray() : JSONUtil.parseArray(JSONUtil.toJsonStr(existingWorld));
        }
        if (existingWorld == null || existingWorld.isEmpty()) {
            return JSONUtil.parseArray(JSONUtil.toJsonStr(sourceWorld));
        }
        JSONObject sourceStart = sourceWorld.getJSONObject(0);
        JSONObject sourceEnd = sourceWorld.getJSONObject(sourceWorld.size() - 1);
        double dirX = getDouble(sourceEnd, "x") - getDouble(sourceStart, "x");
        double dirY = getDouble(sourceEnd, "y") - getDouble(sourceStart, "y");
        double lengthSquared = dirX * dirX + dirY * dirY;
        JSONArray prefix = new JSONArray();
        JSONArray suffix = new JSONArray();
        for (int index = 0; index < existingWorld.size(); index++) {
            JSONObject existing = existingWorld.getJSONObject(index);
            if (distanceToPolyline(existing, sourceWorld) <= POLYLINE_OVERLAP_SNAP_M) {
                continue;
            }
            double t = 0;
            if (lengthSquared > 0.000000001) {
                t = ((getDouble(existing, "x") - getDouble(sourceStart, "x")) * dirX
                        + (getDouble(existing, "y") - getDouble(sourceStart, "y")) * dirY) / lengthSquared;
            }
            if (t < 0) {
                prefix.add(existing);
            } else {
                suffix.add(existing);
            }
        }
        JSONArray merged = new JSONArray();
        merged.addAll(prefix);
        merged.addAll(sourceWorld);
        merged.addAll(suffix);
        return merged;
    }

    static JSONArray resolveSyncedGroundPolyline(
            JSONArray sourceLocal,
            Pose sourcePose,
            JSONArray existingTargetLocal,
            Pose targetPose,
            double radius) {
        JSONArray sourceWorld = polylineToWorld(sourceLocal, sourcePose);
        JSONArray existingWorld = existingTargetLocal == null || existingTargetLocal.isEmpty()
                ? new JSONArray()
                : polylineToWorld(existingTargetLocal, targetPose);
        JSONArray mergedWorld = mergeWorldPolylinesPreferringSource(existingWorld, sourceWorld);
        return clipGroundPolylineToRadius(polylineToLocal(mergedWorld, targetPose), radius);
    }

    private static double distanceToPolyline(JSONObject point, JSONArray polyline) {
        JSONArray holder = new JSONArray();
        holder.add(point);
        holder.addAll(polyline);
        JSONArray probe = new JSONArray();
        probe.add(point);
        double distance = Double.POSITIVE_INFINITY;
        double x = getDouble(point, "x");
        double y = getDouble(point, "y");
        for (int index = 0; index < polyline.size(); index++) {
            JSONObject vertex = polyline.getJSONObject(index);
            distance = Math.min(distance, Math.hypot(x - getDouble(vertex, "x"), y - getDouble(vertex, "y")));
            if (index == 0) {
                continue;
            }
            JSONObject previous = polyline.getJSONObject(index - 1);
            distance = Math.min(distance, distanceToSegment(
                    x, y,
                    getDouble(previous, "x"), getDouble(previous, "y"),
                    getDouble(vertex, "x"), getDouble(vertex, "y")));
        }
        return distance;
    }
```

删除 `distanceToPolyline` 里未使用的 `holder`/`probe` 变量，只保留点到折线距离循环。`projectGroundPoints` 用上面的实现替换原函数体，不要留两份。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && mvn -q -Dtest=TrackSyncUseCaseTest test`

Expected: PASS，包括 Task 1 的裁剪用例和原有 `projectGroundPoints` 用例

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java
git commit -m "$(cat <<'EOF'
Merge world curb polylines before per-frame radius clip

EOF
)"
```

---

### Task 3: Wire clip and merge into syncGroundPolyline

**Files:**
- Modify: `backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java` (`syncGroundPolyline` 循环体)
- Test: `backend/src/test/java/ai/basic/x1/usecase/TrackSyncUseCaseTest.java`（本任务不新加 DAO 测试，依赖 Task 2 的 `resolveSyncedGroundPolyline`）

**Interfaces:**
- Consumes: `resolveSyncedGroundPolyline(sourceLocal, sourcePose, existingTargetLocal, targetPose, radius)`
- Produces: 各帧写入裁剪后的 `contour.points`；少于 2 点则删除已有对象

- [ ] **Step 1: Replace the per-frame copy/delete branch**

把 `syncGroundPolyline` 循环里这段：

```java
            JSONArray targetPoints = projectGroundPoints(sourcePoints, sourcePose, targetPose);
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            if (distanceToGroundShapeFootprint(targetPoints) > syncRadius) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            contour.set("points", targetPoints);
```

换成：

```java
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONArray existingPoints = null;
            if (existing != null && existing.getClassAttributes() != null) {
                JSONObject existingContour = existing.getClassAttributes().getJSONObject("contour");
                existingPoints = existingContour == null ? null : existingContour.getJSONArray("points");
            }
            JSONArray targetPoints = resolveSyncedGroundPolyline(
                    sourcePoints, sourcePose, existingPoints, targetPose, syncRadius);
            if (targetPoints == null || targetPoints.size() < 2) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            contour.set("points", targetPoints);
```

`attrs` 仍从 existing 或 source 深拷贝，然后覆盖 `points` / `type` / `trackId` / `motionMode` / `syncDistance`，insert/update 逻辑不变。

源帧也走同一函数：保存请求里的完整 `sourcePoints` 用于合并，写入该帧的是裁剪结果。不要先裁源再投影，否则其他帧的翼段会丢。

- [ ] **Step 2: Run unit tests**

Run: `cd backend && mvn -q -Dtest=TrackSyncUseCaseTest test`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/TrackSyncUseCase.java
git commit -m "$(cat <<'EOF'
Clip synced curb polylines per frame without freezing length

EOF
)"
```

---

## Spec coverage

| Spec 要求 | Task |
| --- | --- |
| 以点云原点为圆心、`syncDistance` 为半径裁剪 | Task 1 |
| 插入圆周交点 | Task 1 |
| 多段只留最近一段 | Task 1 |
| 少于 2 点删除 | Task 1 + Task 3 |
| 静态但长度可变、翼段保留、源覆盖重叠 | Task 2 |
| `syncGroundPolyline` 合并后裁剪，源帧也写裁剪结果 | Task 3 |
| 不改停车位 / 3D 框 / 前端 | 无对应改动 |

## Self-review

- 无 TBD/TODO
- `clipGroundPolylineToRadius`、`mergeWorldPolylinesPreferringSource`、`resolveSyncedGroundPolyline` 名称在各 Task 一致
- `projectGroundPoints` 行为保持，测试仍应通过
- `distanceToPolyline` 实现时不要留下未使用局部变量
