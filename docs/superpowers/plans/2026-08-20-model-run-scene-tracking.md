# Model Run Scene Tracking Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Fusion 三维检测模型（`LIDAR_DETECTION`、`IMAGE_KEYPOINT_LIFTED_DETECTION`）的 Model Run 能选数据集和场景，把跟踪标注直接写入场景，静止目标用离车最近帧几何按 location 外推，并只删除本次重叠预测。

**Architecture:** 前端 Run 弹窗提交 `sceneIds` 与类别映射。`ModelUseCase.modelRun` 对这两种模型走场景跟踪路径，而不是逐帧 Redis Job。`SceneInferenceUseCase` 增加 `runForModelRun`：逐帧检测（按模型代码分流）、跟踪关联、静止最近帧外推、再交给 `SceneInferenceFinalizer` 以 `sourceType=MODEL` / `sourceId=modelRunRecord.id` 写标注。部分成功复用已有 `RunStatusEnum.SUCCESS_WITH_ERROR`（对应规格中的部分成功，不新增枚举）。

**Tech Stack:** Java 11、Spring Boot 2.6、JUnit 5、Vue 3、Ant Design Vue、现有场景推理与 `TrackSyncUseCase.projectPose`

**Spec:** `docs/superpowers/specs/2026-08-20-model-run-scene-tracking-design.md`

## Global Constraints

- 代码、标识符、注释用 English；用户可见文案走 i18n，中文写 `zh-CN`
- 不改 pc-tool 手动同步；不删除 `DATA_FLOW` / `IMPORTED` 标注
- 不把 15 类模型发到点云检测 URL
- 静止距离：`hypot(center.x, center.y)`；并列先比 confidence 高，再比更小 `dataId`
- 同步半径默认 `12.0`；关联 IoU 默认 `0.3`；置信度下限默认 `0.5`
- 部分成功状态用 `SUCCESS_WITH_ERROR`，错误信息列出失败场景
- 工作目录：`/PnP/lxzhu/lidar_annos/xtreme`
- 后端测试：`cd backend && mvn -q -Dtest=<ClassName> test`
- 每任务独立可测；不要顺手重构无关代码

## File map

| File | Responsibility |
| --- | --- |
| `backend/src/main/java/ai/basic/x1/entity/ModelRunSceneTrackingParamBO.java` | 解析 Run 的 sceneIds、映射、IoU、置信度 |
| `backend/src/main/java/ai/basic/x1/adapter/dto/request/ModelRunFilterDataDTO.java` | 增加 `sceneIds` |
| `backend/src/main/java/ai/basic/x1/entity/ModelRunFilterDataBO.java` | 增加 `sceneIds` |
| `backend/src/main/java/ai/basic/x1/util/ModelParamUtils.java` | 校验场景跟踪参数 |
| `backend/src/main/java/ai/basic/x1/usecase/StaticTrackExtrapolation.java` | 选最近帧并按位姿外推静止轨迹 |
| `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceDetectionAdapter.java` | 点云检测 / keypoint-lifted 统一成跟踪物体 |
| `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceUseCase.java` | `runForModelRun` |
| `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceFinalizer.java` | 按 MODEL + modelRunId 替换本 Run 标注 |
| `backend/src/main/java/ai/basic/x1/usecase/ModelUseCase.java` | 分流、循环场景、汇总状态、重跑清理 |
| `frontend/main/src/api/business/model/modelsModel.ts` | Run 参数类型 |
| `frontend/main/src/components/BasicCustom/ModelRun/index.vue` | 场景多选、类别详情表 |
| `frontend/main/src/views/models/modelDetail/components/Runs.vue` | 拉场景、提交 |
| `frontend/main/src/locales/lang/zh-CN/business/models.ts` | 文案 |

---

### Task 1: Scene tracking Run 参数与校验

**Files:**
- Create: `backend/src/main/java/ai/basic/x1/entity/ModelRunSceneTrackingParamBO.java`
- Modify: `backend/src/main/java/ai/basic/x1/adapter/dto/request/ModelRunFilterDataDTO.java`
- Modify: `backend/src/main/java/ai/basic/x1/entity/ModelRunFilterDataBO.java`
- Modify: `backend/src/main/java/ai/basic/x1/util/ModelParamUtils.java`
- Modify: `backend/src/test/java/ai/basic/x1/util/ModelParamUtilsTest.java`

**Interfaces:**
- Consumes: `ModelCodeEnum.LIDAR_DETECTION`, `IMAGE_KEYPOINT_LIFTED_DETECTION`; `DatasetInferenceConfig.ClassMapping`
- Produces: `ModelRunSceneTrackingParamBO.parse(JSONObject resultFilterParam, List<Long> sceneIds)`；`ModelParamUtils.valid` 在这两种模型且存在 `classMappings` 时校验映射

