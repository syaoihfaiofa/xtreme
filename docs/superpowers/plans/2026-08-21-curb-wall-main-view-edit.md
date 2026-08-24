# Curb/wall 主视图交互实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `L` 标注 curb/wall 时允许缩放、平移和旋转主视图，并在标注完成后通过主视图手柄把折线顶点吸附到点云，更新 X/Y/Z。

**Architecture:** `OrbitControlsAction` 负责在渲染 canvas 与创建 overlay 之间重绑同一套相机控制，`CreateAction` 为地面折线保存世界坐标并随相机重投影预览。新增独立的 `EditGroundPolylineAction` 管理主视图顶点手柄和点云射线吸附，编辑结果通过 `hackMainView` 接入现有可撤销命令。

**Tech Stack:** Vue 3、TypeScript 4.5、Three.js 0.136、Vite 2

## Global Constraints

- 只修改 `frontend/pc-tool`；不修改后端同步逻辑。
- 只为 `GROUND_POLYLINE` 开启本次主视图编辑；不扩展到 `GROUND_POLYGON`。
- 三视图和图像 2D 投影编辑行为保持不变。
- 创建阶段点仍落在 `ground.plane.constant`；完成后拖动顶点才从点云取得 XYZ。
- 点云吸附半径固定为 `0.5 m`；右键单击/拖动阈值固定为 `4 px`。
- 不新增依赖、测试框架或配置项。
- 当前工作区已有大量无关改动；每次提交只能暂存本任务列出的文件。

---

## 文件结构

- 修改 `frontend/pc-tool/src/packages/pc-render/action/OrbitControlsAction.ts`
  - 封装 control 创建与 DOM 重绑，支持画线 overlay 的鼠标映射。
- 修改 `frontend/pc-tool/src/packages/pc-render/action/CreateAction.ts`
  - 地面折线保存世界点、相机变化时重投影、区分右键单击与拖动。
- 修改 `frontend/pc-tool/src/packages/pc-editor/common/ActionManager/action/create.ts`
  - `createGroundPolyline` 直接消费世界点，不再从结束时的屏幕点重算。
- 新建 `frontend/pc-tool/src/packages/pc-render/action/EditGroundPolylineAction.ts`
  - 主视图折线顶点手柄、选中状态、射线吸附和拖动生命周期。
- 修改 `frontend/pc-tool/src/packages/pc-render/renderView/MainRenderView.ts`
  - 将新 action 加入主视图默认 action 列表。
- 修改 `frontend/pc-tool/src/packages/pc-render/index.ts`
  - 注册并导出新 action。
- 修改 `frontend/pc-tool/src/packages/pc-editor/hack.ts`
  - 把新 action 的点变化回调接到 `update-ground-polyline-points`。

### Task 1: 让 OrbitControls 可在画线 overlay 上工作

**Files:**
- Modify: `frontend/pc-tool/src/packages/pc-render/action/OrbitControlsAction.ts`

**Interfaces:**
- Produces: `useDrawingElement(domElement: HTMLElement): void`
- Produces: `restoreRenderElement(): void`
- Preserves: public `control: OrbitControls` 始终指向当前有效实例

- [ ] **Step 1: 提取 control 构造逻辑并增加重绑接口**

把构造函数中直接创建 control 的逻辑提取为私有方法。重绑时保留 `target`、`enabled`，并恢复现有距离限制：

```ts
private createControl(
    domElement: HTMLElement,
    target: THREE.Vector3,
    enabled: boolean,
): OrbitControls {
    const control = new OrbitControls(this.renderView.camera, domElement);
    control.maxDistance = 1000;
    control.minDistance = 10;
    control.target.copy(target);
    control.enabled = enabled;
    control.addEventListener('change', this.controlChange);
    return control;
}

private replaceControl(domElement: HTMLElement, drawing: boolean): void {
    const target = this.control.target.clone();
    const enabled = this.control.enabled;
    this.control.removeEventListener('change', this.controlChange);
    this.control.dispose();
    this.control = this.createControl(domElement, target, enabled);
    if (drawing) {
        this.control.mouseButtons.LEFT = -1 as THREE.MOUSE;
        this.control.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
        this.control.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    }
    this.control.update();
}

useDrawingElement(domElement: HTMLElement): void {
    this.replaceControl(domElement, true);
}

restoreRenderElement(): void {
    this.replaceControl(this.renderView.renderer.domElement, false);
}
```

