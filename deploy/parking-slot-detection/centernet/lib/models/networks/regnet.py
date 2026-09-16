
# from https://github.com/d-li14/regnet.pytorch/blob/master/regnet.py

import torch
import torch.nn as nn
import math
import itertools

try:
    from torch.hub import load_state_dict_from_url
except ImportError:
    from torch.utils.model_zoo import load_url as load_state_dict_from_url

from . import net_utils

__all__ = ['regnetx_002', 'regnetx_004', 'regnetx_006', 'regnetx_008', 'regnetx_016', 'regnetx_032',
           'regnetx_040', 'regnetx_064', 'regnetx_080', 'regnetx_120', 'regnetx_160', 'regnetx_320']

model_urls = {
    'regnetx_002': 'RegNetX-200M-5e5535e1.pth',
    'regnetx_004': 'RegNetX-400M-387b0d2d.pth',
    'regnetx_006': 'RegNetX-600M-e57c923e.pth',
    'regnetx_008': 'RegNetX-800M-bc49a0ee.pth',
    'regnetx_016': 'RegNetX-1.6G-dca58f53.pth',
    'regnetx_032': '',
    'regnetx_040': None,
    'regnetx_064': None,
}


params = {
    'regnetx_002': ([1, 1, 4, 7], [24, 56, 152, 368], 8),
    'regnetx_004': ([1, 2, 7, 12], [32, 64, 160, 384], 16),
    'regnetx_006': ([1, 3, 5, 7], [48, 96, 240, 528], 24),
    'regnetx_008': ([1, 3, 7, 5], [64, 128, 288, 672], 16),
    'regnetx_016': ([2, 4, 10, 2], [72, 168, 408, 912], 24),
    'regnetx_032': ([2, 6, 15, 2], [96, 192, 432, 1008], 48),
    'regnetx_040': ([2, 5, 14, 2], [80, 240, 560, 1360], 40),
    'regnetx_064': ([2, 4, 10, 1], [168, 392, 784, 1624], 56),
}

BN_MOMENTUM = 0.1


# ============== UNet-ASPP Components ==============

