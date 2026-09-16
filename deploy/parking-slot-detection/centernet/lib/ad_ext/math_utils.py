
import math
import numpy as np

def cosOfLines(line1, line2):
  vec1 = [line1[0][0] - line1[1][0], line1[0][1] - line1[1][1]] 
  vec2 = [line2[0][0] - line2[1][0], line2[0][1] - line2[1][1]] 
  vec1 = np.array(vec1, dtype=np.float64)
  vec2 = np.array(vec2, dtype=np.float64)
  cos_sim = np.dot(vec1, vec2)/(np.linalg.norm(vec1)*np.linalg.norm(vec2))
  #print ("cosOfLines", line1, line2, vec1, vec2, cos_sim)
  return cos_sim


def linesAlign(line1, line2, angle_thresh):
    cos_thresh = math.cos(math.radians(angle_thresh))
    cos_value = cosOfLines(line1, line2)
    return cos_value > cos_thresh

def linesPerpendicular(line1, line2, angle_thresh):
    cos_thresh = math.cos(math.pi/2 - math.radians(angle_thresh))
    cos_value = cosOfLines(line1, line2)
    return abs(cos_value) < cos_thresh


def calculate_angle(p1, p2, p3):
    # angles at p2

    v1 = p1 - p2
    v2 = p3 - p2
    
    dot_product = np.dot(v1, v2)
    norm_v1 = np.linalg.norm(v1)
    norm_v2 = np.linalg.norm(v2)
    
    cos_theta = dot_product / (norm_v1 * norm_v2)
    
    # clip for floating errs
    cos_theta = np.clip(cos_theta, -1, 1)
    
    angle = np.arccos(cos_theta) 
    
    return math.degrees(angle)
    