构造函数在完成 `controlChange` 绑定后调用：

```ts
this.control = this.createControl(
    renderView.renderer.domElement,
    new THREE.Vector3(),
    true,
);
```

`destroy()` 继续移除当前 control 的监听并 `dispose()`，不能假设它仍绑定原 renderer。

- [ ] **Step 2: 运行 TypeScript/Vite 构建验证类型**

Run:

```bash
cd /PnP/lxzhu/lidar_annos/xtreme/frontend/pc-tool
npm run build
```

Expected: 构建成功；无 `mouseButtons`、`THREE.MOUSE` 或未初始化 `control` 的 TypeScript 错误。

- [ ] **Step 3: 提交相机重绑能力**

```bash
cd /PnP/lxzhu/lidar_annos/xtreme
git add frontend/pc-tool/src/packages/pc-render/action/OrbitControlsAction.ts
git commit -m "Add drawing-mode orbit controls"
```

### Task 2: 画线期间保存世界点并支持相机操作

**Files:**
- Modify: `frontend/pc-tool/src/packages/pc-render/action/CreateAction.ts`
- Modify: `frontend/pc-tool/src/packages/pc-editor/common/ActionManager/action/create.ts`

**Interfaces:**
- Consumes: `OrbitControlsAction.useDrawingElement(domElement: HTMLElement): void`
- Consumes: `OrbitControlsAction.restoreRenderElement(): void`
- Produces: `IStartOption.pointSpace?: 'canvas' | 'ground'`
- Produces: `CreateAction` 在 `pointSpace === 'ground'` 时回调 `THREE.Vector3[]`，其他创建方式仍回调屏幕点

- [ ] **Step 1: 为 CreateAction 增加地面世界点状态**

在 `IStartOption` 和类字段中加入：

```ts
interface IStartOption {
    type: DrawType;
    trackLine?: boolean;
    startClick?: boolean;
    startMouseDown?: boolean;
    endOnDoubleClick?: boolean;
    pointSpace?: 'canvas' | 'ground';
}

pointSpace: 'canvas' | 'ground' = 'canvas';
private readonly worldPoints: THREE.Vector3[] = [];
private lastPointer: Point | null = null;
private rightDragStart: THREE.Vector2 | null = null;
private rightDragMoved = false;
private readonly rightDragThreshold = 4;
private readonly onRender = (): void => {
    if (
        this.pointSpace === 'ground' &&
        this.canvas.style.display === 'block' &&
        this.lastPointer
    ) {
        this.drawPoint3(this.lastPointer);
    }
};
```

同时从 `../config` 导入 `Event`，从 `./OrbitControlsAction` 导入 `OrbitControlsAction`。

`start()` 读取 `pointSpace`，清空 `worldPoints`，并取得主视图的 `orbit-control`：

```ts
this.pointSpace = pointSpace;
this.worldPoints.splice(0);
this.lastPointer = null;
if (this.pointSpace === 'ground') {
    const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
    orbit.useDrawingElement(this.canvas);
}
```

`end()` 在隐藏 overlay 前恢复 control，并清理右键状态：

```ts
if (this.pointSpace === 'ground') {
    const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
    orbit.restoreRenderElement();
}
this.rightDragStart = null;
this.rightDragMoved = false;
this.canvas.style.display = 'none';
```

- [ ] **Step 2: 点击时保存世界坐标，绘制时按当前相机投影**

增加两个聚焦函数：

