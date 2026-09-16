# Weizhe: use resize + conv to replace deconv

import torch
import torch.nn as nn

def scale_margin_from_deconv(kernel, stride, padding, output_padding):
    # ref: https://pytorch.org/docs/stable/generated/torch.nn.ConvTranspose2d.html
    # Hout and Wout formula

    if isinstance(kernel, int):
        kernel = (kernel, kernel)
    if isinstance(stride, int):
        stride = (stride, stride)
    if isinstance(padding, int):
        padding = (padding, padding)
    if isinstance(output_padding, int):
        output_padding = (output_padding, output_padding)

    scale = stride

    kAxis = 2
    margin = [0] * kAxis
    for i in range(kAxis):
        margin[i] = -stride[i] - 2*padding[i] + (kernel[i] - 1) + output_padding[i] + 1
    
    return scale, tuple(margin)

class NNInterp(nn.Module):
    def __init__(self, scale, mode):
        super(NNInterp, self).__init__()
        self.interp = nn.functional.interpolate
        self.scale = scale
        self.mode = mode
        
    def forward(self, x):
        x = self.interp(x, scale_factor=self.scale, mode=self.mode)
        return x

def deduce_padding_and_kernel(margin):
    # 2*p - (k-1) = m
    # 2*p = m + k - 1
    if isinstance(margin, int):
        margin = (margin)

    dim = len(margin)
    p = [-1] * dim
    k = [0] * dim
    for d in range(dim):
        p[d] = -1
        for i in range(1,6):
            k[d] = i
            x = margin[d] + k[d] - 1
            if x % 2 == 0:
                p[d] = x // 2
                break
        if p[d] < 0:
            print ('Input margin', margin)
            raise ValueError("Fail to deduce padding kernel")

    return p, k 


 