- [ ] **Step 1: Write the failing tests**

在 `ModelParamUtilsTest` 增加：

```java
@Test
void valid_acceptsSceneTrackingMappingsForKeypointLifted() {
    assertDoesNotThrow(() -> ModelParamUtils.valid(
            JSONUtil.parseObj("{"
                    + "\"classes\":[\"pillar\"],"
                    + "\"minConfidence\":0.5,"
                    + "\"maxConfidence\":1,"
                    + "\"associationIou\":0.3,"
                    + "\"classMappings\":[{"
                    + "\"modelClassCode\":\"pillar\","
                    + "\"datasetClassId\":12,"
                    + "\"motionMode\":\"STATIC\"}]"
                    + "}"),
            ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
}

@Test
void valid_rejectsSceneTrackingMappingWithoutDatasetClassId() {
    assertThrows(RuntimeException.class, () -> ModelParamUtils.valid(
            JSONUtil.parseObj("{"
                    + "\"classes\":[\"pillar\"],"
                    + "\"minConfidence\":0.5,"
                    + "\"maxConfidence\":1,"
                    + "\"classMappings\":[{"
                    + "\"modelClassCode\":\"pillar\","
                    + "\"motionMode\":\"STATIC\"}]"
                    + "}"),
            ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && mvn -q -Dtest=ModelParamUtilsTest#valid_rejectsSceneTrackingMappingWithoutDatasetClassId test`

Expected: FAIL，因为当前 `valid` 把 JSON 转成 `PreModelParamDTO` 并忽略 `classMappings`

- [ ] **Step 3: Implement param BO and validation**

`ModelRunFilterDataDTO` / `ModelRunFilterDataBO` 增加 `private List<Long> sceneIds;`（DTO 不加 NotNull，由 UseCase 在场景跟踪路径校验）。

创建：

```java
package ai.basic.x1.entity;

import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModelRunSceneTrackingParamBO {

    private Double minConfidence;
    private Double maxConfidence;
    private Double associationIou;
    private Double syncDistance;
    @Builder.Default
    private List<String> classes = new ArrayList<>();
    @Builder.Default
    private List<DatasetInferenceConfig.ClassMapping> classMappings = new ArrayList<>();

    public static boolean hasClassMappings(cn.hutool.json.JSONObject resultFilterParam) {
        return resultFilterParam != null
                && resultFilterParam.getJSONArray("classMappings") != null
                && !resultFilterParam.getJSONArray("classMappings").isEmpty();
    }

    public DatasetInferenceConfig toInferenceConfig(Long modelId) {
        DatasetInferenceConfig config = new DatasetInferenceConfig();
        config.setModelId(modelId);
        config.setMinConfidence(minConfidence == null ? 0.5 : minConfidence);
        config.setAssociationIou(associationIou == null ? 0.3 : associationIou);
        config.setSyncDistance(syncDistance == null ? 12.0 : syncDistance);
        config.setMaxOutsideFrames(50);
        config.setClassMappings(classMappings);
        return config;
    }
}
```

`ModelParamUtils.valid`：当 `modelCode` 为 `LIDAR_DETECTION` 或 `IMAGE_KEYPOINT_LIFTED_DETECTION` 且 JSON 含非空 `classMappings` 时，在现有 `PreModelParamDTO` 校验之后，把 `classMappings` 转成 `List<DatasetInferenceConfig.ClassMapping>`。任一项 `modelClassCode` 为空、`datasetClassId == null`、`motionMode == null` 时抛 `UsecaseException(PARAM_ERROR, ...)`，错误信息带上该项 JSON。`classes` 必须包含每个 mapping 的 `modelClassCode`。

解析可用：

```java
List<DatasetInferenceConfig.ClassMapping> mappings = JSONUtil.toList(
        resultFilterParam.getJSONArray("classMappings"),
        DatasetInferenceConfig.ClassMapping.class);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && mvn -q -Dtest=ModelParamUtilsTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/entity/ModelRunSceneTrackingParamBO.java \
  backend/src/main/java/ai/basic/x1/adapter/dto/request/ModelRunFilterDataDTO.java \
  backend/src/main/java/ai/basic/x1/entity/ModelRunFilterDataBO.java \
  backend/src/main/java/ai/basic/x1/util/ModelParamUtils.java \
  backend/src/test/java/ai/basic/x1/util/ModelParamUtilsTest.java
git commit -m "Add scene tracking Model Run param validation"
```

---

### Task 2: 静止最近帧选择与位姿外推

**Files:**
- Create: `backend/src/main/java/ai/basic/x1/usecase/StaticTrackExtrapolation.java`
- Create: `backend/src/test/java/ai/basic/x1/usecase/StaticTrackExtrapolationTest.java`

