import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import './style.css';

const api = (path, options = {}) => fetch(`/api/reconstruction${path}`, {
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  ...options,
}).then(async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok || (body && body.code && body.code !== 'OK' && body.code !== 0)) {
    throw new Error(body?.message || `Request failed (${response.status})`);
  }
  return body?.data ?? body;
});

const query = new URLSearchParams(location.search);
let sceneId = query.get('sceneId');
const datasetId = query.get('datasetId');
let scene;
let annotations = [];
let currentFrame = 0;
let cameraConfig = [];
let renderer;
let threeScene;
let camera;
let controls;
let annotationGroup;
let pointCloudObject;

document.querySelector('#app').innerHTML = `
  <main class="app-shell">
    <header><strong>三维重建标注</strong><span id="scene-name">正在加载…</span><label class="archive-upload">导入场景 ZIP<input id="archive-input" type="file" accept=".zip,.tar,.gz,.bz2" /></label><span id="message"></span></header>
    <section class="workspace">
      <aside class="left-panel">
        <h2>Scene</h2><select id="scene-select"></select>
        <h2>全局标注</h2><div id="annotation-list" class="annotation-list"></div>
        <form id="annotation-form">
          <label>类别 ID<input required id="class-id" type="number" min="1" /></label>
          <label>几何（世界坐标 JSON）<textarea required id="geometry">{"type":"CUBOID","center":{"x":0,"y":0,"z":0},"size":{"x":1,"y":1,"z":1},"yaw":0}</textarea></label>
          <label>属性（可选 JSON）<textarea id="attributes">{}</textarea></label>
          <div class="form-actions"><button type="submit">保存标注</button><button type="button" id="new-annotation">新建</button></div>
        </form>
        <p class="hint">标注永远保存在全局重建坐标系；切换时刻不会复制标注。</p>
      </aside>
      <section class="point-cloud"><div id="viewer"></div><div class="viewer-note">全局点云（仅加载一次）</div></section>
      <aside class="right-panel"><h2>时刻图片</h2><div id="timeline" class="timeline"></div><div id="images" class="images"></div></aside>
    </section>
  </main>`;

const message = (text, error = false) => {
  const el = document.querySelector('#message');
  el.textContent = text || '';
  el.className = error ? 'error' : '';
};

function initViewer() {
  const host = document.querySelector('#viewer');
  threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color(0x101827);
  camera = new THREE.PerspectiveCamera(55, host.clientWidth / host.clientHeight, 0.1, 200000);
  camera.position.set(15, -15, 12);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  host.append(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.update();
  threeScene.add(new THREE.GridHelper(100, 100, 0x49566e, 0x28354d));
  threeScene.add(new THREE.AxesHelper(3));
  annotationGroup = new THREE.Group();
  threeScene.add(annotationGroup);
  const render = () => { requestAnimationFrame(render); renderer.render(threeScene, camera); };
  render();
  renderer.domElement.addEventListener('dblclick', (event) => {
    if (!pointCloudObject) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster(); raycaster.params.Points.threshold = 0.35;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(pointCloudObject, true)[0];
    if (!hit) return;
    const editor = document.querySelector('#geometry');
    try {
      const geometry = JSON.parse(editor.value);
      geometry.center = { x: Number(hit.point.x.toFixed(4)), y: Number(hit.point.y.toFixed(4)), z: Number(hit.point.z.toFixed(4)) };
      editor.value = JSON.stringify(geometry, null, 2);
      message('已将标注中心吸附到点云；调整尺寸后保存。');
    } catch (_) { message('请先填写有效的几何 JSON。', true); }
  });
  addEventListener('resize', () => {
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  });
}

function loadPointCloud(url) {
  const loader = new PCDLoader();
  loader.load(url, (points) => {
    points.name = 'global-reconstruction-cloud';
    pointCloudObject = points; threeScene.add(points);
    const box = new THREE.Box3().setFromObject(points);
    if (!box.isEmpty()) {
      controls.target.copy(box.getCenter(new THREE.Vector3()));
      camera.position.copy(controls.target).add(new THREE.Vector3(15, -15, 12));
      controls.update();
    }
  }, undefined, (error) => message(`点云加载失败：${error.message || error}`, true));
}

function annotationGeometry(g) {
  const type = String(g.type || '').toUpperCase();
  if (type === 'KEY_POINT' || type === 'POINT') {
    const point = g.position || g.center;
    if (!point) return null;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    marker.position.set(point.x, point.y, point.z); return marker;
  }
  if (type === 'POLYLINE' || type === 'GROUND_POLYLINE' || type === 'CURB_WALL') {
    if (!Array.isArray(g.points) || g.points.length < 2) return null;
    const points = g.points.map((point) => new THREE.Vector3(point.x, point.y, point.z));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffd166 }));
  }
  const center = g.center || g.position;
  const size = g.size || g.scale;
  if (!center || !size) return null;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({ color: 0x44d7ff, transparent: true, opacity: 0.18 }));
  cube.position.set(center.x, center.y, center.z);
  cube.rotation.z = g.yaw || 0;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x44d7ff }));
  edge.position.copy(cube.position); edge.rotation.copy(cube.rotation);
  const group = new THREE.Group(); group.add(cube, edge); return group;
}

