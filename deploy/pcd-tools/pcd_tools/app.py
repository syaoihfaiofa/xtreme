import io
import json
import requests
import numpy as np
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from pcd_tools.service import *
from pcd_tools import *
from pcd_tools.metrics.map import build_metrics


D_RESOLUTION = 1000
D_NUM_STD = 3
D_COLORS = (0x6055C6, 0x378CDF, 0x1CC7C1, 0x33EC83, 0x7FF55B)
D_Z_RANGE = None
MAX_PREVIEW_POINTS = 50000
CHUNK_POINT_THRESHOLD = 200000
CHUNK_GRID_METERS = 20.0
CHUNK_MAX_POINTS = 50000


def _build_item_error(code: int, message: str):
    return {
        "code": code,
        "message": message
    }


def _sample_preview(points, max_points=MAX_PREVIEW_POINTS):
    """Deterministic voxel sampling that preserves the structured PCD fields."""
    if len(points) <= max_points:
        return points
    xyz = np.column_stack((points['x'], points['y'], points['z'])).astype(np.float64)
    minimum = xyz.min(axis=0)
    span = xyz.max(axis=0) - minimum
    volume = max(float(np.prod(span)), 1e-9)
    voxel_size = max((volume / max_points) ** (1.0 / 3.0), 1e-6)
    voxels = np.floor((xyz - minimum) / voxel_size).astype(np.int64)
    _, indices = np.unique(voxels, axis=0, return_index=True)
    # A densely occupied cloud can still contain more voxels than the limit. Sort by voxel
    # coordinate and take evenly spaced representatives to remain deterministic and spatial.
    if len(indices) > max_points:
        ordered = np.lexsort((voxels[indices, 2], voxels[indices, 1], voxels[indices, 0]))
        indices = indices[ordered[np.linspace(0, len(ordered) - 1, max_points, dtype=np.int64)]]
    return points[np.sort(indices)]


def _build_chunks(points):
    """Return deterministic XY chunks, splitting dense cells so no chunk exceeds the limit."""
    xy = np.column_stack((points['x'], points['y'])).astype(np.float64)
    origin = np.floor(xy.min(axis=0) / CHUNK_GRID_METERS) * CHUNK_GRID_METERS
    cells = np.floor((xy - origin) / CHUNK_GRID_METERS).astype(np.int64)
    order = np.lexsort((cells[:, 1], cells[:, 0]))
    chunks = []
    start = 0
    while start < len(order):
        end = start + 1
        cell = cells[order[start]]
        while end < len(order) and np.array_equal(cells[order[end]], cell):
            end += 1
        indices = order[start:end]
        # Stable order makes the generated assets repeatable for identical input.
        for part in range(0, len(indices), CHUNK_MAX_POINTS):
            selected = np.sort(indices[part:part + CHUNK_MAX_POINTS])
            data = points[selected]
            xyz = np.column_stack((data['x'], data['y'], data['z']))
            chunks.append((data, [float(v) for v in xyz.min(axis=0)] + [float(v) for v in xyz.max(axis=0)]))
        start = end
    return chunks