**Interfaces:**
- Consumes: `SceneInferenceTrackingDTO.Object` / `Frame` / `Pose`；`TrackSyncUseCase.projectPose`；`InferenceMotionModeEnum.STATIC`
- Produces: `StaticTrackExtrapolation.apply(List<Frame> trackedFrames, double syncDistance)` 返回新的 `List<Frame>`，静止轨迹被最近帧几何替换，动态轨迹原样保留

- [ ] **Step 1: Write the failing test**

```java
package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StaticTrackExtrapolationTest {

    @Test
    void apply_usesClosestBevFrameAndProjectsStaticBox() {
        SceneInferenceTrackingDTO.Object far = object("t1", InferenceMotionModeEnum.STATIC, 10.0, 0.0, 0.8, 1L);
        SceneInferenceTrackingDTO.Object close = object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.7, 2L);
        SceneInferenceTrackingDTO.Frame frame0 = SceneInferenceTrackingDTO.Frame.builder()
                .dataId(1L).frameIndex(0)
                .pose(SceneInferenceTrackingDTO.Pose.builder().x(0.0).y(0.0).z(0.0).yaw(0.0).build())
                .objects(List.of(far)).build();
        SceneInferenceTrackingDTO.Frame frame1 = SceneInferenceTrackingDTO.Frame.builder()
                .dataId(2L).frameIndex(1)
                .pose(SceneInferenceTrackingDTO.Pose.builder().x(3.0).y(0.0).z(0.0).yaw(0.0).build())
                .objects(List.of(close)).build();

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(List.of(frame0, frame1), 12.0);

        SceneInferenceTrackingDTO.Object projectedOnFrame0 = result.get(0).getObjects().get(0);
        assertEquals("t1", projectedOnFrame0.getTrackingId());
        assertEquals(5.0, projectedOnFrame0.getX(), 1.0e-9);
        assertEquals(0.0, projectedOnFrame0.getY(), 1.0e-9);
        assertEquals(2L, projectedOnFrame0.getStandardDataId());
    }

    @Test
    void apply_leavesDynamicTracksUnchanged() {
        SceneInferenceTrackingDTO.Object first = object("d1", InferenceMotionModeEnum.DYNAMIC_FIXED_SIZE, 1.0, 0.0, 0.9, 1L);
        SceneInferenceTrackingDTO.Object second = object("d1", InferenceMotionModeEnum.DYNAMIC_FIXED_SIZE, 8.0, 0.0, 0.9, 2L);
        List<SceneInferenceTrackingDTO.Frame> result = StaticTrackExtrapolation.apply(List.of(
                frame(1L, 0, 0.0, first),
                frame(2L, 1, 3.0, second)
        ), 12.0);
        assertEquals(1.0, result.get(0).getObjects().get(0).getX(), 1.0e-9);
        assertEquals(8.0, result.get(1).getObjects().get(0).getX(), 1.0e-9);
    }

    private static SceneInferenceTrackingDTO.Frame frame(
            Long dataId, int index, double poseX, SceneInferenceTrackingDTO.Object object) {
        return SceneInferenceTrackingDTO.Frame.builder()
                .dataId(dataId).frameIndex(index)
                .pose(SceneInferenceTrackingDTO.Pose.builder().x(poseX).y(0.0).z(0.0).yaw(0.0).build())
                .objects(List.of(object)).build();
    }

    private static SceneInferenceTrackingDTO.Object object(
            String trackingId, InferenceMotionModeEnum mode, double x, double y, double confidence, Long dataId) {
        return SceneInferenceTrackingDTO.Object.builder()
                .predictionId(dataId + "-0")
                .trackingId(trackingId)
                .label("pillar")
                .confidence(confidence)
                .x(x).y(y).z(0.5)
                .dx(0.4).dy(0.4).dz(1.0)
                .rotX(0.0).rotY(0.0).rotZ(0.0)
                .motionMode(mode)
                .datasetClassId(12L)
                .standardDataId(dataId)
                .build();
    }
}
```

几何说明：最近帧是 dataId=2，局部 x=2，源 pose x=3，目标 pose x=0，`projectPose` 后目标局部 x=5。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && mvn -q -Dtest=StaticTrackExtrapolationTest test`

Expected: FAIL，类不存在

- [ ] **Step 3: Implement `StaticTrackExtrapolation`**

```java
public final class StaticTrackExtrapolation {
    private StaticTrackExtrapolation() {}

