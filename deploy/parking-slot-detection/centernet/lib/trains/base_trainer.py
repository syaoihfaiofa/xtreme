from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

import time
import torch
from progress.bar import Bar
from models.data_parallel import DataParallel
from utils.utils import AverageMeter
from mtl.weight_methods import WeightMethods

if torch.__version__ >= '1.6.0':
    from torch.cuda.amp import autocast as autocast, GradScaler

class ModelWithLoss(torch.nn.Module):
  def __init__(self, model, loss, use_amp=False):
    super(ModelWithLoss, self).__init__()
    self.model = model
    self.loss = loss
    self.use_amp = use_amp
  
  def forward(self, batch):
    if self.use_amp:
      with autocast():
        outputs = self.model(batch['input'])
        loss, loss_stats, loss_groups = self.loss(outputs, batch)
    else: 
      outputs = self.model(batch['input'])
      loss, loss_stats, loss_groups = self.loss(outputs, batch)
    return outputs[-1], loss, loss_stats, loss_groups

class BaseTrainer(object):
  def __init__(
    self, opt, model, optimizer=None):
    self.opt = opt
    self.optimizer = optimizer
    self.loss_stats, self.loss, mtl_task_num = self._get_losses(opt)
    if self.opt.use_amp == True:
        self.scaler = GradScaler()
    self.model_with_loss = ModelWithLoss(model, self.loss,self.opt.use_amp)

    if opt.mtl:
      weight_methods_parameters = {
        'nashmtl': {
          'update_weights_every': 1,
          'optim_niter': 20
        },
        'famo': {
          'gamma': 0.01,
          'w_lr': 0.025,
          'max_norm': 1.0
        }
      }
      
      device_info = [torch.device("cuda:" + str(num)) for num in opt.gpus]
      self.weight_method = WeightMethods(
          opt.mtl, n_tasks=mtl_task_num, device=device_info, **weight_methods_parameters[opt.mtl]
      )
    

  def set_device(self, gpus, chunk_sizes, device):
    if len(gpus) > 1:
      self.model_with_loss = DataParallel(
        self.model_with_loss, device_ids=gpus, 
        chunk_sizes=chunk_sizes).to(device)
    else:
      self.model_with_loss = self.model_with_loss.to(device)
    
    for state in self.optimizer.state.values():
      for k, v in state.items():
        if isinstance(v, torch.Tensor):
          state[k] = v.to(device=device, non_blocking=True)

  def run_epoch(self, phase, epoch, data_loader):
    model_with_loss = self.model_with_loss
    if phase == 'train':
      model_with_loss.train()
    else:
      # if len(self.opt.gpus) > 1:
      #   model_with_loss = self.model_with_loss.module
      model_with_loss.eval()
      torch.cuda.empty_cache()

    opt = self.opt
    results = {}
    data_time, loss_time, backward_time = AverageMeter(), AverageMeter(), AverageMeter()
    avg_loss_stats = {l: AverageMeter() for l in self.loss_stats}
    if opt.mtl and phase == 'train':
      mtl_alpha_stats = {alpha_idx: AverageMeter() for alpha_idx in range(self.weight_method.method.n_tasks)}
    else:
      mtl_alpha_stats = {}

    num_iters = len(data_loader) if opt.num_iters < 0 else opt.num_iters
    # Only show progress bar on rank 0 to avoid duplicate outputs
    is_main_process = not hasattr(opt, 'local_rank') or opt.local_rank == 0
    bar = Bar('{}/{}'.format(opt.task, opt.exp_id), max=num_iters)
    end = time.time()
    for iter_id, batch in enumerate(data_loader):
      if iter_id >= num_iters:
        break
      data_time.update(time.time() - end)
      
      loss_start_time = time.time()

      for k in batch:
        if k != 'meta':
          batch[k] = batch[k].to(device=opt.device, non_blocking=True)    
      output, loss, loss_stats, loss_groups = model_with_loss(batch)
      loss = loss.mean()
      if isinstance(model_with_loss.model, torch.nn.parallel.DistributedDataParallel):
        torch.distributed.barrier()

      loss_time.update(time.time() - loss_start_time)

      backward_start_time = time.time()
 
      mtl_info = ''
      if phase == 'train':
        if opt.use_amp:
          self.optimizer.zero_grad()
          self.scaler.scale(loss).backward()
          self.scaler.step(self.optimizer)
          self.scaler.update()  
        else:
          self.optimizer.zero_grad()

          if opt.mtl:
            losses = torch.stack(loss_groups)
            params_wrapper = model_with_loss.model.module if isinstance(model_with_loss.model, torch.nn.parallel.DistributedDataParallel) else model_with_loss.model
            loss, extra_outputs = self.weight_method.backward(
                losses=losses,
                shared_parameters=list(params_wrapper.shared_parameters())
            )

            #print('MTL', opt.local_rank, 'alpha', )
            mtl_info += 'MTL rank' + str(opt.local_rank) + ' '
            if 'weights' in extra_outputs:
              for alpha_idx, alpha in enumerate(extra_outputs['weights']):
                alpha = alpha.item()
                mtl_info += '{:.6f} '.format(alpha)
                mtl_alpha_stats[alpha_idx].update(alpha)
          else:
            loss.backward()

          self.optimizer.step()

          if opt.mtl == "famo":
              with torch.no_grad():
                  _, _, _, new_loss_groups = model_with_loss(batch)
                  new_losses = torch.stack(new_loss_groups)
                  self.weight_method.method.update(new_losses.detach())
          
      
      backward_time.update(time.time() - backward_start_time)

      Bar.suffix = '{phase}: [{0}][{1}/{2}]|Tot {total:} ETA {eta:} |'.format(
        epoch, iter_id, num_iters, phase=phase,
        total=bar.elapsed_td, eta=bar.eta_td)
      for l in avg_loss_stats:
        avg_loss_stats[l].update(
          loss_stats[l].mean().item(), batch['input'].size(0))
        Bar.suffix = Bar.suffix + '{} {:.4f} '.format(l, avg_loss_stats[l].avg)

      if len(mtl_info) > 0:
        Bar.suffix = Bar.suffix + '|' + mtl_info
      if not opt.hide_data_time:
        Bar.suffix = Bar.suffix + '|Data {dt.val:.3f}s Loss {lt.val:.3f}s Backward {bt.val:.3f}s'.format(
          dt=data_time, lt=loss_time, bt=backward_time)
      if is_main_process:
        if opt.print_iter > 0:
          if iter_id % opt.print_iter == 0:
            print('{}/{}| {}'.format(opt.task, opt.exp_id, Bar.suffix)) 
        else:
          bar.next()
      
      if opt.debug > 0:
        self.debug(batch, output, iter_id)
      
      if opt.test:
        self.save_result(output, batch, results)
      del output, loss, loss_stats

      end = time.time()
    
    if is_main_process:
      bar.finish()
    ret = {k: v.avg for k, v in avg_loss_stats.items()}
    for alpha_idx, alpha_stats in mtl_alpha_stats.items():
      ret['mtl_alpha'+str(alpha_idx)] = alpha_stats.avg
    ret['time'] = bar.elapsed_td.total_seconds() / 60.
    return ret, results
  
  def debug(self, batch, output, iter_id):
    raise NotImplementedError

  def save_result(self, output, batch, results):
    raise NotImplementedError

  def _get_losses(self, opt):
    raise NotImplementedError
  
  def val(self, epoch, data_loader):
    return self.run_epoch('val', epoch, data_loader)

  def train(self, epoch, data_loader):
    return self.run_epoch('train', epoch, data_loader)