class AppHandler(BaseApiHandler):
    # override
    def post(self):
        args = self.args
        data = self.get_field(args, key='data', type_=list, check_empty=True)
        task_type = self.get_field(args, key='type', type_=int)
        if task_type < 1 or task_type > 3:
            raise ValueError(f"invalid 'type' value: {task_type}")

        # renderParam
        renderParam = args.get("renderParam", {})
        colors = renderParam.get('colors', D_COLORS)
        zRange = renderParam.get('zRange', D_Z_RANGE)
        width = renderParam.get('width', D_RESOLUTION)
        height = renderParam.get('height', D_RESOLUTION)
        num_std = renderParam.get('numStd', D_NUM_STD)
        
        pcd2image = PC2Image(colors, zRange, (width, height), num_std)

        # convertParam
        convertParam = args.get("convertParam", {})
        extra_fields = convertParam.get('extraFields', [])

        # process
        num_samples = len(data)
        if num_samples > 1:
            max_workers =  min(8, num_samples)
            logging.info(f"using ThreadPoolExecutor with {max_workers} workers")

            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                results = list(executor.map(
                    partial(self.process_data, task_type=task_type, pcd2image=pcd2image, extra_fields=extra_fields), 
                    data))
        else:
            results = [self.process_data(item, task_type, pcd2image, extra_fields) for item in data]
        self.return_ok(results)

    def process_data(self, item, task_type, pcd2image, extra_fields):
        if not isinstance(item, dict):
            return _build_item_error(1, "data item must be a dictionary")

        pc_file = item.get("pointCloudFile", None)
        if pc_file is None:
            return _build_item_error(1, "missing 'pointCloudFile'")

        if not isinstance(pc_file, str) or not pc_file.startswith("http"):
            return _build_item_error(1, "invalid 'pointCloudFile'")

        result = {
            "code": 0,
            "message": "success"
        }
        try:
            t = Timing()
            logging.info(f"{'-'*10} {pc_file} {'-'*10}")

            r = requests.get(pc_file, allow_redirects=True)
            t.log_interval(f"DOWNLOAD pcd({len(r.content)/1024/1024:.1f}MB)")

            pcd_path = io.BytesIO(r.content)
            pc = PointCloud(pcd_path)
            if pc.invalid_points > 0:
                logging.info(f"\t{pc.invalid_points} invalid points removed")
            t.log_interval(f'LOAD pcd')

            # bev image
            if task_type != 2:
                upload_image_path = item.get("uploadImagePath", None)
                if upload_image_path is None:
                    return _build_item_error(1, "missing 'uploadImagePath'")

                image, (left, top, right, bottom) = pcd2image.bev_from_pc(pc.normalized_numpy())
                with io.BytesIO() as output:
                    image.save(output, format="PNG")
                    contents = output.getvalue()
                result.update({
                    'pointCloudRange': {
                        'left': left,
                        'top': top,
                        'right': right,
                        'bottom': bottom
                    },
                    'imageSize': len(contents)
                })
                t.log_interval("GEN image")

                # upload image
                r = requests.put(upload_image_path, data=contents, headers={"Content-Type":"application/binary"})
                if r.status_code != 200:
                    msg = f"upload image failed({r.status_code}): '{upload_image_path}'\n{r.text}"
                    logging.warn(msg)
                    return _build_item_error(2, msg)

                t.log_interval(f"UPLOAD image({len(contents)/1024:.0f}KB)")

            # normalize point cloud
            if task_type != 3:
                upload_binary_pcd_path = item.get("uploadBinaryPcdPath", None)
                if upload_binary_pcd_path is None:
                    return _build_item_error(1, "missing 'uploadBinaryPcdPath'")

                npc = pc.normalized_pc(extra_fields=extra_fields)
                result['pointCount'] = len(npc)
                with io.BytesIO() as output:
                    pc.save_pcd(npc, output)
                    contents = output.getvalue()
                result['binaryPcdSize'] = len(contents)
                # upload point cloud
                r = requests.put(upload_binary_pcd_path, data=contents, headers={"Content-Type":"application/binary"})
                if r.status_code != 200:
                    msg = f"upload pcd failed({r.status_code}): '{upload_binary_pcd_path}'"
                    logging.warning(msg)
                    return _build_item_error(2, msg)
                t.log_interval(f"UPLOAD pcd({len(contents)/1024/1024:.1f}MB)\n{r.text}")

                upload_preview_pcd_path = item.get("uploadPreviewPcdPath")
                if upload_preview_pcd_path:
                    try:
                        preview = _sample_preview(npc)
                        with io.BytesIO() as output:
                            pc.save_pcd(preview, output)
                            preview_contents = output.getvalue()
                        response = requests.put(
                            upload_preview_pcd_path,
                            data=preview_contents,
                            headers={"Content-Type": "application/binary"},
                        )
                        if response.status_code == 200:
                            result['previewPcdSize'] = len(preview_contents)
                            result['previewPointCount'] = len(preview)
                            t.log_interval(f"UPLOAD preview({len(preview_contents)/1024/1024:.1f}MB)")
                        else:
                            logging.warning("upload preview failed(%s): %s", response.status_code, response.text)
                    except Exception:
                        # Full binary output remains valid even if preview creation fails.
                        logging.exception("generate preview PCD failed")

                # Chunk uploads are optional.  Existing callers keep the full/preview-only path.
                chunk_uploads = item.get("chunkUploads") or []
                manifest_upload = item.get("uploadChunkManifestPath")
                if len(npc) > CHUNK_POINT_THRESHOLD and manifest_upload and chunk_uploads:
                    try:
                        chunks = _build_chunks(npc)
                        if len(chunks) > len(chunk_uploads):
                            raise ValueError("insufficient chunk upload slots")
                        manifest_chunks = []
                        for index, (chunk, bounds) in enumerate(chunks):
                            target = chunk_uploads[index]
                            with io.BytesIO() as output:
                                pc.save_pcd(chunk, output)
                                chunk_content = output.getvalue()
                            response = requests.put(target['uploadUrl'], data=chunk_content,
                                headers={"Content-Type": "application/binary"})
                            if response.status_code != 200:
                                raise IOError(f"upload chunk failed({response.status_code})")
                            manifest_chunks.append({
                                'id': target['id'], 'path': target['path'], 'bounds': bounds,
                                'pointCount': len(chunk), 'byteSize': len(chunk_content),
                            })
                        manifest = {'version': 1, 'pointCount': len(npc),
                            'fields': list(npc.dtype.names), 'chunks': manifest_chunks}
                        manifest_content = json.dumps(manifest, separators=(',', ':')).encode('utf-8')
                        response = requests.put(manifest_upload, data=manifest_content,
                            headers={"Content-Type": "application/json"})
                        if response.status_code != 200:
                            raise IOError(f"upload chunk manifest failed({response.status_code})")
                        result['chunkManifestSize'] = len(manifest_content)
                        result['chunkCount'] = len(manifest_chunks)
                        t.log_interval(f"UPLOAD chunks({len(manifest_chunks)})")
                    except Exception:
                        # Chunking is an optimisation; full and preview assets stay usable.
                        logging.exception("generate point cloud chunks failed")

            logging.info(f"--- pcd info: {pc.code}, {pc.fields}, {len(pc.data):,} points")

        except Exception as e:
            logging.exception(e)
            return _build_item_error(2, str(e))

        return result

