"""PCD readers required by the self-contained OCC worker."""

from typing import Dict, List, Tuple

import numpy as np


_DTYPES = {
    ("F", 4): "<f4",
    ("F", 8): "<f8",
    ("I", 1): "i1",
    ("I", 2): "<i2",
    ("I", 4): "<i4",
    ("U", 1): "u1",
    ("U", 2): "<u2",
    ("U", 4): "<u4",
}


def read_pcd_xyz(path: str) -> np.ndarray:
    """Read XYZ columns from ASCII or uncompressed binary PCD data."""
    with open(path, "rb") as stream:
        header_lines, header = _read_header(stream)
        encoding = _required_single_value(header, "DATA").lower()
        payload = stream.read()

    fields = header.get("FIELDS", [])
    if not all(name in fields for name in ("x", "y", "z")):
        raise ValueError("{}: PCD must contain x, y, z fields".format(path))
    points = int(_required_single_value(header, "POINTS"))
    if encoding == "ascii":
        return _read_ascii_xyz(payload, fields, points, path)
    if encoding == "binary":
        return _read_binary_xyz(payload, header, points, path)
    raise ValueError("{}: unsupported PCD DATA encoding {}".format(path, encoding))


def _read_header(stream) -> Tuple[List[bytes], Dict[str, List[str]]]:
    lines = []
    header = {}
    for raw_line in stream:
        lines.append(raw_line)
        values = raw_line.decode("ascii", "strict").strip().split()
        if not values or values[0].startswith("#"):
            continue
        key = values[0].upper()
        header[key] = values[1:]
        if key == "DATA":
            return lines, header
    raise ValueError("PCD header has no DATA line")


def _required_single_value(header: Dict[str, List[str]], key: str) -> str:
    values = header.get(key)
    if values is None or len(values) != 1:
        raise ValueError("PCD header requires exactly one {} value".format(key))
    return values[0]


def _read_ascii_xyz(
    payload: bytes, fields: List[str], points: int, path: str
) -> np.ndarray:
    values = np.fromstring(payload.decode("ascii", "strict"), sep=" ")
    if len(fields) == 0 or values.size != points * len(fields):
        raise ValueError("{}: ASCII PCD point count does not match header".format(path))
    rows = values.reshape(points, len(fields))
    return rows[:, [fields.index("x"), fields.index("y"), fields.index("z")]]


def _read_binary_xyz(
    payload: bytes, header: Dict[str, List[str]], points: int, path: str
) -> np.ndarray:
    fields = header.get("FIELDS", [])
    sizes = [int(value) for value in header.get("SIZE", [])]
    types = header.get("TYPE", [])
    counts = [int(value) for value in header.get("COUNT", ["1"] * len(fields))]
    if not (len(fields) == len(sizes) == len(types) == len(counts)):
        raise ValueError("{}: inconsistent binary PCD field metadata".format(path))

    dtype_fields = []
    for field, size, field_type, count in zip(fields, sizes, types, counts):
        base = _DTYPES.get((field_type.upper(), size))
        if base is None or count < 1:
            raise ValueError("{}: unsupported PCD field {} metadata".format(path, field))
        dtype_fields.append((field, base, (count,)) if count > 1 else (field, base))
    dtype = np.dtype(dtype_fields)
    expected = points * dtype.itemsize
    if len(payload) != expected:
        raise ValueError("{}: binary PCD payload size does not match header".format(path))
    rows = np.frombuffer(payload, dtype=dtype, count=points)
    return np.column_stack((rows["x"], rows["y"], rows["z"])).astype(np.float64)