    public static List<SceneInferenceTrackingDTO.Frame> apply(
            List<SceneInferenceTrackingDTO.Frame> frames, double syncDistance) {
        // 1. Group STATIC objects by trackingId across frames.
        // 2. For each static track pick source object with min hypot(x,y);
        //    ties: higher confidence, then smaller dataId.
        // 3. For every frame, project source center/yaw with TrackSyncUseCase.projectPose
        //    using source frame pose and target frame pose, syncUseZ=true.
        // 4. Skip a target frame if hypot(projected.x, projected.y) > syncDistance.
        // 5. Copy size and rotX/rotY from source; set standardDataId to source dataId.
        // 6. Non-STATIC objects are copied unchanged.
        // 7. Return new Frame list in original order; do not mutate inputs.
    }
}
```

把 `SceneInferenceTrackingDTO.Pose` 转成 `TrackSyncUseCase.Pose` 时字段为 `x,y,z,yaw`，`complete` 在四值非 null 时为 true。查看 `TrackSyncUseCase.Pose` 构造器，按现有测试 `new TrackSyncUseCase.Pose(10D, 20D, 2D, Math.PI / 2)` 使用。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && mvn -q -Dtest=StaticTrackExtrapolationTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/StaticTrackExtrapolation.java \
  backend/src/test/java/ai/basic/x1/usecase/StaticTrackExtrapolationTest.java
git commit -m "Add closest-to-ego static track extrapolation"
```

---

### Task 3: 统一两路检测为跟踪物体

**Files:**
- Create: `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceDetectionAdapter.java`
- Create: `backend/src/test/java/ai/basic/x1/usecase/SceneInferenceDetectionAdapterTest.java`

**Interfaces:**
- Consumes: `PointCloudDetectionObject`；`ImageKeypointLiftedDetectionRespDTO.ObjectDTO`（`modelClass`、`confidence`、`center3D`、`size3D`、`rotation3D`）
- Produces: `SceneInferenceDetectionAdapter.toTrackingObjects(...)` 返回 `List<SceneInferenceTrackingDTO.Object>`（此时还没有 `trackingId`）

- [ ] **Step 1: Write the failing test**

```java
@Test
void toTrackingObjects_mapsKeypointLiftedCenterSizeRotation() {
    ImageKeypointLiftedDetectionRespDTO.ObjectDTO detection =
            ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                    .modelClass("pillar")
                    .confidence(new BigDecimal("0.88"))
                    .center3D(PointBO.builder().x(1.0).y(2.0).z(0.5).build())
                    .size3D(PointBO.builder().x(0.4).y(0.4).z(1.2).build())
                    .rotation3D(PointBO.builder().x(0.0).y(0.0).z(0.3).build())
                    .build();
    DatasetInferenceConfig.ClassMapping mapping = DatasetInferenceConfig.ClassMapping.builder()
            .modelClassCode("pillar")
            .datasetClassId(12L)
            .motionMode(InferenceMotionModeEnum.STATIC)
            .build();
    List<SceneInferenceTrackingDTO.Object> objects = SceneInferenceDetectionAdapter.toTrackingObjects(
            9L, 3, List.of(detection), Map.of("pillar", mapping), 0.5);
    assertEquals(1, objects.size());
    assertEquals("9-3-0", objects.get(0).getPredictionId());
    assertEquals(1.0, objects.get(0).getX());
    assertEquals(InferenceMotionModeEnum.STATIC, objects.get(0).getMotionMode());
}

@Test
void toTrackingObjects_skipsBelowConfidenceAndUnmappedClass() {
    ImageKeypointLiftedDetectionRespDTO.ObjectDTO low =
            ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                    .modelClass("pillar").confidence(new BigDecimal("0.2"))
                    .center3D(PointBO.builder().x(1).y(0).z(0).build())
                    .size3D(PointBO.builder().x(1).y(1).z(1).build())
                    .rotation3D(PointBO.builder().x(0).y(0).z(0).build())
                    .build();
    assertEquals(List.of(), SceneInferenceDetectionAdapter.toTrackingObjects(
            1L, 0, List.of(low), Map.of("pillar", mapping()), 0.5));
}
```

`PointBO` 的真实字段名以 `ai.basic.x1.entity.PointBO` 为准，测试里按实际 setter 写。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && mvn -q -Dtest=SceneInferenceDetectionAdapterTest test`

Expected: FAIL

- [ ] **Step 3: Implement adapter**

提供两个 overload：

- `toTrackingObjects(Long runId, int frameIndex, List<PointCloudDetectionObject> objects, Map<String, ClassMapping> mappings, double minConfidence)`
- `toTrackingObjects(Long runId, int frameIndex, List<ImageKeypointLiftedDetectionRespDTO.ObjectDTO> objects, ...)`

过滤：mapping 不存在、confidence < minConfidence、几何非法（尺寸 <= 0 或坐标缺）则跳过，不要抛整帧失败（与「某框坏掉不拖死场景」相比，规格写的是非法几何抛错。按规格：几何非法抛 `UsecaseException`，带 `runId`、`dataId`、prediction JSON）。测试用合法几何。

`predictionId = runId + "-" + frameIndex + "-" + objectIndex`。keypoint 的 label 用 `modelClass`。

- [ ] **Step 4: Run tests**

Run: `cd backend && mvn -q -Dtest=SceneInferenceDetectionAdapterTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/SceneInferenceDetectionAdapter.java \
  backend/src/test/java/ai/basic/x1/usecase/SceneInferenceDetectionAdapterTest.java