function renderAnnotations() {
  annotationGroup.clear();
  const list = document.querySelector('#annotation-list'); list.innerHTML = '';
  annotations.forEach((annotation) => {
    const geometry = annotation.geometry || {};
    const visual = annotationGeometry(geometry);
    if (visual) annotationGroup.add(visual);
    const row = document.createElement('button');
    row.className = 'annotation-row';
    row.textContent = `#${annotation.id} · class ${annotation.classId} · ${geometry.type || 'geometry'}`;
    row.onclick = () => editAnnotation(annotation);
    list.append(row);
  });
  renderImages();
}

function editAnnotation(annotation) {
  document.querySelector('#annotation-form').dataset.id = annotation.id;
  document.querySelector('#class-id').value = annotation.classId;
  document.querySelector('#geometry').value = JSON.stringify(annotation.geometry, null, 2);
  document.querySelector('#attributes').value = JSON.stringify(annotation.classAttributes || {}, null, 2);
}

function projectionPoint(annotation, image, frame) {
  const geometry = annotation.geometry || {};
  const p = geometry.center || geometry.position || geometry.points?.[0];
  if (!p) return null;
  const cfg = cameraConfig[image.cameraIndex];
  const internal = cfg?.cameraInternal || cfg?.camera_internal;
  const external = cfg?.cameraExternal || cfg?.camera_external;
  if (!internal || !external || external.length !== 16) return null;
  // world -> ego/location -> camera. cameraExternal uses the existing Xtreme camera convention.
  const worldFromEgo = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(frame.roll || 0, frame.pitch || 0, frame.yaw || 0, 'ZYX'));
  worldFromEgo.setPosition(frame.posX, frame.posY, frame.posZ);
  const egoFromWorld = worldFromEgo.clone().invert();
  const cameraFromEgo = new THREE.Matrix4().fromArray(external);
  const cameraPoint = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(egoFromWorld).applyMatrix4(cameraFromEgo);
  if (cameraPoint.z >= -0.001) return null;
  const x = internal.fx * (cameraPoint.x / -cameraPoint.z) + internal.cx;
  const y = internal.fy * (-cameraPoint.y / -cameraPoint.z) + internal.cy;
  return { x, y };
}

function renderImages() {
  const host = document.querySelector('#images'); host.innerHTML = '';
  const frame = scene.frames[currentFrame]; if (!frame) return;
  frame.images.forEach((image) => {
    const wrap = document.createElement('div'); wrap.className = 'image-wrap';
    const img = document.createElement('img'); img.src = image.url; img.alt = `camera ${image.cameraIndex}`;
    const overlay = document.createElement('div'); overlay.className = 'overlay';
    img.onload = () => annotations.forEach((annotation) => {
      const point = projectionPoint(annotation, image, frame);
      if (!point) return;
      const marker = document.createElement('button'); marker.className = 'projection'; marker.textContent = String(annotation.id);
      marker.style.left = `${(point.x / img.naturalWidth) * 100}%`;
      marker.style.top = `${(point.y / img.naturalHeight) * 100}%`;
      marker.onclick = () => editAnnotation(annotation); overlay.append(marker);
    });
    const caption = document.createElement('span'); caption.textContent = `Camera ${image.cameraIndex}`;
    wrap.append(img, overlay, caption); host.append(wrap);
  });
}

