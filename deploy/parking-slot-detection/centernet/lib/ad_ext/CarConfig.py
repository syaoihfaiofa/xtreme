
import json


class CarConfig():
    def __init__(self):
        self.car_length = None
        self.car_width = None
        self.wheel_radius = None
        self.rear_overhang = None

    def LoadFromFile(self, json_file):
        with open(json_file) as f:
            jobj = json.loads(f.read())
            j_car = jobj['car_info']
            self.car_length = j_car['car_length']
            self.car_width = j_car['car_width']
            self.wheel_radius = j_car['wheel_radius']
            self.front_overhang = j_car['front_overhang']
            self.rear_overhang = j_car['rear_overhang']
            self.min_turn_radius = j_car['min_turn_radius']
            self.head_cut_width = j_car['head_cut_width']
            self.head_cut_height = j_car['head_cut_height']
            self.tail_cut_width = j_car['tail_cut_width']
            self.tail_cut_height = j_car['tail_cut_height']
            self.wheel_base = j_car['wheel_base']
            self.axle_base = j_car['axle_base']
            self.max_steering_wheel_angle = j_car['max_steering_wheel_angle']

            