git commit -m "Adapt lidar and keypoint detections to tracking objects"
```

---

### Task 4: Finalizer 按 Model Run 替换标注

**Files:**
- Modify: `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceFinalizer.java`
- Modify: `backend/src/test/java/ai/basic/x1/usecase/SceneInferenceUseCaseTest.java`（或新建 `SceneInferenceFinalizerTest.java`）

**Interfaces:**
- Consumes: `replaceInferenceAnnotations` 现有签名
- Produces: `replaceModelRunAnnotations(SceneInferenceRun run, List<Long> frameIds, SceneInferenceTrackingDTO.Response response, Long modelRunRecordId)`  
  删除条件：`sourceType=MODEL` 且 `sourceId=modelRunRecordId` 且 `dataId in frameIds`  
  插入：同样 `sourceType=MODEL`，`sourceId=modelRunRecordId`  
  重叠规则保持：与 `DATA_FLOW`/`IMPORTED` 重叠则不写入；本次预测互相 IoU 去重

- [ ] **Step 1: Write a unit test for overlap + source type using package-visible helpers**

在 `SceneInferenceUseCaseTest` 增加对 `overlaps` 行为的说明性测试已有 `bevIou`。本任务增加 `SceneInferenceFinalizerTest` 只测 `buildAttributes` 需要的字段仍含 `trackId`、`motionMode`、`modelClass`。若 `buildAttributes` 仍是 private，不要为测试改可见性；改为在 `replaceModelRunAnnotations` 的 javadoc 写清删除条件，用一个纯函数抽出：

```java
static boolean isThisModelRun(DataAnnotationObject object, Long modelRunRecordId) {
    return object.getSourceType() == DataAnnotationObjectSourceTypeEnum.MODEL
            && modelRunRecordId.equals(object.getSourceId());
}
```

测试：

```java
@Test
void test_isThisModelRun_matchesModelSourceId() {
    DataAnnotationObject object = DataAnnotationObject.builder()
            .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
            .sourceId(44L)
            .build();
    assertTrue(SceneInferenceFinalizer.isThisModelRun(object, 44L));
    assertFalse(SceneInferenceFinalizer.isThisModelRun(object, 45L));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && mvn -q -Dtest=SceneInferenceFinalizerTest test`

Expected: FAIL

- [ ] **Step 3: Implement `replaceModelRunAnnotations`**

复制 `replaceInferenceAnnotations` 的去重与 `buildAnnotations` 逻辑，但：

- `remove` 使用 `eq(sourceType, MODEL).eq(sourceId, modelRunRecordId).in(dataId, frameIds)`，不要删 `INFERENCE`
- `saveBatch` 的 `sourceType=MODEL`，`sourceId=modelRunRecordId`
- 自动推理路径 `replaceInferenceAnnotations` 保持原样，避免回归数据集 `inferenceMode`

`SceneInferenceRun` 在 Model Run 路径可以是内存对象：`id` 可空，但 `datasetId`、`configSnapshot`、`totalFrames` 必须有。若 `updateById` 需要 id，Model Run 路径不要调用 `sceneInferenceRunDAO.updateById`；把状态更新留在 Task 6 的 `ModelUseCase`。

将 DAO 更新拆出来：`replaceModelRunAnnotations` 只写标注，不改 `SceneInferenceRun`。

- [ ] **Step 4: Run tests**

Run: `cd backend && mvn -q -Dtest=SceneInferenceFinalizerTest,SceneInferenceUseCaseTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/SceneInferenceFinalizer.java \
  backend/src/test/java/ai/basic/x1/usecase/SceneInferenceFinalizerTest.java
git commit -m "Write Model Run tracking annotations without touching inference rows"
```

---

### Task 5: `SceneInferenceUseCase.runForModelRun`

**Files:**
- Modify: `backend/src/main/java/ai/basic/x1/usecase/SceneInferenceUseCase.java`
- Modify: `backend/src/main/java/ai/basic/x1/adapter/port/rpc/ImageKeypointLiftedDetectionHttpCaller.java`（已存在，只注入使用）

**Interfaces:**
- Consumes: Task 3 adapter、Task 2 extrapolation、Task 4 finalizer、现有 `trackingHttpCaller.associate`、`loadPoses`
- Produces:

```java
public void runForModelRun(Long modelRunRecordId, Long datasetId, Long sceneId,
                           Model model, DatasetInferenceConfig config)
```

成功则写标注；失败抛 `UsecaseException`，由调用方记录场景错误。

- [ ] **Step 1: Write a focused test for model gating**

把 `requireDetectionModel` 改成允许两种 code。抽出：

```java
static boolean supportsSceneTracking(ModelCodeEnum modelCode) {
    return modelCode == ModelCodeEnum.LIDAR_DETECTION
            || modelCode == ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION;
}
```

在 `SceneInferenceUseCaseTest`：

```java
@Test
void test_supportsSceneTracking_allowsKeypointLifted() {
    assertTrue(SceneInferenceUseCase.supportsSceneTracking(ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
    assertFalse(SceneInferenceUseCase.supportsSceneTracking(ModelCodeEnum.IMAGE_DETECTION));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && mvn -q -Dtest=SceneInferenceUseCaseTest#test_supportsSceneTracking_allowsKeypointLifted test`

Expected: FAIL

- [ ] **Step 3: Implement `runForModelRun`**

伪代码（必须写成真实方法，复用现有 private 方法，不要复制整份 `execute`）：

1. 校验 `supportsSceneTracking(model.getModelCode())`，否则抛错，消息含 `modelId`、`modelCode`
2. 加载场景帧（与 `execute` 相同 query）
3. `loadPoses(modelRunRecordId, frames)`
4. 循环帧：按 `model.getModelCode()` 调用  
   - `LIDAR_DETECTION`：现有 `callDetectionWithRetry`  
   - `IMAGE_KEYPOINT_LIFTED_DETECTION`：新建 `callKeypointLiftedWithRetry`，内部 `imageKeypointLiftedDetectionHttpCaller.call(ImageKeypointLiftedModelReqConverter.convert(message), model.getUrl())`，同样 3 次退避
5. `SceneInferenceDetectionAdapter.toTrackingObjects(...)`
6. 组装 `SceneInferenceTrackingDTO.Request` 并 `trackingHttpCaller.associate`
7. `StaticTrackExtrapolation.apply(response.getFrames(), config.getSyncDistance())`
8. 构造内存 `SceneInferenceRun`（`datasetId`、`sceneId`、`configSnapshot`、`totalFrames`）
9. `finalizer.replaceModelRunAnnotations(run, frameIds, extrapolatedResponse, modelRunRecordId)`

`requireDetectionModel` 用于自动推理时仍只允许 `LIDAR_DETECTION`（数据集配置现状）；不要改自动推理行为。

- [ ] **Step 4: Run unit tests**

Run: `cd backend && mvn -q -Dtest=SceneInferenceUseCaseTest,StaticTrackExtrapolationTest,SceneInferenceDetectionAdapterTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/SceneInferenceUseCase.java
git commit -m "Run scene tracking from Model Run for lidar and keypoint models"
```

---

### Task 6: `ModelUseCase` 分流、循环场景、重跑

**Files:**
- Modify: `backend/src/main/java/ai/basic/x1/usecase/ModelUseCase.java`
- Modify: `backend/src/main/java/ai/basic/x1/adapter/port/dao/mybatis/model/ModelRunFilterData.java`（若 DAO 模型需要 `sceneIds` 才能落库）
- Create: `backend/src/test/java/ai/basic/x1/usecase/ModelUseCaseSceneTrackingTest.java`（只测静态校验方法；不要起 Spring）

**Interfaces:**
- Consumes: `SceneInferenceUseCase.runForModelRun`；`ModelRunSceneTrackingParamBO`
- Produces: 场景跟踪模型不再 `sendModelMessageAsync`

- [ ] **Step 1: Write failing tests for scene validation helpers**

在 `ModelUseCase` 增加 package-visible：

```java
static List<Long> requireSceneIds(ModelRunFilterDataBO filter) {
    if (filter == null || CollUtil.isEmpty(filter.getSceneIds())) {
        throw new UsecaseException(UsecaseCode.PARAM_ERROR, "sceneIds cannot be empty for scene tracking Model Run");
    }
    return filter.getSceneIds();
}

static RunStatusEnum summarizeSceneRunStatus(int successCount, int failureCount) {
    if (failureCount == 0) {
        return RunStatusEnum.SUCCESS;
    }
    if (successCount == 0) {
        return RunStatusEnum.FAILURE;
    }
    return RunStatusEnum.SUCCESS_WITH_ERROR;
}
```

测试类：

```java
@Test
void test_summarizeSceneRunStatus_partialIsSuccessWithError() {
    assertEquals(RunStatusEnum.SUCCESS_WITH_ERROR, ModelUseCase.summarizeSceneRunStatus(1, 1));
    assertEquals(RunStatusEnum.SUCCESS, ModelUseCase.summarizeSceneRunStatus(2, 0));
    assertEquals(RunStatusEnum.FAILURE, ModelUseCase.summarizeSceneRunStatus(0, 2));
}
```

若 `summarizeSceneRunStatus` 为 private 导致测试无法访问，将其做成 package-private（不要 public）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && mvn -q -Dtest=ModelUseCaseSceneTrackingTest test`

Expected: FAIL

- [ ] **Step 3: Implement modelRun / reRun branch**

`modelRun` 开头取 model。若 `SceneInferenceUseCase.supportsSceneTracking(modelBO.getModelCode())` 且 `ModelRunSceneTrackingParamBO.hasClassMappings(resultFilterParam)`：

1. `requireSceneIds`
2. 校验每个 scene：`dataInfoDAO.getById` 为 `SCENE`、`datasetId` 匹配、未删除；否则抛 PARAM_ERROR，消息含 `sceneId`、`datasetId`
3. 保存 `ModelRunRecord`，`dataCount` = 所选场景下帧总数（`parentId in sceneIds` 且 `SINGLE_DATA`）
4. `executorService.execute` 循环 sceneIds：  
   `sceneInferenceUseCase.runForModelRun(...)`  
   catch 后 append `"sceneId=" + sceneId + ": " + error`  
5. 更新 record status = `summarizeSceneRunStatus`，errorReason 为失败列表（截断到现有 error 字段长度）

`dataFilterParam` 仍要带 `dataCountRatio=100`、`isExcludeModelData=false`，以满足现有 Controller 校验。

无 `classMappings` 的旧调用保持 `sendModelMessageAsync`。

`reRun`：若 `resultFilterParam` 含 classMappings：

1. 从 `dataFilterParam.sceneIds` 取场景
2. 删除 `DataAnnotationObject`：`sourceType=MODEL` 且 `sourceId=record.id`
3. 状态改为 STARTED 后再次循环 `runForModelRun`
4. 不要要求 `ModelDatasetResult` 条数 > 0

查看 `ModelRunFilterData` mybatis 模型，给 `sceneIds` 同样加字段，保证 JSON 列能存下来。

- [ ] **Step 4: Run tests**

Run: `cd backend && mvn -q -Dtest=ModelUseCaseSceneTrackingTest,ModelParamUtilsTest test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/ai/basic/x1/usecase/ModelUseCase.java \
  backend/src/main/java/ai/basic/x1/adapter/port/dao/mybatis/model/ModelRunFilterData.java \
  backend/src/test/java/ai/basic/x1/usecase/ModelUseCaseSceneTrackingTest.java
git commit -m "Route Fusion Model Run through scene tracking"
```

---

### Task 7: Run 弹窗：数据集、场景、类别详情

**Files:**
- Modify: `frontend/main/src/api/business/model/modelsModel.ts`
- Modify: `frontend/main/src/api/business/models.ts`（如需）
- Modify: `frontend/main/src/components/BasicCustom/ModelRun/index.vue`
- Modify: `frontend/main/src/views/models/modelDetail/components/Runs.vue`
- Modify: `frontend/main/src/locales/lang/zh-CN/business/models.ts`
- Modify: `frontend/main/src/locales/lang/en/business/models.ts`

**Interfaces:**
- Consumes: `datasetApi`（`/data/findByPage`，`datasetId`，默认 `parentId` 列出场景）；`getDatasetClassApi`；`getModelByIdApi`
- Produces: `createModelRunApi` 的 body：

```ts
{
  modelId,
  datasetId,
  dataFilterParam: { dataCountRatio: 100, isExcludeModelData: false, sceneIds: number[] },
  resultFilterParam: {
    minConfidence,
    maxConfidence,
    associationIou,
    classes: string[],
    classMappings: { modelClassCode, datasetClassId, motionMode }[]
  }
}
```

- [ ] **Step 1: Extend TS types**

`ResultsModelParam` 增加可选 `associationIou?: number`、`classMappings?: InferenceClassMapping[]`。  
`DataModelParam` 已有 `sceneIds?: number[]`，保持。

- [ ] **Step 2: Load scenes when dataset changes in `Runs.vue`**

选中 `selectId` 后调用：

```ts
import { datasetApi } from '/@/api/business/dataset';

const sceneOptions = ref<Array<{ id: number; name: string }>>([]);
const selectedSceneIds = ref<number[]>([]);

const loadScenes = async () => {
  if (!selectId.value) {
    sceneOptions.value = [];
    selectedSceneIds.value = [];
    return;
  }
  const res = await datasetApi({
    datasetId: Number(selectId.value),
    pageNo: 1,
    pageSize: 1000,
  } as any);
  sceneOptions.value = (res.list || []).map((item: any) => ({ id: item.id, name: item.name }));
  selectedSceneIds.value = [];
};
```

`datasetApi` 的 params 以 `frontend/main/src/api/business/model/datasetModel.ts` 的 `DatasetParams` 为准，补齐必填字段。

- [ ] **Step 3: Expand ModelRun modal**

对 `LIDAR_*` 模型（`datasetType !== IMAGE`）：

- slot 数据集下拉保留
- 增加场景 `Select mode="multiple"` 绑定 `selectedSceneIds`（通过 props 传入）
- 类别区默认展开（`checkedResult` 默认 true），表格列：勾选、名称、code、数据集类别 Select、运动模式 Select
- 选中数据集后 `getDatasetClassApi({ datasetId, pageNo: 1, pageSize: 1000 })`，名称（忽略大小写）与模型类别 name/code 相同则自动填 `datasetClassId`，默认 `motionMode = STATIC`（Person 默认 `DYNAMIC_VARIABLE_SIZE`，与 `getDefaultMotionMode` 一致）
- 增加 `associationIou` InputNumber，默认 0.3
- 提交前：`selectedSceneIds.length === 0` 报 `请选择场景`；无映射报 `请为勾选类别选择数据集类别`

`handleRun` 组装 `classMappings` 与 `sceneIds`。

把场景选择做成 props，避免 Modal 自己打接口也可以：`Runs.vue` 拉场景和数据集类别，通过 props 传进 `ModelRun`。优先 props，接口仍集中在 `Runs.vue`。

- [ ] **Step 4: Wire `handleRun` in Runs.vue**

```ts
const runParams: runModelRunParams = {
  modelId,
  datasetId,
  resultFilterParam: {
    ...result,
    associationIou: result.associationIou ?? 0.3,
    classMappings: result.classMappings,
  },
  dataFilterParam: {
    dataCountRatio: 100,
    isExcludeModelData: false,
    sceneIds: selectedSceneIds.value,
  },
};
```

IMAGE 模型不展示场景表，保持旧逻辑。

- [ ] **Step 5: Manual UI check**

打开 15 类模型 Runs → Run Model：选 Fusion 数据集后出现场景多选和类别表。未选场景点 Run 应被拦截。

- [ ] **Step 6: Commit**

```bash
git add frontend/main/src/api/business/model/modelsModel.ts \
  frontend/main/src/components/BasicCustom/ModelRun/index.vue \
  frontend/main/src/views/models/modelDetail/components/Runs.vue \
  frontend/main/src/locales/lang/zh-CN/business/models.ts \
  frontend/main/src/locales/lang/en/business/models.ts
git commit -m "Add dataset scene and class mapping to Model Run modal"
```

---

### Task 8: 端到端核对与回归

**Files:** 不新增大文件；修 Task 5–7 的缺口

- [ ] **Step 1: Backend regression**

Run: `cd backend && mvn -q -Dtest=ModelParamUtilsTest,StaticTrackExtrapolationTest,SceneInferenceDetectionAdapterTest,SceneInferenceFinalizerTest,SceneInferenceUseCaseTest,ModelUseCaseSceneTrackingTest,TrackSyncUseCaseTest,ImageKeypointLiftedModelResultConverterTest test`

Expected: PASS

- [ ] **Step 2: Spec checklist**

对照 `docs/superpowers/specs/2026-08-20-model-run-scene-tracking-design.md`：

- 数据集 + 多场景
- 类别 code / 映射 / 动静
- 静止最近帧 + location 外推
- 动态不外推
- 只删本次 MODEL 重叠预测
- 人工不删
- 缺 location 单场景失败、其他继续
- Rerun 只清本 Run MODEL 标注
- 15 类走 keypoint caller

缺哪条补哪条，不要开新范围。

- [ ] **Step 3: Commit leftover fixes if any**

```bash
git commit -m "Fix scene tracking Model Run gaps from spec checklist"
```

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| Run 弹窗数据集/场景/类别/IoU | 7 |
| 提交契约 sceneIds + classMappings | 1, 6, 7 |
| 逐帧检测 + 两模型分流 | 3, 5 |
| 静止最近帧 + 位姿外推 | 2, 5 |
| 动态不外推 | 2 |
| 重叠删除仅本次预测 | 4 |
| 写入 MODEL + modelRunId | 4, 6 |
| 部分成功 | 6（`SUCCESS_WITH_ERROR`） |
| Rerun 清本 Run 标注 | 6 |
| 不碰自动推理 INFERENCE | 4, 5 |
| 纯图像二维 Run | 7 中 IMAGE 保持旧路径 |

## 与规格的一处对齐

规格写增加 `PARTIAL_SUCCESS`。计划改用已有 `SUCCESS_WITH_ERROR`，Runs 表已有橙色状态文案 `successWithError`，避免改枚举、过滤器和数据库约定。