class DWConv(nn.Module):
    """Depthwise separable convolution: DW Conv + PW Conv + BN + ReLU"""
    def __init__(self, in_ch, out_ch, kernel_size=3, stride=1, dilation=1, bias=False):
        super().__init__()
        padding = (kernel_size // 2) * dilation
        self.dwconv = nn.Conv2d(in_ch, in_ch, kernel_size, stride, padding, 
                                dilation=dilation, groups=in_ch, bias=False)
        self.pwconv = nn.Conv2d(in_ch, out_ch, 1, bias=bias)
        self.bn = nn.BatchNorm2d(out_ch, momentum=BN_MOMENTUM)
        self.relu = nn.ReLU(inplace=True)
    
    def forward(self, x):
        x = self.dwconv(x)
        x = self.pwconv(x)
        x = self.bn(x)
        x = self.relu(x)
        return x


class DWASPPLite(nn.Module):
    """Lightweight ASPP using depthwise separable convolutions (matching edgeai-torchvision)"""
    def __init__(self, in_ch, aspp_ch, out_ch, dilations=(6, 12, 18)):
        super().__init__()
        self.conv1x1 = nn.Sequential(
            nn.Conv2d(in_ch, aspp_ch, 1, bias=False),
            nn.BatchNorm2d(aspp_ch, momentum=BN_MOMENTUM),
            nn.ReLU(inplace=True)
        )
        self.aspp1 = DWConv(in_ch, aspp_ch, kernel_size=3, dilation=dilations[0])
        self.aspp2 = DWConv(in_ch, aspp_ch, kernel_size=3, dilation=dilations[1])
        self.aspp3 = DWConv(in_ch, aspp_ch, kernel_size=3, dilation=dilations[2])
        
        # Project concatenated features (dropout=0.2 matching edgeai)
        self.dropout = nn.Dropout2d(0.2, inplace=True)
        self.project = nn.Sequential(
            nn.Conv2d(aspp_ch * 4, out_ch, 1, bias=False),
            nn.BatchNorm2d(out_ch, momentum=BN_MOMENTUM),
            nn.ReLU(inplace=True)
        )
    
    def forward(self, x):
        x1 = self.conv1x1(x)
        x2 = self.aspp1(x)
        x3 = self.aspp2(x)
        x4 = self.aspp3(x)
        out = torch.cat([x1, x2, x3, x4], dim=1)
        out = self.dropout(out)
        return self.project(out)


class UNetASPPDecoder(nn.Module):
    """
    UNet-ASPP style segmentation decoder (matching edgeai-torchvision architecture).
    Uses ASPP for multi-scale context + UNet skip connections for better edges.
    
    Feature strides in RegNet:
      - x1 (layer1): stride 4
      - x2 (layer2): stride 8  
      - x3 (layer3): stride 16
      - x4 (layer4): stride 32
    
    Architecture:
      ASPP(x4) @ stride 32 -> up + skip(x3) @ stride 16 -> up + skip(x2) @ stride 8
      -> up + skip(x1) @ stride 4 -> 2x upsample to stride 1
    """
    def __init__(self, encoder_channels, shortcut_channels, num_classes, 
                 aspp_ch=256, decoder_ch=256, down_ratio=4):
        """
        Args:
            encoder_channels: channels of final encoder feature (e.g., 672 for regnetx_008)
            shortcut_channels: list of channels for skip connections [layer1, layer2, layer3, layer4]
            num_classes: number of segmentation classes (including background)
            aspp_ch: channels for ASPP branches (256 to match edgeai)
            decoder_ch: base decoder channels (256 to match edgeai)
            down_ratio: not used, kept for API compatibility
        """
        super().__init__()
        
        # Minimum channels for decoder stages (matching edgeai: max(output_channels*2, 32))
        min_ch = max(num_classes * 2, 32)
        
        # ASPP on encoder output (stride 32)
        # Use smaller dilations for Ambarella compatibility (max kernel 11x11)
        # dilation=2 -> 5x5, dilation=4 -> 9x9, dilation=5 -> 11x11
        self.aspp = DWASPPLite(encoder_channels, aspp_ch, decoder_ch, dilations=(2, 4, 5))
        
        # Stage 1: upsample to stride 16, fuse with layer3
        # After fuse: keep channels high for better feature learning
        stage1_out = max(decoder_ch // 2, min_ch)
        self.up1 = nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False)
        self.skip_conv1 = nn.Sequential(
            nn.Conv2d(shortcut_channels[2], stage1_out, 1, bias=False),
            nn.BatchNorm2d(stage1_out, momentum=BN_MOMENTUM),
            nn.ReLU(inplace=True)
        )
        self.fuse1 = DWConv(decoder_ch + stage1_out, stage1_out)
        
        # Stage 2: upsample to stride 8, fuse with layer2
        stage2_out = max(stage1_out // 2, min_ch)
        self.up2 = nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False)
        self.skip_conv2 = nn.Sequential(
            nn.Conv2d(shortcut_channels[1], stage2_out, 1, bias=False),
            nn.BatchNorm2d(stage2_out, momentum=BN_MOMENTUM),
            nn.ReLU(inplace=True)
        )
        self.fuse2 = DWConv(stage1_out + stage2_out, stage2_out)
        
        # Stage 3: upsample to stride 4, fuse with layer1
        stage3_out = max(stage2_out // 2, min_ch)
        self.up3 = nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False)
        self.skip_conv3 = nn.Sequential(
            nn.Conv2d(shortcut_channels[0], stage3_out, 1, bias=False),
            nn.BatchNorm2d(stage3_out, momentum=BN_MOMENTUM),
            nn.ReLU(inplace=True)
        )
        self.fuse3 = DWConv(stage2_out + stage3_out, stage3_out)
        
        # Final: 2 x 2x upsamples to reach stride 1 (input resolution)
        final_ch = stage3_out
        self.final_up = nn.Sequential(
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False),  # stride 4 -> 2
            DWConv(final_ch, final_ch),
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False),  # stride 2 -> 1
        )
        
        # Classification head
        self.head = nn.Conv2d(final_ch, num_classes, 1, bias=True)
    
    def forward(self, encoder_feat, skip_feats):
        """
        Args:
            encoder_feat: final encoder feature (from layer4, stride 32)
            skip_feats: [layer1_feat, layer2_feat, layer3_feat] for skip connections
        """
        # ASPP at stride 32
        x = self.aspp(encoder_feat)
        
        # Stage 1: stride 32 -> 16, fuse with layer3
        x = self.up1(x)
        s1 = self.skip_conv1(skip_feats[2])
        x = torch.cat([x, s1], dim=1)
        x = self.fuse1(x)
        
        # Stage 2: stride 16 -> 8, fuse with layer2
        x = self.up2(x)
        s2 = self.skip_conv2(skip_feats[1])
        x = torch.cat([x, s2], dim=1)
        x = self.fuse2(x)
        
        # Stage 3: stride 8 -> 4, fuse with layer1
        x = self.up3(x)
        s3 = self.skip_conv3(skip_feats[0])
        x = torch.cat([x, s3], dim=1)
        x = self.fuse3(x)
        
        # Final: stride 4 -> 1
        x = self.final_up(x)
        
        # Classification
        x = self.head(x)
        return x


