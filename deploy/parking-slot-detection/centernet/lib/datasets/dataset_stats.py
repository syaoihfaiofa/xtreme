"""
Dataset statistics utility functions.
"""
from collections import defaultdict, Counter
import os
import xml.etree.ElementTree as ET
from . import labels


def collect_dataset_statistics(dataset, opt):
    """
    Collect statistics about the dataset.
    
    Args:
        dataset: Dataset instance (may be wrapped)
        opt: Options object
        
    Returns:
        dict: Statistics dictionary
    """
    # Unwrap dataset if it's wrapped (e.g., CBGSDataset)
    actual_dataset = dataset
    if hasattr(dataset, 'dataset'):
        actual_dataset = dataset.dataset
    
    stats = {
        'total_samples': len(actual_dataset),
        'standard_distribution': Counter(),
        'class_distribution': {
            'basic': Counter(),
            'corner': Counter(),
            'mask': Counter(),
            'undefined': Counter(),  # Classes not in labels file
        },
        'standard_class_distribution': defaultdict(lambda: {
            'basic': Counter(),
            'corner': Counter(),
            'mask': Counter(),
            'undefined': Counter(),
        }),
        'branch_distribution': {
            'has_basic': 0,
            'has_corner': 0,
            'has_mask': 0,
        },
        'standard_branch_distribution': defaultdict(lambda: {
            'has_basic': 0,
            'has_corner': 0,
            'has_mask': 0,
        }),
        'all_classes_in_data': Counter(),  # All classes found in XML files
    }
    
    # Get label groups
    label_obj = labels.Labels(opt.labels_file)
    basic_class_names = set(label_obj.get_group_names(""))
    corner_class_names = set(label_obj.get_group_names("corner"))
    mask_class_names = set(label_obj.get_group_names("mask"))
    
    # Parse XML files to collect statistics
    print("Collecting dataset statistics...")
    for idx in range(len(actual_dataset)):
        if (idx + 1) % 1000 == 0:
            print(f"  Processed {idx + 1}/{len(actual_dataset)} samples...")
        
        relative_path = actual_dataset.relative_paths[idx]
        xml_path = os.path.join(actual_dataset.anno_dir, relative_path + '.xml')
        
        if not os.path.exists(xml_path):
            continue
        
        try:
            ann_tree = ET.parse(xml_path)
            ann_root = ann_tree.getroot()
            standard = ann_root.findtext('meta/standard')
            
            if not standard:
                standard = 'unknown'
            
            stats['standard_distribution'][standard] += 1
            
            # Collect class distribution
            has_basic = False
            has_corner = False
            has_mask = False
            
            # Get all class names from labels file
            all_label_classes = basic_class_names | corner_class_names | mask_class_names
            
            for obj in ann_root.findall('object'):
                label = obj.findtext('name')
                if not label:
                    continue
                
                # Count all classes found in data
                stats['all_classes_in_data'][label] += 1
                
                # Classify by group
                if label in basic_class_names:
                    stats['class_distribution']['basic'][label] += 1
                    stats['standard_class_distribution'][standard]['basic'][label] += 1
                    has_basic = True
                elif label in corner_class_names:
                    stats['class_distribution']['corner'][label] += 1
                    stats['standard_class_distribution'][standard]['corner'][label] += 1
                    has_corner = True
                elif label in mask_class_names:
                    stats['class_distribution']['mask'][label] += 1
                    stats['standard_class_distribution'][standard]['mask'][label] += 1
                    has_mask = True
                elif label not in all_label_classes:
                    # Class found in data but not defined in labels file
                    stats['class_distribution']['undefined'][label] += 1
                    stats['standard_class_distribution'][standard]['undefined'][label] += 1
            
            # Update branch distribution
            if has_basic:
                stats['branch_distribution']['has_basic'] += 1
                stats['standard_branch_distribution'][standard]['has_basic'] += 1
            if has_corner:
                stats['branch_distribution']['has_corner'] += 1
                stats['standard_branch_distribution'][standard]['has_corner'] += 1
            if has_mask:
                stats['branch_distribution']['has_mask'] += 1
                stats['standard_branch_distribution'][standard]['has_mask'] += 1
                
        except Exception as e:
            print(f"  Warning: Failed to parse {xml_path}: {e}")
            continue
    
    return stats