class EvaluateHandler(BaseApiHandler):
    # override
    def post(self):
        args = self.args
        gtUrl = self.get_field(args, key='groundTruthResultFileUrl', type_=str, check_empty=True)
        modelUrl = self.get_field(args, key='modelRunResultFileUrl', type_=str, check_empty=True)

        try:
            t = Timing()
            targets, l = self.load_objects_from_file(gtUrl)
            t.log_interval(f"DOWNLOAD groundTruthResultFileUrl({l/1024:.1f}KB)")

            preds, l = self.load_objects_from_file(modelUrl)
            t.log_interval(f"DOWNLOAD modelRunResultFileUrl({l/1024:.1f}KB)")

            metrics = build_metrics(preds, targets)
            logging.info(f"---metrics: {json.dumps(metrics)}")

            ret_metrics = [
                {
                    "name": name,
                    "value": round(value, 4),
                    "description": f"{'mean ' if name.startswith('mAP') else ''}average precision for {name.split('_')[-1]}"
                }
                for name, value in metrics.items()
                if name.startswith('mAP') or name.startswith('AP')
            ]
            if len(metrics) > 2:
                ret_metrics.extend([
                    {
                        "name": f"AP-{type}-{label}",
                        "value": round(m[type]['AP'], 4),
                        "description": f"average precision for {label}"
                    }
                    for label, m in metrics.items()
                    for type in ['bev', '3d']
                    if not label.startswith('mAP') and not label.startswith('AP')
                ]) 

            self.return_ok({
                "metrics": ret_metrics,
            })

        except json.decoder.JSONDecodeError as e:
            logging.exception(e)
            return self.return_error("parse file failed, make sure each line is a json string")
        
        except KeyError as e:
            logging.exception(e)
            return self.return_error(f"missing key: {e}")

        except Exception as e:
            logging.exception(e)
            return _build_item_error(2, str(e))


    @staticmethod
    def load_objects_from_file(file):
        r = requests.get(file, allow_redirects=True)
        f = io.BytesIO(r.content)
        objects = [json.loads(line)['objects'] for line in f if line.strip()]
        return objects, len(r.content)

def main():
    parser = ArgumentParser()
    args = parse_args(parser)

    start_service([
            (r'/pointcloud/convert_render', AppHandler),
            (r'/pointCloud/resultEvaluate', EvaluateHandler),
        ],
        args)


if __name__ == '__main__':
    main()