def fill_fc_weights(layers):
    for m in layers.modules():
        if isinstance(m, nn.Conv2d):
            nn.init.normal_(m.weight, std=0.001)
            # torch.nn.init.kaiming_normal_(m.weight.data, nonlinearity='relu')
            # torch.nn.init.xavier_normal_(m.weight.data)
            if m.bias is not None:
                nn.init.constant_(m.bias, 0)

def conv3x3(in_planes, out_planes, stride=1, groups=1, dilation=1):
    """3x3 convolution with padding"""
    return nn.Conv2d(in_planes, out_planes, kernel_size=3, stride=stride,
                     padding=dilation, groups=groups, bias=False, dilation=dilation)


def conv1x1(in_planes, out_planes, stride=1):
    """1x1 convolution"""
    return nn.Conv2d(in_planes, out_planes, kernel_size=1, stride=stride, bias=False)


class Bottleneck(nn.Module):
    expansion = 1
    __constants__ = ['downsample']

    def __init__(self, inplanes, planes, stride=1, downsample=None, group_width=1,
                 dilation=1, norm_layer=None):
        super(Bottleneck, self).__init__()
        if norm_layer is None:
            norm_layer = nn.BatchNorm2d
        width = planes * self.expansion
        # Both self.conv2 and self.downsample layers downsample the input when stride != 1
        self.conv1 = conv1x1(inplanes, width)
        self.bn1 = norm_layer(width)
        self.conv2 = conv3x3(width, width, stride, width // min(width, group_width), dilation)
        self.bn2 = norm_layer(width)
        self.conv3 = conv1x1(width, planes)
        self.bn3 = norm_layer(planes)
        self.relu = nn.ReLU(inplace=True)
        self.downsample = downsample
        self.stride = stride

    def forward(self, x):
        identity = x

        out = self.conv1(x)
        out = self.bn1(out)
        out = self.relu(out)

        out = self.conv2(out)
        out = self.bn2(out)
        out = self.relu(out)

        out = self.conv3(out)
        out = self.bn3(out)

        if self.downsample is not None:
            identity = self.downsample(x)

        out += identity
        out = self.relu(out)

        return out


class RegNet(nn.Module):

    def __init__(self, heads, head_conv, deconv_type, block, layers, widths, group_width, num_classes=1000, zero_init_residual=True,
                 replace_stride_with_dilation=None,
                 norm_layer=None, down_ratio=4):
        super(RegNet, self).__init__()

        self.heads = heads
        self.deconv_with_bias = False
        self.down_ratio = down_ratio
        self.deconv_type = deconv_type
        self.shortcut_channels = widths  # Save for UNet skip connections


        if norm_layer is None:
            norm_layer = nn.BatchNorm2d
        self._norm_layer = norm_layer

        self.inplanes = 32
        self.dilation = 1
        if replace_stride_with_dilation is None:
            # each element in the tuple indicates if we should replace
            # the 2x2 stride with a dilated convolution instead
            replace_stride_with_dilation = [False, False, False, False]
        if len(replace_stride_with_dilation) != 4:
            raise ValueError("replace_stride_with_dilation should be None "
                             "or a 4-element tuple, got {}".format(replace_stride_with_dilation))
        self.group_width = group_width
        self.conv1 = nn.Conv2d(3, self.inplanes, kernel_size=3, stride=2, padding=1,
                               bias=False)
        self.bn1 = norm_layer(self.inplanes)
        self.relu = nn.ReLU(inplace=True)
        self.layer1 = self._make_layer(block, widths[0], layers[0], stride=2,
                                       dilate=replace_stride_with_dilation[0])
        self.layer2 = self._make_layer(block, widths[1], layers[1], stride=2,
                                       dilate=replace_stride_with_dilation[1])
        self.layer3 = self._make_layer(block, widths[2], layers[2], stride=2,
                                       dilate=replace_stride_with_dilation[2])
        self.layer4 = self._make_layer(block, widths[3], layers[3], stride=2,
                                       dilate=replace_stride_with_dilation[3])
        #self.avgpool = nn.AdaptiveAvgPool2d((1, 1))
        #self.fc = nn.Linear(widths[-1] * block.expansion, num_classes)


        # used for deconv layers.
        # there can be several configs:
        # 0. deconv [256, 128, 64] with groups=8
        # 1. deconv [64, 64, 64] with groups=1
        # 2. resize+conv [256, 128, 64] with groups=8
        
        if deconv_type == 1:
            self.deconv_layers = self._make_deconv_layer(
                3,
                [64, 64, 64],
                [4, 4, 4],
                groups=1
            )
        elif deconv_type == 2:
            self.deconv_layers = self._make_resize_conv_layer(
                3,
                [256, 128, 64],
                [4, 4, 4],
                groups=8
            )
        else:
            self.deconv_layers = self._make_deconv_layer(
                3,
                [256, 128, 64],
                [4, 4, 4],
                groups=8
            )

        self.has_seg_decoder = False  # Will be set True if seg head uses UNet-ASPP
        for head in self.heads:
            classes = self.heads[head]
            
            if head == 'seg':
                # UNet-ASPP decoder for segmentation - better edge quality
                # Uses skip connections from encoder layers + ASPP for multi-scale context
                # Channel sizes (256) match edgeai-torchvision for comparable quality
                seg_decoder = UNetASPPDecoder(
                    encoder_channels=widths[-1],  # Final encoder channel (e.g., 672 for regnetx_008)
                    shortcut_channels=widths,      # [layer1, layer2, layer3, layer4] channels
                    num_classes=classes,
                    aspp_ch=256,   # Match edgeai-torchvision
                    decoder_ch=256, # Match edgeai-torchvision
                    down_ratio=down_ratio
                )
                self.__setattr__(head, seg_decoder)
                self.has_seg_decoder = True
            elif head_conv > 0:
                fc = nn.Sequential(
                  nn.Conv2d(64, head_conv,
                    kernel_size=3, padding=1, bias=True),
                  nn.ReLU(inplace=True),
                  nn.Conv2d(head_conv, classes, 
                    kernel_size=1, stride=1, 
                    padding=0, bias=True))
                if 'hm' in head:
                    fc[-1].bias.data.fill_(-2.19)
                else:
                    fill_fc_weights(fc)
                self.__setattr__(head, fc)
            else:
                fc = nn.Conv2d(64, classes, 
                  kernel_size=1, stride=1, 
                  padding=0, bias=True)
                if 'hm' in head:
                    fc.bias.data.fill_(-2.19)
                else:
                    fill_fc_weights(fc)
                self.__setattr__(head, fc)


        for m in self.modules():
            if isinstance(m, nn.Conv2d):
                nn.init.kaiming_normal_(m.weight, mode='fan_out', nonlinearity='relu')
            elif isinstance(m, (nn.BatchNorm2d, nn.GroupNorm)):
                nn.init.constant_(m.weight, 1)
                nn.init.constant_(m.bias, 0)

        # weight initialization
        for m in self.modules():
            if isinstance(m, nn.Conv2d):
                nn.init.kaiming_normal_(m.weight, mode='fan_out')
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
            elif isinstance(m, nn.BatchNorm2d):
                nn.init.ones_(m.weight)
                nn.init.zeros_(m.bias)
            elif isinstance(m, nn.Linear):
                fan_out = m.weight.size(0)
                init_range = 1.0 / math.sqrt(fan_out)
                nn.init.uniform_(m.weight, -init_range, init_range)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)

        # Zero-initialize the last BN in each residual branch,
        # so that the residual branch starts with zeros, and each residual block behaves like an identity.
        # This improves the model by 0.2~0.3% according to https://arxiv.org/abs/1706.02677
        if zero_init_residual:
            for m in self.modules():
                if isinstance(m, Bottleneck):
                    nn.init.constant_(m.bn3.weight, 0)

    def _make_layer(self, block, planes, blocks, stride=1, dilate=False):
        norm_layer = self._norm_layer
        downsample = None
        previous_dilation = self.dilation
        if dilate:
            self.dilation *= stride
            stride = 1
        if stride != 1 or self.inplanes != planes:
            downsample = nn.Sequential(
                conv1x1(self.inplanes, planes, stride),
                norm_layer(planes),
            )

        layers = []
        layers.append(block(self.inplanes, planes, stride, downsample, self.group_width,
                            previous_dilation, norm_layer))
        self.inplanes = planes
        for _ in range(1, blocks):
            layers.append(block(self.inplanes, planes, group_width=self.group_width,
                                dilation=self.dilation,
                                norm_layer=norm_layer))

        return nn.Sequential(*layers)


    def _get_deconv_cfg(self, deconv_kernel, index):
        if deconv_kernel == 4:
            padding = 1
            output_padding = 0
        elif deconv_kernel == 3:
            padding = 1
            output_padding = 1
        elif deconv_kernel == 2:
            padding = 0
            output_padding = 0

        return deconv_kernel, padding, output_padding

    def _make_deconv_layer(self, num_layers, num_filters, num_kernels, groups):
        assert num_layers == len(num_filters), \
            'ERROR: num_deconv_layers is different len(num_deconv_filters)'
        assert num_layers == len(num_kernels), \
            'ERROR: num_deconv_layers is different len(num_deconv_filters)'

        layers = []
        for i in range(num_layers):
            kernel, padding, output_padding = \
                self._get_deconv_cfg(num_kernels[i], i)

            planes = num_filters[i]
            layers.append(
                nn.ConvTranspose2d(
                    in_channels=self.inplanes,
                    out_channels=planes,
                    kernel_size=kernel,
                    stride=2,
                    padding=padding,
                    output_padding=output_padding,
                    groups=groups,
                    bias=self.deconv_with_bias))
            #print("====deconv layer", layers[-1], 'out pad', output_padding)
            layers.append(nn.BatchNorm2d(planes, momentum=BN_MOMENTUM))
            layers.append(nn.ReLU(inplace=True))
            self.inplanes = planes

        return nn.Sequential(*layers)

    def _make_resize_conv_layer(self, num_layers, num_filters, num_kernels, groups):
        assert num_layers == len(num_filters), \
            'ERROR: num_layers is different from len(num_filters)'
        assert num_layers == len(num_kernels), \
            'ERROR: num_layers is different from len(num_kernels)'

        layers = []
        for i in range(num_layers):
            kernel, padding, output_padding = \
                self._get_deconv_cfg(num_kernels[i], i)

            scale, margin = net_utils.scale_margin_from_deconv(kernel, 2, padding, output_padding)

            layers.append(nn.Upsample(scale_factor=scale, mode='bilinear'))

            # ref: https://pytorch.org/docs/stable/generated/torch.nn.Conv2d.html
            # Hout and Wout
            # the purpose is to use Conv to make output same as scale*Size + margin (same as when use deconv)
            conv_padding, conv_kernel = net_utils.deduce_padding_and_kernel(margin)
            #print ("====deduce", conv_padding, conv_kernel)
            planes = num_filters[i]
            layers.append(
                nn.Conv2d(
                    in_channels=self.inplanes,
                    out_channels=planes,
                    kernel_size=conv_kernel,
                    padding=conv_padding,
                    groups=groups,
                    bias=self.deconv_with_bias))
            #print("====resize_conv layer", layers[-1])
            layers.append(nn.BatchNorm2d(planes, momentum=BN_MOMENTUM))
            layers.append(nn.ReLU(inplace=True))
            self.inplanes = planes

        return nn.Sequential(*layers)

    def _make_seg_decoder(self, in_channels, num_classes, down_ratio, deconv_type):
        """
        Efficient segmentation decoder:
          - Reduce channels as resolution increases (saves compute)
          - Use depthwise separable conv for efficiency
          - One refinement conv per upsample stage
        
        Architecture (for down_ratio=4):
          64@128 -> Upsample -> 32@256 -> Upsample -> 16@512 -> Head -> num_classes@512
        """
        import math
        num_upsample = int(math.log2(down_ratio))
        
        # Channel schedule: reduce by half at each upsample (min 16)
        channels = [in_channels]
        for i in range(num_upsample):
            channels.append(max(channels[-1] // 2, 16))
        
        layers = []
        
        for i in range(num_upsample):
            in_ch = channels[i]
            out_ch = channels[i + 1]
            
            # Upsample 2x with channel reduction
            if deconv_type == 2:
                layers.append(nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False))
                layers.append(nn.Conv2d(in_ch, out_ch, kernel_size=3, padding=1, bias=False))
            else:
                layers.append(nn.ConvTranspose2d(in_ch, out_ch, kernel_size=4, stride=2, padding=1, bias=False))
            layers.append(nn.BatchNorm2d(out_ch, momentum=BN_MOMENTUM))
            layers.append(nn.ReLU(inplace=True))
            
            # Depthwise separable conv for refinement (efficient)
            layers.append(nn.Conv2d(out_ch, out_ch, kernel_size=3, padding=1, groups=out_ch, bias=False))  # depthwise
            layers.append(nn.Conv2d(out_ch, out_ch, kernel_size=1, bias=False))  # pointwise
            layers.append(nn.BatchNorm2d(out_ch, momentum=BN_MOMENTUM))
            layers.append(nn.ReLU(inplace=True))
        
        # Final classification head
        layers.append(nn.Conv2d(channels[-1], num_classes, kernel_size=1, bias=True))
        
        return nn.Sequential(*layers)

    def _make_seg_decoder2(self, in_channels, num_classes, down_ratio, deconv_type):
        """
        Create a segmentation decoder that upsamples features to input resolution.
        Uses same deconv_type as backbone:
          0: deconv with groups=8
          1: deconv with groups=1
          2: resize+conv with groups=8
        
        For down_ratio=4: 2 upsample layers (each 2x)
        For down_ratio=2: 1 upsample layer (2x)
        """
        import math
        num_layers = int(math.log2(down_ratio))
        
        # Generate filter sizes: halve channels each layer, last layer is num_classes
        num_filters = []
        ch = in_channels
        for i in range(num_layers):
            ch = max(ch // 2, 32) if i < num_layers - 1 else num_classes
            num_filters.append(ch)
        
        num_kernels = [4] * num_layers
        
        # Choose groups based on deconv_type
        groups = 1 if deconv_type == 1 else 8
        
        # Build layers
        layers = []
        ch = in_channels
        for i in range(num_layers):
            kernel, padding, output_padding = self._get_deconv_cfg(num_kernels[i], i)
            planes = num_filters[i]
            
            if deconv_type == 2:
                # resize + conv
                scale, margin = net_utils.scale_margin_from_deconv(kernel, 2, padding, output_padding)
                layers.append(nn.Upsample(scale_factor=scale, mode='bilinear'))
                conv_padding, conv_kernel = net_utils.deduce_padding_and_kernel(margin)
                layers.append(nn.Conv2d(
                    in_channels=ch,
                    out_channels=planes,
                    kernel_size=conv_kernel,
                    padding=conv_padding,
                    groups=min(groups, ch, planes),  # groups must divide both ch and planes
                    bias=self.deconv_with_bias))
            else:
                # deconv
                layers.append(nn.ConvTranspose2d(
                    in_channels=ch,
                    out_channels=planes,
                    kernel_size=kernel,
                    stride=2,
                    padding=padding,
                    output_padding=output_padding,
                    groups=min(groups, ch, planes),
                    bias=self.deconv_with_bias))
            
            # Add BN and ReLU for all but last layer
            if i < num_layers - 1:
                layers.append(nn.BatchNorm2d(planes, momentum=BN_MOMENTUM))
                layers.append(nn.ReLU(inplace=True))
            
            ch = planes
        
        return nn.Sequential(*layers)

    # def _forward_impl(self, x):
        # See note [TorchScript super()]
        

    def forward(self, x):
        x = self.conv1(x)
        x = self.bn1(x)
        x = self.relu(x)

        # Save intermediate features for UNet skip connections
        x1 = self.layer1(x)
        x2 = self.layer2(x1)
        x3 = self.layer3(x2)
        x4 = self.layer4(x3)
        skip_feats = [x1, x2, x3, x4]  # For UNet decoder

        # x = self.avgpool(x)
        # x = torch.flatten(x, 1)
        # x = self.fc(x)

        x = self.deconv_layers(x4)
        ret = {}
        for head in self.heads:
            if head == 'seg' and hasattr(self, 'has_seg_decoder'):
                # UNet-ASPP decoder uses encoder features + skip connections
                ret[head] = self.__getattr__(head)(x4, skip_feats[:3])  # Pass layer1,2,3 as skips
            else:
                ret[head] = self.__getattr__(head)(x)
        return [ret]

    def shared_parameters(self):
        return itertools.chain(
            self.conv1.parameters(),
            self.bn1.parameters(),
            self.relu.parameters(),
            self.layer1.parameters(),
            self.layer2.parameters(),
            self.layer3.parameters(),
            self.layer4.parameters(),
            self.deconv_layers.parameters(),
        )


# def regnetx_002(**kwargs):
#     return RegNet(Bottleneck, [1, 1, 4, 7], [24, 56, 152, 368], group_width=8, **kwargs)


# def regnetx_004(**kwargs):
#     return RegNet(Bottleneck, [1, 2, 7, 12], [32, 64, 160, 384], group_width=16, **kwargs)


# def regnetx_006(**kwargs):
#     return RegNet(Bottleneck, [1, 3, 5, 7], [48, 96, 240, 528], group_width=24, **kwargs)


# def regnetx_008(**kwargs):
#     return RegNet(Bottleneck, [1, 3, 7, 5], [64, 128, 288, 672], group_width=16, **kwargs)


# def regnetx_016(**kwargs):
#     return RegNet(Bottleneck, [2, 4, 10, 2], [72, 168, 408, 912], group_width=24, **kwargs)


# def regnetx_032(**kwargs):
#     return RegNet(Bottleneck, [2, 6, 15, 2], [96, 192, 432, 1008], group_width=48, **kwargs)


# def regnetx_040(**kwargs):
#     return RegNet(Bottleneck, [2, 5, 14, 2], [80, 240, 560, 1360], group_width=40, **kwargs)


# def regnetx_064(**kwargs):
#     return RegNet(Bottleneck, [2, 4, 10, 1], [168, 392, 784, 1624], group_width=56, **kwargs)


# def regnetx_080(**kwargs):
#     return RegNet(Bottleneck, [2, 5, 15, 1], [80, 240, 720, 1920], group_width=120, **kwargs)


# def regnetx_120(**kwargs):
#     return RegNet(Bottleneck, [2, 5, 11, 1], [224, 448, 896, 2240], group_width=112, **kwargs)


# def regnetx_160(**kwargs):
#     return RegNet(Bottleneck, [2, 6, 13, 1], [256, 512, 896, 2048], group_width=128, **kwargs)


# def regnetx_320(**kwargs):
#     return RegNet(Bottleneck, [2, 7, 13, 1], [336, 672, 1344, 2520], group_width=168, **kwargs)



def _regnet(heads, head_conv, deconv_type, arch, pretrained, down_ratio=4, **kwargs):
    model = RegNet(heads, head_conv, deconv_type, Bottleneck, *params[arch], 
                   down_ratio=down_ratio, **kwargs)
    if pretrained:
        state_dict = load_state_dict_from_url(model_urls[arch], progress=True)

        model.load_state_dict(state_dict, strict=False)
    return model

# num_layers: 0, 1, .., which mapping to 400mf, 800mf, 1.6g ...
# heads['hm']: number of classes
# heads['wh']: ?
def get_regnet(num_layers, heads, head_conv=256, deconv_type=0, down_ratio=4):
    arch = 'regnetx_{0:03d}'.format(num_layers)
    print("....", heads)
    # Xtreme ships model_last.pth, which already contains the complete RegNet
    # state dictionary.  Downloading the optional backbone checkpoint here is
    # both unnecessary and invalid because this project's registry stores only
    # the checkpoint filename, not an HTTP URL.
    model = _regnet(heads, head_conv, deconv_type, arch, False, down_ratio=down_ratio)
    return model