function renderTimeline() {
  const host = document.querySelector('#timeline'); host.innerHTML = '';
  scene.frames.forEach((frame, index) => {
    const button = document.createElement('button');
    button.textContent = String(frame.timestampNs); button.className = index === currentFrame ? 'active' : '';
    button.onclick = () => { currentFrame = index; renderTimeline(); renderImages(); };
    host.append(button);
  });
}

async function loadScene(id) {
  sceneId = id; currentFrame = 0; message('加载 Scene…');
  scene = await api(`/scenes/${sceneId}`);
  document.querySelector('#scene-name').textContent = scene.name;
  cameraConfig = await fetch(scene.cameraConfigUrl).then((r) => r.json()).then((config) => Array.isArray(config) ? config :
    Object.entries(config || {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, value]) => value));
  annotations = await api(`/scenes/${sceneId}/annotations`);
  renderTimeline(); renderAnnotations(); loadPointCloud(scene.pointCloudUrl); message('');
}

async function boot() {
  initViewer();
  if (!sceneId && datasetId) {
    const scenes = await api(`/scenes?datasetId=${encodeURIComponent(datasetId)}`);
    sceneId = scenes[0]?.id;
  }
  if (!sceneId) throw new Error('请通过 ?sceneId=<id> 或 ?datasetId=<id> 打开重建 Scene。');
  const allScenes = datasetId ? await api(`/scenes?datasetId=${encodeURIComponent(datasetId)}`) : [];
  const select = document.querySelector('#scene-select');
  allScenes.forEach((item) => { const option = new Option(item.name, item.id, item.id === Number(sceneId), item.id === Number(sceneId)); select.add(option); });
  select.onchange = () => loadScene(select.value).catch((error) => message(error.message, true));
  await loadScene(sceneId);
}

document.querySelector('#new-annotation').onclick = () => {
  const form = document.querySelector('#annotation-form'); form.reset(); delete form.dataset.id;
};
document.querySelector('#archive-input').onchange = async (event) => {
  const file = event.target.files?.[0];
  const targetDatasetId = scene?.datasetId || datasetId;
  if (!file || !targetDatasetId) {
    message('请通过 ?datasetId=<id> 打开后再导入 ZIP。', true); return;
  }
  try {
    message('正在导入重建 ZIP…');
    const form = new FormData(); form.append('file', file);
    const response = await fetch(`/api/reconstruction/upload/file?datasetId=${encodeURIComponent(targetDatasetId)}`, { method: 'POST', body: form });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || `导入失败 (${response.status})`);
    const ids = body?.data ?? body;
    const firstSceneId = Array.isArray(ids) ? ids[0] : null;
    if (!firstSceneId) throw new Error('导入没有返回 Scene。');
    location.href = `${location.pathname}?datasetId=${encodeURIComponent(targetDatasetId)}&sceneId=${encodeURIComponent(firstSceneId)}`;
  } catch (error) { message(error.message, true); }
};
document.querySelector('#annotation-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    const annotation = {
      classId: Number(document.querySelector('#class-id').value),
      geometry: JSON.parse(document.querySelector('#geometry').value),
      classAttributes: JSON.parse(document.querySelector('#attributes').value || '{}'),
    };
    if (form.dataset.id) annotation.id = Number(form.dataset.id);
    const saved = await api(`/scenes/${sceneId}/annotations`, { method: 'POST', body: JSON.stringify([annotation]) });
    const index = annotations.findIndex((item) => item.id === saved[0].id);
    if (index >= 0) annotations[index] = saved[0]; else annotations.push(saved[0]);
    editAnnotation(saved[0]); renderAnnotations(); message('已保存');
  } catch (error) { message(`保存失败：${error.message}`, true); }
};
boot().catch((error) => message(error.message, true));
