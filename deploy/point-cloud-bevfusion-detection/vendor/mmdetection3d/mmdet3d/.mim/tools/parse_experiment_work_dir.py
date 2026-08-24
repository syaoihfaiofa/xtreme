import re, sys
from pathlib import Path
_DEFAULT = "work_dirs/bevfusion_lidar_cam_custom_nus_3class"
if len(sys.argv) < 2:
    print(_DEFAULT)
    raise SystemExit(0)
text = Path(sys.argv[1]).read_text(encoding="utf-8")
quote = chr(39) + chr(34)
pattern = (
    r"experiment\s*=\s*dict\([\s\S]*?work_dir\s*=\s*"
    + "[" + quote + "]"
    + r"([^" + quote + "]+)"
    + "[" + quote + "]"
)
m = re.search(pattern, text)
print(m.group(1) if m else _DEFAULT)
