"""
投影参数（IPM 鸟瞰 remap 表 map_xys）的本地缓存。

labelDual 模式下，labelViewer 进程启动时会调用 TopdownProjection.GenerateMap()
为每路相机生成 IPM remap 查找表（每张 float32 (H, W, 2) 数组）。这一步是启动耗时
大头。该模块把这些表缓存到本地，下次启动直接读盘：

- 缓存 key = 标定来源文件指纹（camera_config.json + stitching_config.json 内容 +
  CACHE_VERSION）。指纹随标定内容变化而变化。
- 加载前做"快速本地校验"：重新计算当前标定文件指纹，与缓存内记录的指纹比对；
  同时校验缓存版本、相机集合、各表形状/类型。任一不符即视为失效，回退在线计算。
- 对于缺失缓存（或校验失败）的配置，在线计算后写盘，供下次复用。

注意：仅缓存与标定强相关、与具体图像无关的 map_xys；per-image 的量（cam_idx、
conf_key、interpolate 结果）不缓存。
"""

import hashlib
import os
import tempfile
import traceback

import numpy as np


# 缓存格式/计算逻辑变更时递增，使旧缓存自动失效
CACHE_VERSION = "1"

_CACHE_DIRNAME = ".proj_cache"


def _hash_file_into(hasher, path):
    """把单个文件内容喂入 hasher；文件不存在则喂入占位标记。"""
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                hasher.update(chunk)
        return True
    except (IOError, OSError):
        hasher.update(b"<missing>")
        return False


def compute_calib_fingerprint(camera_config_file, stitching_config_file, extra=None):
    """对标定来源文件内容 + 版本 + 附加参数计算 SHA256 指纹（hex 字符串）。

    指纹是缓存的有效性凭据：标定内容（含外参/内参/拼接配置）一旦变化，指纹随之变化，
    旧缓存被判定失效，从而避免"投影参数被临时修改"后仍误用过期缓存。
    """
    h = hashlib.sha256()
    h.update(("v" + str(CACHE_VERSION) + "|").encode("utf-8"))
    h.update(b"camera_config|")
    _hash_file_into(h, camera_config_file)
    h.update(b"|stitching_config|")
    if stitching_config_file:
        _hash_file_into(h, stitching_config_file)
    else:
        h.update(b"<none>")
    if extra:
        h.update(b"|extra|")
        h.update(str(extra).encode("utf-8"))
    return h.hexdigest()


def _cache_root_candidates(conf_dir):
    """返回缓存根目录候选（按优先级）：标定目录内 -> 用户家目录 -> 临时目录。"""
    candidates = []
    if conf_dir:
        candidates.append(os.path.join(conf_dir, _CACHE_DIRNAME))
    home = os.path.expanduser("~")
    if home and home != "~":
        candidates.append(os.path.join(home, ".cache", "labelImg", "proj_cache"))
    candidates.append(os.path.join(tempfile.gettempdir(), "labelImg_proj_cache"))
    return candidates


def _ensure_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
        return os.path.isdir(path) and os.access(path, os.W_OK)
    except (IOError, OSError):
        return False


def cache_file_for(conf_dir, fingerprint, writable=False):
    """根据 conf_dir + 指纹定位缓存文件路径。

    writable=True 时返回第一个可写候选目录下的路径（用于保存）；
    writable=False 时返回第一个已存在缓存文件的路径（用于读取），都不存在则返回 None。
    """
    fname = "topdown_map_%s.npz" % fingerprint[:16]
    if writable:
        for root in _cache_root_candidates(conf_dir):
            if _ensure_dir(root):
                return os.path.join(root, fname)
        return None
    for root in _cache_root_candidates(conf_dir):
        path = os.path.join(root, fname)
        if os.path.isfile(path):
            return path
    return None


def load_topdown_map(cache_file, fingerprint, expected):
    """读取并校验缓存的 map_xys。

    expected: {cam_idx: (height, width)} 期望的各相机 map 形状。
    返回 {cam_idx: np.ndarray(float32, (H, W, 2))}，校验不通过返回 None。
    """
    if not cache_file or not os.path.isfile(cache_file):
        return None
    try:
        with np.load(cache_file, allow_pickle=False) as data:
            # 快速本地校验：版本 + 指纹
            if str(data["version"].item()) != str(CACHE_VERSION):
                return None
            if str(data["fingerprint"].item()) != str(fingerprint):
                return None
            saved_cams = [int(c) for c in data["cam_indexes"].tolist()]
            if set(saved_cams) != set(int(c) for c in expected.keys()):
                return None
            out = {}
            for cam_idx in saved_cams:
                key = "cam_%d" % cam_idx
                if key not in data.files:
                    return None
                arr = data[key]
                exp_h, exp_w = expected[cam_idx]
                if arr.shape != (exp_h, exp_w, 2):
                    return None
                out[cam_idx] = np.ascontiguousarray(arr.astype(np.float32))
            return out
    except Exception as e:
        # 缓存损坏/被篡改/格式不符，统一回退在线计算
        print("ProjectionCache: ignore invalid cache %s (%s)" % (cache_file, e))
        return None


def save_topdown_map(cache_file, fingerprint, map_xys):
    """把 map_xys 写盘。仅保存非空表。失败不抛异常（缓存为加速项，不应影响主流程）。"""
    if not cache_file:
        return False
    try:
        cam_indexes = [int(c) for c, v in map_xys.items() if v is not None]
        cam_indexes.sort()
        arrays = {}
        for cam_idx in cam_indexes:
            arrays["cam_%d" % cam_idx] = np.ascontiguousarray(
                map_xys[cam_idx].astype(np.float32))
        tmp = cache_file + ".tmp"
        np.savez(
            tmp,
            version=np.array(str(CACHE_VERSION)),
            fingerprint=np.array(str(fingerprint)),
            cam_indexes=np.array(cam_indexes, dtype=np.int64),
            **arrays)
        # np.savez 会补 .npz 后缀
        if os.path.isfile(tmp + ".npz"):
            tmp = tmp + ".npz"
        os.replace(tmp, cache_file)
        return True
    except Exception:
        traceback.print_exc()
        try:
            if os.path.isfile(cache_file + ".tmp"):
                os.remove(cache_file + ".tmp")
            if os.path.isfile(cache_file + ".tmp.npz"):
                os.remove(cache_file + ".tmp.npz")
        except OSError:
            pass
        return False