```ts
private canvasEventPoint(event: MouseEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
}

private addPoint(event: MouseEvent): void {
    const canvasPoint = this.canvasEventPoint(event);
    if (this.pointSpace === 'ground') {
        const worldPoint = this.renderView.canvasToWorld(canvasPoint);
        worldPoint.z = this.renderView.pointCloud.ground.plane.constant;
        this.worldPoints.push(worldPoint);
        return;
    }
    this.points.push({ x: canvasPoint.x, y: canvasPoint.y });
}

private getPreviewPoints(): Point[] {
    if (this.pointSpace !== 'ground') return this.points;
    return this.worldPoints.map((worldPoint) => {
        const projected = worldPoint.clone().project(this.renderView.camera);
        return {
            x: ((projected.x + 1) / 2) * this.canvas.clientWidth,
            y: (1 - (projected.y + 1) / 2) * this.canvas.clientHeight,
        };
    });
}
```

将 `drawPoint3()` 改为先保存 `lastPointer`，并统一使用投影后的点列。不能再用 `this.points.length` 判断地面折线是否已有点：

```ts
drawPoint3(pos: Point): void {
    this.lastPointer = { x: pos.x, y: pos.y };
    this.clear();
    if (this.trackLine) this.drawTrackLine(pos);

    const previewPoints = this.getPreviewPoints();
    this.context.beginPath();
    this.setStyle();
    previewPoints.forEach((point, index) => {
        if (index === 0) this.context.moveTo(point.x, point.y);
        else this.context.lineTo(point.x, point.y);
    });
    if (previewPoints.length > 0) this.context.lineTo(pos.x, pos.y);
    else this.drawPointer(pos);
    this.context.stroke();
}
```

`handleMouse()` 调用 `addPoint()`，并按当前 point space 判断点数：

```ts
private getPointCount(): number {
    return this.pointSpace === 'ground' ? this.worldPoints.length : this.points.length;
}

handleMouse(event: MouseEvent): void {
    this.addPoint(event);
    if (this.onChange) {
        this.onChange(this.pointSpace === 'ground' ? this.worldPoints : this.points);
    }
    if (this.getPointCount() >= TypePoints[this.drawType]) {
        this.end();
        this.handleCallback();
    }
}

handleCallback(): void {
    if (!this.callback) return;
    this.callback(
        this.pointSpace === 'ground'
            ? this.worldPoints.map((point) => point.clone())
            : this.points,
    );
}
```

`onDoubleClick()` 和 `onContextMenu()` 中现有的 `this.points.length < 2` 都改成 `this.getPointCount() < 2`，否则世界点模式永远无法结束。

`init()` 订阅、`destroy()` 取消订阅渲染事件：

```ts
init(): void {
    // 保留现有 canvas 事件注册。
    this.renderView.addEventListener(Event.RENDER_AFTER, this.onRender);
}

destroy(): void {
    // 保留现有 canvas 事件移除。
    this.renderView.removeEventListener(Event.RENDER_AFTER, this.onRender);
}
```

这样相机变化后会用当前相机和最后鼠标位置重画，旧点不会漂移。`end()` 还要把 `lastPointer` 设为 `null`。

- [ ] **Step 3: 区分右键单击结束与右键拖动平移**

给 canvas 增加 `mousedown`、`mousemove`、`mouseup` 状态判断（OrbitControls 也监听同一元素，不要对中键/右键调用 `stopImmediatePropagation`）：

```ts
if (event.button === 2 && this.pointSpace === 'ground') {
    this.rightDragStart = new THREE.Vector2(event.clientX, event.clientY);
    this.rightDragMoved = false;
}
```

在移动时：

```ts
if (this.rightDragStart) {
    const distance = this.rightDragStart.distanceTo(
        new THREE.Vector2(event.clientX, event.clientY),
    );
    if (distance > this.rightDragThreshold) this.rightDragMoved = true;
}
```

`onContextMenu()` 总是阻止浏览器菜单；只有未拖动且点数至少 2 时结束：

```ts
event.preventDefault();
event.stopPropagation();
this.commitPendingClick();
if (this.rightDragMoved || this.getPointCount() < 2) return;
this.end();
this.handleCallback();
```

