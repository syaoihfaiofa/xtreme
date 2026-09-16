
import sys, os
import re
from datetime import datetime

from ad_ext import Utils

class ConfigSelector():
    def __init__(self, default_path=None):
        #exe_dir = os.path.dirname(sys.argv[0])
        if default_path is None:
            rel_dir_path = 'ad_ext/default_configs'
            cwd_path = os.getcwd()
            cmd_file_path = os.path.dirname(os.path.abspath(sys.argv[0]))
            if os.path.isdir(os.path.join(cwd_path, rel_dir_path)):
                default_path = os.path.join(cwd_path, rel_dir_path)
            elif os.path.isdir(os.path.join(cmd_file_path, rel_dir_path)):
                default_path = os.path.join(cmd_file_path, rel_dir_path)
            else:
                raise ValueError("No default_configs path found")

        self.default_configs_dir = default_path

        list_file = os.path.join(self.default_configs_dir, "list.txt")

        self.list_dict = self.LoadListTxt(list_file)

        level1_dirs = [f for f in os.listdir(self.default_configs_dir) if os.path.isdir(os.path.join(self.default_configs_dir, f))]
    
        self.config_dirs = []
        for dir in level1_dirs:
            sub_dirs = [os.path.join(dir,f) for f in os.listdir(os.path.join(self.default_configs_dir, dir)) \
                        if os.path.isdir(os.path.join(self.default_configs_dir, dir, f)) and f != '.' and f != '..']
            if len(sub_dirs) > 0:
                self.config_dirs.extend(sub_dirs)
            else:
                print ('check', dir)
                raise ValueError("Should have a date time folder for every config")

        #print("====init config_dirs", self.config_dirs)

    def LoadListTxt(self, list_file):
        if not os.path.isfile(list_file):
            raise ValueError("cannot load list file " + list_file)

        all_list_dict = {}
        self.all_car_list_dict = {}
        with open(list_file, 'r', encoding='utf-8') as file:
            lines = file.readlines()
            for line in lines:
                line = line.strip()
                #print(line)
                if line and len(line) > 3:
                    line_tokens = re.split(r'\s+', line) # split by spaces or tabs
                    if len(line_tokens) > 2 and not line_tokens[0].startswith('===') and not line_tokens[0].startswith('#'):
                        all_list_dict[line_tokens[0]] = line_tokens[1:]
                        self.all_car_list_dict[line_tokens[0]] = line_tokens[2]
        
        return all_list_dict

    
    def GetConfigDir(self, file_or_folder_name):
        
        file_or_folder_name = os.path.basename(os.path.normpath(file_or_folder_name))
        
        filename, fileext = os.path.splitext(file_or_folder_name)
        if fileext is None or len(fileext) == 0:
            folder_name = file_or_folder_name
        else:
            folder_name = Utils.FoldernameFromFilename(filename)
        
        pattern = re.compile('[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}')
        match_result = pattern.search(folder_name)
        if not match_result:
            return None

        folder_name = match_result.group(0)
        if not folder_name in self.list_dict:
            #print('folder not in list.txt', folder_name)
            return None

        date_time = datetime.strptime(folder_name, '%Y-%m-%d-%H-%M-%S')

        car_name = self.list_dict[folder_name][1]
        
        for conf_dir in self.config_dirs:
            strs = conf_dir.split(os.path.sep)
            conf_car_name = strs[0]
            conf_datetime = None
            assert len(strs) > 1
            dt_strs = strs[1].split('_')
            dt_begin_str = '_'.join(dt_strs[0:2])
            dt_end_str = '_'.join(dt_strs[2:4])
            conf_begin_datetime = datetime.strptime(dt_begin_str, '%Y%m%d_%H%M%S')
            conf_end_datetime = datetime.strptime(dt_end_str, '%Y%m%d_%H%M%S')
            conf_datetime = [conf_begin_datetime, conf_end_datetime]
            if conf_car_name == car_name:
                if date_time >= conf_datetime[0] and date_time <= conf_datetime[1]:
                    return os.path.join(self.default_configs_dir, conf_dir)

        return None

    def GetAllConfigDirs(self):
        conf_dirs = [os.path.join(self.default_configs_dir, x) for x in self.config_dirs]
        return conf_dirs

    def GetDefaultConfigDir(self, car_name='BYD_QinPro_white'):
        """Fallback config when list.txt has no matching date index."""
        catch_all_suffix = '19800101_000000_20990101_000000'
        for conf_dir in self.config_dirs:
            strs = conf_dir.split(os.path.sep)
            if len(strs) < 2 or strs[0] != car_name:
                continue
            if strs[1] == catch_all_suffix:
                return os.path.join(self.default_configs_dir, conf_dir)

        best_dir = None
        best_end = None
        for conf_dir in self.config_dirs:
            strs = conf_dir.split(os.path.sep)
            if len(strs) < 2 or strs[0] != car_name:
                continue
            dt_strs = strs[1].split('_')
            if len(dt_strs) < 4:
                continue
            dt_end_str = '_'.join(dt_strs[2:4])
            conf_end_datetime = datetime.strptime(dt_end_str, '%Y%m%d_%H%M%S')
            if best_end is None or conf_end_datetime > best_end:
                best_dir = os.path.join(self.default_configs_dir, conf_dir)
                best_end = conf_end_datetime
        return best_dir


def parseConfig(src_path):
    
    loader = ConfigSelector("../labelImg/ad_ext/default_configs")
    # allConfigList = loader.LoadListTxt("../labelImg/ad_ext/default_configs/list.txt")

    def name2date(filename):
        return filename[0][:4]+'-'+filename[0][4:6]+'-'+filename[0][6:]+'-'+filename[1][:2]+'-'+filename[1][2:4]+'-'+filename[1][4:]

    filename = src_path.split("/")[-1].split(".")[0].split("_")[:2]
    key_name = filename[0]+filename[1]
    key_name = name2date(filename)
    date_time = datetime.strptime(key_name, '%Y-%m-%d-%H-%M-%S')
    # print(date_time)

    carConfigName = loader.all_car_list_dict[key_name]
    Datestamp = os.listdir(os.path.join("../labelImg/ad_ext/default_configs", carConfigName))
    for date in Datestamp:
        if '.' not in date:
            start_date = name2date(date.split("_")[:2])
            end_date = name2date(date.split("_")[-2:])
            start_date = datetime.strptime(start_date, '%Y-%m-%d-%H-%M-%S')
            end_date = datetime.strptime(end_date, '%Y-%m-%d-%H-%M-%S')
            if date_time >= start_date and date_time <= end_date:
                break
    
    return carConfigName, date