def print_dataset_statistics(stats, opt):
    """
    Print dataset statistics in a readable format.
    
    Args:
        stats: Statistics dictionary from collect_dataset_statistics
        opt: Options object
    """
    print("\n" + "="*80)
    print("DATASET STATISTICS")
    print("="*80)
    
    print(f"\nTotal samples: {stats['total_samples']}")
    
    # Standard distribution
    print("\n--- Standard Distribution ---")
    for standard, count in sorted(stats['standard_distribution'].items(), key=lambda x: -x[1]):
        percentage = count / stats['total_samples'] * 100
        print(f"  {standard:20s}: {count:6d} ({percentage:5.2f}%)")
    
    # Branch distribution
    print("\n--- Branch Distribution (Overall) ---")
    print(f"  Has Basic Detection:   {stats['branch_distribution']['has_basic']:6d} ({stats['branch_distribution']['has_basic']/stats['total_samples']*100:5.2f}%)")
    print(f"  Has Corner Detection:   {stats['branch_distribution']['has_corner']:6d} ({stats['branch_distribution']['has_corner']/stats['total_samples']*100:5.2f}%)")
    print(f"  Has Mask Segmentation:  {stats['branch_distribution']['has_mask']:6d} ({stats['branch_distribution']['has_mask']/stats['total_samples']*100:5.2f}%)")
    
    # Standard branch distribution
    print("\n--- Branch Distribution by Standard ---")
    for standard in sorted(stats['standard_branch_distribution'].keys()):
        std_stats = stats['standard_branch_distribution'][standard]
        std_count = stats['standard_distribution'][standard]
        print(f"\n  {standard}:")
        print(f"    Has Basic:   {std_stats['has_basic']:6d} ({std_stats['has_basic']/std_count*100:5.2f}%)")
        print(f"    Has Corner:  {std_stats['has_corner']:6d} ({std_stats['has_corner']/std_count*100:5.2f}%)")
        print(f"    Has Mask:    {std_stats['has_mask']:6d} ({std_stats['has_mask']/std_count*100:5.2f}%)")
    
    # Class distribution
    print("\n--- Class Distribution (Top 20) ---")
    print("\n  Basic Detection Classes:")
    if stats['class_distribution']['basic']:
        for cls, count in stats['class_distribution']['basic'].most_common(20):
            print(f"    {cls:30s}: {count:6d}")
    else:
        print("    (none)")
    
    print("\n  Corner Detection Classes:")
    if stats['class_distribution']['corner']:
        for cls, count in stats['class_distribution']['corner'].most_common(20):
            print(f"    {cls:30s}: {count:6d}")
    else:
        print("    (none)")
    
    print("\n  Mask Segmentation Classes:")
    if stats['class_distribution']['mask']:
        for cls, count in stats['class_distribution']['mask'].most_common(20):
            print(f"    {cls:30s}: {count:6d}")
    else:
        print("    (none)")
    
    # Undefined classes (found in data but not in labels file)
    if stats['class_distribution']['undefined']:
        print("\n  Undefined Classes (found in data but not in labels file):")
        for cls, count in stats['class_distribution']['undefined'].most_common(20):
            print(f"    {cls:30s}: {count:6d}")
    
    # All classes found in data (summary)
    print("\n--- All Classes Found in Data (Summary) ---")
    print(f"  Total unique classes in data: {len(stats['all_classes_in_data'])}")
    print(f"  Classes defined in labels file: {len(stats['class_distribution']['basic']) + len(stats['class_distribution']['corner']) + len(stats['class_distribution']['mask'])}")
    if stats['class_distribution']['undefined']:
        print(f"  Classes NOT in labels file: {len(stats['class_distribution']['undefined'])}")
        print("\n  Top undefined classes:")
        for cls, count in stats['class_distribution']['undefined'].most_common(10):
            print(f"    {cls:30s}: {count:6d}")
    
    # Standard-class distribution (for major standards)
    print("\n--- Class Distribution by Standard (Top Standards) ---")
    top_standards = sorted(stats['standard_distribution'].items(), key=lambda x: -x[1])[:5]
    for standard, std_count in top_standards:
        print(f"\n  {standard} ({std_count} samples):")
        std_class_stats = stats['standard_class_distribution'][standard]
        
        if std_class_stats['basic']:
            print("    Basic Classes:")
            for cls, count in std_class_stats['basic'].most_common(10):
                print(f"      {cls:30s}: {count:6d}")
        
        if std_class_stats['corner']:
            print("    Corner Classes:")
            for cls, count in std_class_stats['corner'].most_common(10):
                print(f"      {cls:30s}: {count:6d}")
        
        if std_class_stats['mask']:
            print("    Mask Classes:")
            for cls, count in std_class_stats['mask'].most_common(10):
                print(f"      {cls:30s}: {count:6d}")
        
        if std_class_stats['undefined']:
            print("    Undefined Classes (not in labels file):")
            for cls, count in std_class_stats['undefined'].most_common(10):
                print(f"      {cls:30s}: {count:6d}")
    
    print("\n" + "="*80 + "\n")

