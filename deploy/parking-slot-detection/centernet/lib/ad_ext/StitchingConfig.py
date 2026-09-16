
import json

class StitchingOutParam():
    def __init__(self):
        self.pixels_per_meter = None
        self.car_origin_x = None
        self.car_origin_y = None
        self.blind_x = None
        self.blind_y = None
        self.blind_width = None
        self.blind_height = None
    
    def FromJson(self, jobj):
        self.pixels_per_meter = jobj['pixels_per_meter']
        self.width = jobj['width']
        self.height = jobj['height']
        self.car_origin_x = jobj['car_origin_x']
        self.car_origin_y = jobj['car_origin_y']
        self.blind_x = jobj["blind_x"]
        self.blind_y = jobj["blind_y"]
        self.blind_width = jobj["blind_width"]
        self.blind_height = jobj["blind_height"]

class StitchingConfig():
    def __init__(self):
        self.output_far = None
        self.output_near = None

    def LoadFromFile(self, json_file):
        with open(json_file) as f:
            jobj = json.loads(f.read())
            for j_out_name in jobj['output']:
                j_out = jobj['output'][j_out_name]
                if j_out_name == 'far_avm':
                    self.output_far = StitchingOutParam()
                    self.output_far.FromJson(j_out)
                elif j_out_name == 'near_avm':
                    self.output_near = StitchingOutParam()
                    self.output_near.FromJson(j_out)