`mouseup` 后不要在 `contextmenu` 触发前清掉 `rightDragMoved`；在下一次右键 `mousedown` 或 `end()` 时重置。中键完全交给画线模式 OrbitControls。

- [ ] **Step 4: createGroundPolyline 直接消费世界点**

修改启动选项和回调：

```ts
action.start(
    {
        type: 'polyline',
        startClick: true,
        endOnDoubleClick: true,
        pointSpace: 'ground',
    },
    (points: THREE.Vector3[]) => {
        try {
            if (points.length < 2) {
                editor.showMsg('warning', '地面折线至少需要两个点');
                resolve(null);
                return;
            }
            // 后续 classConfig、userData、GroundPolyline 创建逻辑保持原样。
            const polyline = new GroundPolyline(points.map((point) => point.clone()));
```

删除原回调中的 `canvasPoints.map(view.canvasToWorld)` 与重复设置 `groundZ`。停车位和其它创建动作不传 `pointSpace`，保持原屏幕坐标行为。

- [ ] **Step 5: 构建并人工验证画线阶段**

Run:

```bash
cd /PnP/lxzhu/lidar_annos/xtreme/frontend/pc-tool
npm run build
```

Expected: Vite build 成功。

启动本地环境后验证：

1. 按 `L` 后滚轮缩放、右键拖动平移、中键拖动旋转均有效。
2. 相机变化后已点的预览线仍固定在原世界位置。
3. 右键拖动松开不结束；右键单击结束；双击仍结束。
4. 停车位和 3D box 创建行为无回归。

- [ ] **Step 6: 提交画线交互**

```bash
cd /PnP/lxzhu/lidar_annos/xtreme
git add \
  frontend/pc-tool/src/packages/pc-render/action/CreateAction.ts \
  frontend/pc-tool/src/packages/pc-editor/common/ActionManager/action/create.ts
git commit -m "Enable camera controls while drawing curb walls"
```

### Task 3: 新增主视图折线顶点手柄和点云吸附

**Files:**
- Create: `frontend/pc-tool/src/packages/pc-render/action/EditGroundPolylineAction.ts`
- Modify: `frontend/pc-tool/src/packages/pc-render/index.ts`
- Modify: `frontend/pc-tool/src/packages/pc-render/renderView/MainRenderView.ts`

**Interfaces:**
- Produces: action name `edit-ground-polyline`
- Produces: `onGroundPolylinePointsChange?: (object: GroundPolyline, points: THREE.Vector3[]) => void`
- Consumes: `MainRenderView.camera`, `pointCloud.selection`, `pointCloud.groupPoints`

- [ ] **Step 1: 创建 EditGroundPolylineAction 的显示层与生命周期**

新增 action，采用与侧视图一致的 HTML 手柄样式：

```ts
import * as THREE from 'three';
import Action from './Action';
import GroundPolyline from '../objects/GroundPolyline';
import MainRenderView from '../renderView/MainRenderView';
import { Event } from '../config';

const SNAP_THRESHOLD_METERS = 0.5;

export default class EditGroundPolylineAction extends Action {
    static actionName = 'edit-ground-polyline';
    renderView: MainRenderView;
    onGroundPolylinePointsChange?: (
        object: GroundPolyline,
        points: THREE.Vector3[],
    ) => void;

    private readonly layer: HTMLDivElement;
    private readonly handles: HTMLDivElement[] = [];
    private readonly raycaster = new THREE.Raycaster();
    private readonly pointer = new THREE.Vector2();

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.layer = document.createElement('div');
        this.layer.style.cssText =
            'position:absolute;inset:0;pointer-events:none;z-index:4;display:none;';
        renderView.container.appendChild(this.layer);
        this.raycaster.params.Points = { threshold: SNAP_THRESHOLD_METERS };
    }

    init(): void {
        this.renderView.addEventListener(Event.RENDER_AFTER, this.updateHandles);
    }

    destroy(): void {
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.layer.remove();
        this.handles.splice(0);
    }
}
```

