import json
import os
from collections import OrderedDict
from ad_ext.LabelingStandards import *

kClassesInStandards = kMODClassesInStandards
kLabelStandardIndices = {key: idx for idx, key in enumerate(kClassesInStandards)}

# Standard type constants for determining which branches are affected
# A standard affects a branch if the standard's classes include that branch's classes

def standard_has_basic(standard_name):
    """Check if a standard includes basic detection classes.
    
    Basic detection excludes:
    - Corner classes (corner_* prefix)
    - Mask/seg classes (freespace, obstacle)
    - Topdown/corner-only standards (v2*)
    - Pure segmentation standards (v4*)
    """
    if standard_name not in kClassesInStandards:
        return False
    # v2* are topdown/corner standards, v4* are segmentation-only
    if standard_name.startswith('v2') or standard_name.startswith('v4'):
        return False
    return True

def standard_has_corner(standard_name):
    """Check if a standard includes corner classes.
    
    Corner classes can be:
    1. Classes with 'corner_' prefix directly in the standard
    2. v2* standards (topdown views used for corner detection)
    """
    if standard_name not in kClassesInStandards:
        return False
    # v2 standards are topdown/corner standards
    if standard_name.startswith('v2'):
        return True
    return False

def standard_has_mask(standard_name):
    """Check if a standard includes mask/segmentation classes (freespace, obstacle)."""
    if standard_name not in kClassesInStandards:
        return False
    if standard_name.startswith('v4'):
        return True
    classes = kClassesInStandards[standard_name]
    # Mask if has freespace
    for c in classes:
        if c in ('freespace'):
            return True
    return False

# Build lookup tables for efficient batch processing
kStandardHasBasic = {std: standard_has_basic(std) for std in kClassesInStandards}
kStandardHasCorner = {std: standard_has_corner(std) for std in kClassesInStandards}
kStandardHasMask = {std: standard_has_mask(std) for std in kClassesInStandards}

# Index-based lookup (standard_idx -> has_xxx)
kStandardIdxHasBasic = {idx: kStandardHasBasic[std] for std, idx in kLabelStandardIndices.items()}
kStandardIdxHasCorner = {idx: kStandardHasCorner[std] for std, idx in kLabelStandardIndices.items()}
kStandardIdxHasMask = {idx: kStandardHasMask[std] for std, idx in kLabelStandardIndices.items()}


