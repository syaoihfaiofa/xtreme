import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(
    r"experiment\\s*=\\s*dict\\([\\s\\S]*?work_dir\\s*=\\s*[\"\x27]([^\"\x27]+)[\"\x27]",
    text,
)
if match:
    print(match.group(1))
else:
    print("work_dirs/bevfusion_lidar_cam_custom_nus_3class")