`updateHandles` 必须定义为箭头函数，保证 add/remove 使用同一个引用。

- [ ] **Step 2: 只为当前选中的 GroundPolyline 投影手柄**

实现目标解析和投影：

```ts
private getObject(): GroundPolyline | null {
    const object = this.renderView.pointCloud.selection.find(
        (candidate) =>
            candidate instanceof GroundPolyline &&
            candidate.parent === this.renderView.pointCloud.annotate3D,
    );
    return object instanceof GroundPolyline ? object : null;
}

private readonly updateHandles = (): void => {
    const object = this.getObject();
    if (!object || !object.visible) {
        this.layer.style.display = 'none';
        return;
    }
    this.ensureHandles(object.points3D.length);
    this.layer.style.display = 'block';
    object.updateMatrixWorld();
    object.points3D.forEach((point, index) => {
        const projected = point.clone().applyMatrix4(object.matrixWorld).project(
            this.renderView.camera,
        );
        const handle = this.handles[index];
        const visible =
            projected.z >= -1 &&
            projected.z <= 1 &&
            Math.abs(projected.x) <= 1 &&
            Math.abs(projected.y) <= 1;
        handle.style.display = visible ? 'block' : 'none';
        handle.style.left = `${((projected.x + 1) / 2) * this.renderView.width}px`;
        handle.style.top = `${(1 - (projected.y + 1) / 2) * this.renderView.height}px`;
    });
    this.handles.slice(object.points3D.length).forEach((handle) => {
        handle.style.display = 'none';
    });
};
```

`ensureHandles()` 创建 10 px 圆点，设置 `pointer-events:auto;cursor:grab`，保存 `dataset.index`，并绑定 `pointerdown`。

- [ ] **Step 3: 拖动时射线吸附最近点云点**

在 `pointerdown` 阻止冒泡，document 上监听移动和释放：

```ts
private startDrag(event: PointerEvent, index: number): void {
    const object = this.getObject();
    if (!object) return;
    event.preventDefault();
    event.stopPropagation();

    const onMove = (moveEvent: PointerEvent): void => {
        const point = this.pickPointCloud(moveEvent);
        if (!point) return;
        const points = object.points3D.map((item) => item.clone());
        points[index].copy(object.worldToLocal(point.clone()));
        this.onGroundPolylinePointsChange?.(object, points);
    };
    const onUp = (): void => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

private pickPointCloud(event: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderView.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.renderView.camera);
    const hit = this.raycaster.intersectObject(
        this.renderView.pointCloud.groupPoints,
        true,
    )[0];
    return hit?.point ? hit.point.clone() : null;
}
```

命中点是世界坐标；写回前必须经过 `object.worldToLocal()`，避免将来对象 transform 非 identity 时坐标错误。无命中时不调用回调。

- [ ] **Step 4: 注册新 action 并加入主视图**

在 `pc-render/index.ts`：

```ts
import EditGroundPolylineAction from './action/EditGroundPolylineAction';
```

将其加入注册数组并加入 export：

```ts
[
    // existing actions...
    EditGroundPolylineAction,
].forEach(/* existing registry */);

export {
    // existing exports...
    EditGroundPolylineAction,
};
```

在 `MainRenderView.ts` 的 `defaultActions` 追加：

```ts
'edit-ground-polyline',
```

- [ ] **Step 5: 构建验证 action 注册与类型**

Run:

```bash
cd /PnP/lxzhu/lidar_annos/xtreme/frontend/pc-tool
npm run build
```

Expected: Vite build 成功；无 action 未注册、`Raycaster.params.Points`、事件回调或导出错误。

- [ ] **Step 6: 提交主视图编辑 action**

```bash
cd /PnP/lxzhu/lidar_annos/xtreme
git add \
  frontend/pc-tool/src/packages/pc-render/action/EditGroundPolylineAction.ts \
  frontend/pc-tool/src/packages/pc-render/index.ts \
  frontend/pc-tool/src/packages/pc-render/renderView/MainRenderView.ts
git commit -m "Add curb wall vertex handles to main view"
```