class Labels:
    """
    Label management class for loading and querying label definitions.
    
    Supports multiple label groups (e.g., "", "corner", "mask", "quad", "polyline", etc.)
    with a unified interface for querying any group.
    
    All indices are 0-indexed.
    
    Usage:
        labels = Labels("labels.json")
        
        # Get all group keys
        labels.groups  # ["", "corner", "mask"]
        
        # Query any group generically
        labels.get_group_names("corner")      # ["corner_car", ...]
        labels.get_group_count("corner")      # 4
        labels.get_group_start_idx("corner")  # 3
        
        # Name/index conversion (0-indexed)
        labels.name_to_index("car")           # 0
        labels.index_to_name(0)               # "car"
    """
    
    def __init__(self, filename=None):
        """
        Initialize Labels instance.
        
        Args:
            filename: Path to label file (txt or json). If None, creates empty instance.
        """
        self._label_dict = OrderedDict()
        self._all_names = []
        self._name_to_idx = {}
        self._group_start_indices = {}
        
        if filename is not None:
            self.load(filename)
    
    def load(self, filename):
        """Load labels from file (txt or json)."""
        ext = os.path.splitext(filename)[1].lower()
        
        if ext == '.json':
            self._label_dict = self._load_from_json(filename)
        else:
            self._label_dict = self._load_from_txt(filename)
        
        self._build_indices()
    
    def _load_from_json(self, filename):
        """Load labels from JSON file."""
        with open(filename, 'r') as f:
            data = json.load(f, object_pairs_hook=OrderedDict)
        
        label_dict = OrderedDict({k: list(v) for k, v in data.items() if len(v) > 0})
        return label_dict
    
    def _load_from_txt(self, filename):
        """Load labels from TXT file (legacy format)."""
        label_names = []
        with open(filename) as file:
            for line in file:
                line = line.strip()
                if len(line) > 0:
                    label_names.append(line)
        
        # Separate classes by type
        normal_classes = []
        corner_classes = []
        
        for name in label_names:
            if name.startswith(kCornerClassPrefix):
                corner_classes.append(name)
            else:
                normal_classes.append(name)
        
        label_dict = OrderedDict()
        if len(normal_classes) > 0:
            label_dict[""] = normal_classes
        if len(corner_classes) > 0:
            label_dict["corner"] = corner_classes
        
        return label_dict
    
    def _build_indices(self):
        """Build internal index mappings."""
        self._all_names = []
        self._group_start_indices = {}
        
        for key, classes in self._label_dict.items():
            # Start index for this group
            self._group_start_indices[key] = len(self._all_names)
            self._all_names.extend(classes)
        
        # Build name to index mapping (0-indexed)
        self._name_to_idx = {name: idx for idx, name in enumerate(self._all_names)}
    
    # ==================== Group Properties ====================
    
    @property
    def groups(self):
        """Get list of all group keys."""
        return list(self._label_dict.keys())
    
    @property
    def label_dict(self):
        """Get the raw label dictionary."""
        return self._label_dict
    
    def get_group_names(self, group_key):
        """
        Get class names for a specific group.
        
        Args:
            group_key: Group key (e.g., "", "corner", "mask", "quad", "polyline")
            
        Returns:
            list: List of class names in the group, empty list if group not found
        """
        return self._label_dict.get(group_key, [])
    
    def get_group_count(self, group_key):
        """
        Get number of classes in a specific group.
        
        Args:
            group_key: Group key
            
        Returns:
            int: Number of classes in the group
        """
        return len(self._label_dict.get(group_key, []))
    
    def get_group_start_idx(self, group_key):
        """
        Get the starting index of a group (0-indexed).
        
        Args:
            group_key: Group key
            
        Returns:
            int or None: Start index of the group, or None if group not found
        """
        if group_key not in self._label_dict or len(self._label_dict[group_key]) == 0:
            return None
        return self._group_start_indices.get(group_key)
    
    def has_group(self, group_key):
        """Check if a group exists and has classes."""
        return group_key in self._label_dict and len(self._label_dict[group_key]) > 0
    
    # ==================== Total Classes ====================
    
    @property
    def all_names(self):
        """Get ordered list of all class names."""
        return self._all_names
    
    @property
    def num_classes(self):
        """Get total number of classes."""
        return len(self._all_names)
    
    @property
    def cat2id(self):
        """Get category name to ID mapping (0-indexed)."""
        return self._name_to_idx
    
    # ==================== Name/Index Conversion ====================
    
    def name_to_index(self, name):
        """
        Convert class name to index (0-indexed).
        
        Args:
            name: Class name
            
        Returns:
            int: Index of the class, or -1 if not found
        """
        return self._name_to_idx.get(name, -1)
    
    def index_to_name(self, index):
        """
        Convert index to class name (0-indexed).
        
        Args:
            index: Class index
            
        Returns:
            str: Class name, or None if index out of range
        """
        if 0 <= index < len(self._all_names):
            return self._all_names[index]
        return None
    
    def is_class_in_group(self, cls_id, group_key):
        """
        Check if a class ID belongs to a specific group.
        
        Args:
            cls_id: Class ID (0-indexed)
            group_key: Group key
            
        Returns:
            bool: True if class belongs to the group
        """
        start_idx = self.get_group_start_idx(group_key)
        if start_idx is None:
            return False
        count = self.get_group_count(group_key)
        return start_idx <= cls_id < start_idx + count
    
    def get_class_group_index(self, cls_id, group_key):
        """
        Get the index of a class within its group.
        
        Args:
            cls_id: Class ID (0-indexed)
            group_key: Group key
            
        Returns:
            int: Index within the group, or -1 if not in group
        """
        if not self.is_class_in_group(cls_id, group_key):
            return -1
        start_idx = self.get_group_start_idx(group_key)
        return cls_id - start_idx
    
    # ==================== Magic Methods ====================
    
    def __len__(self):
        """Return total number of classes."""
        return len(self._all_names)
    
    def __contains__(self, name):
        """Check if a class name exists."""
        return name in self._name_to_idx
    
    def __iter__(self):
        """Iterate over all class names."""
        return iter(self._all_names)
    
    def __getitem__(self, key):
        """
        Get group names by key, or class name by index.
        
        Args:
            key: Group key (str) or index (int)
            
        Returns:
            list or str: Group names if key is str, class name if key is int
        """
        if isinstance(key, str):
            return self.get_group_names(key)
        elif isinstance(key, int):
            return self.index_to_name(key)
        raise TypeError(f"Invalid key type: {type(key)}")
    
    def __repr__(self):
        group_info = ", ".join(f"{k or 'default'}:{len(v)}" for k, v in self._label_dict.items())
        return f"Labels({group_info})"