### Task 4: 把主视图拖动接入撤销命令并完成回归验证

**Files:**
- Modify: `frontend/pc-tool/src/packages/pc-editor/hack.ts`

**Interfaces:**
- Consumes: `EditGroundPolylineAction.onGroundPolylinePointsChange`
- Consumes: command `update-ground-polyline-points` with `{ object: GroundPolyline; points: THREE.Vector3[] }`

- [ ] **Step 1: 在 hackMainView 接入现有命令**

补充 import：

```ts
EditGroundPolylineAction,
```

在 `hackMainView()` 中加入：

```ts
const editGroundPolylineAction = view.getAction(
    'edit-ground-polyline',
) as EditGroundPolylineAction;
if (editGroundPolylineAction) {
    editGroundPolylineAction.onGroundPolylinePointsChange = (
        object: GroundPolyline,
        points: THREE.Vector3[],
    ): void => {
        editor.cmdManager.execute('update-ground-polyline-points', {
            object,
            points,
        });
    };
}
```

不要直接调用 `object.setPoints()`，否则无法撤销，也不会复用 DataManager 的投影更新。

- [ ] **Step 2: 运行完整前端构建**

Run:

```bash
cd /PnP/lxzhu/lidar_annos/xtreme/frontend/pc-tool
npm run build
```

Expected: `vite build --config vite.config.build.ts` 成功退出，exit code 0。

- [ ] **Step 3: 人工验证主视图编辑与回归**

在可加载点云标注任务的环境依次验证：

1. 创建一条 curb/wall，选中后主视图每个顶点出现一个手柄。
2. 缩放、平移、旋转主视图，手柄始终跟随折线顶点。
3. 拖手柄到路沿激光点，主视图与三视图都显示新位置，X/Y/Z 均变化。
4. 拖到 `0.5 m` 内无激光点的空处，顶点保持不变。
5. 拖动后按 Ctrl+Z，顶点恢复；Ctrl+Shift+Z 或项目现有 redo 操作可重做。
6. 取消选择或选择 3D box，折线手柄隐藏。
7. 三视图滚轮缩放、右键拖动画布、原有折线顶点拖动均正常。
8. 停车位和图像 2D 投影编辑均无行为变化。

- [ ] **Step 4: 检查本任务 diff，确保没有夹带现有改动**

Run:

```bash
cd /PnP/lxzhu/lidar_annos/xtreme
git --no-pager diff -- \
  frontend/pc-tool/src/packages/pc-render/action/OrbitControlsAction.ts \
  frontend/pc-tool/src/packages/pc-render/action/CreateAction.ts \
  frontend/pc-tool/src/packages/pc-editor/common/ActionManager/action/create.ts \
  frontend/pc-tool/src/packages/pc-render/action/EditGroundPolylineAction.ts \
  frontend/pc-tool/src/packages/pc-render/index.ts \
  frontend/pc-tool/src/packages/pc-render/renderView/MainRenderView.ts \
  frontend/pc-tool/src/packages/pc-editor/hack.ts
```

Expected: 只有本计划描述的画线相机交互、世界点预览、手柄吸附和命令桥接。

- [ ] **Step 5: 提交命令桥接**

```bash
cd /PnP/lxzhu/lidar_annos/xtreme
git add frontend/pc-tool/src/packages/pc-editor/hack.ts
git commit -m "Connect curb wall vertex dragging to undo history"
```

## 最终验收

- [ ] `npm run build` 在 `frontend/pc-tool` 成功。
- [ ] 按 `L` 后可滚轮缩放、右键拖动平移、中键拖动旋转。
- [ ] 相机变化不导致画线预览漂移。
- [ ] 右键单击结束，右键拖动不结束。
- [ ] 主视图顶点吸附点云并更新 XYZ。
- [ ] 顶点拖动可撤销。
- [ ] 三视图、停车位、2D 投影行为无回归。
