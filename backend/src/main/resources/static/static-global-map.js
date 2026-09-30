(function () {
  'use strict';
  var sceneId = document.body.getAttribute('data-scene-id');
  var svg = document.getElementById('map'), layer = document.getElementById('layer'), info = document.getElementById('info');
  var legend = document.getElementById('legend'), summary = document.getElementById('summary'), searchInput = document.getElementById('search');
  var trackSelect = document.getElementById('trackSelect'), resetButton = document.getElementById('reset'), clearButton = document.getElementById('clear'), exportButton = document.getElementById('exportHtml');
  var speedUnit = document.getElementById('speedUnit'), poses = [], boxes = [], poseSeries = [];
  var viewBox = [0, 0, 100, 100], initialViewBox = viewBox.slice(), dragging = false, start = null;

  function value(value) { return typeof value === 'number' && isFinite(value); }
  function text(value) { return value === null || value === undefined ? '' : String(value); }
  function color(name) { var hash = 0, str = text(name), index; for (index = 0; index < str.length; index++) hash = (hash * 31 + str.charCodeAt(index)) % 360; return 'hsl(' + hash + ',75%,55%)'; }
  function escapeHtml(value) { return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function corners(box) { var halfLength = box.length / 2, halfWidth = box.width / 2, cosine = Math.cos(box.yaw), sine = Math.sin(box.yaw); return [[-halfLength,-halfWidth],[halfLength,-halfWidth],[halfLength,halfWidth],[-halfLength,halfWidth]].map(function (point) { return [box.x + point[0] * cosine - point[1] * sine, box.y + point[0] * sine + point[1] * cosine]; }); }
  function mapBounds() { var xs = poses.map(function (p) { return p.x; }), ys = poses.map(function (p) { return p.y; }); boxes.forEach(function (box) { corners(box).forEach(function (point) { xs.push(point[0]); ys.push(point[1]); }); }); if (!xs.length) return [-10,-10,10,10]; return [Math.min.apply(null, xs)-10, Math.min.apply(null, ys)-10, Math.max.apply(null, xs)+10, Math.max.apply(null, ys)+10]; }
  function setViewBox() { svg.setAttribute('viewBox', viewBox.join(' ')); }
  function pointer(event) { var rect = svg.getBoundingClientRect(); return [viewBox[0] + (event.clientX - rect.left) / rect.width * viewBox[2], viewBox[1] + (event.clientY - rect.top) / rect.height * viewBox[3]]; }
  function renderMap() {
    var bounds = mapBounds(), minX = bounds[0], minY = bounds[1], maxX = bounds[2], maxY = bounds[3], scale = 8;
    var width = Math.max((maxX - minX) * scale, 640), height = Math.max((maxY - minY) * scale, 480), html = '';
    function x(worldX) { return (worldX - minX) * scale; } function y(worldY) { return (maxY - worldY) * scale; }
    viewBox = [0, 0, width, height]; initialViewBox = viewBox.slice(); setViewBox();
    html += '<polyline class="trajectory" points="' + poses.map(function (p) { return x(p.x) + ',' + y(p.y); }).join(' ') + '"/>';
    boxes.forEach(function (box, index) { var className = box.className || box.classId || 'Unknown', boxColor = color(className); var points = corners(box).map(function (point) { return x(point[0]) + ',' + y(point[1]); }).join(' '); var dataText = escapeHtml(className + ' ' + text(box.trackId) + ' ' + text(box.frame)); html += '<polygon class="box" data-index="' + index + '" data-text="' + dataText + '" points="' + points + '" fill="' + boxColor + '" fill-opacity=".16" stroke="' + boxColor + '" stroke-width="1.5"></polygon><text class="label" data-index="' + index + '" data-text="' + dataText + '" x="' + x(box.x) + '" y="' + y(box.y) + '" font-size="10" fill="' + boxColor + '">' + escapeHtml(className + ' | ' + (box.trackName || box.trackId)) + '</text>'; });
    layer.innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.box'), function (element) { element.onclick = function () { showBox(boxes[Number(element.getAttribute('data-index'))]); }; });
    document.getElementById('frameCount').textContent = poses.length; document.getElementById('boxCount').textContent = boxes.length;
    renderLegend(); renderSummary();
  }
  function showBox(box) { info.textContent = Object.keys(box).map(function (key) { var item = box[key]; return key + ': ' + (typeof item === 'number' ? item.toFixed(3) : text(item)); }).join('\n'); }
  function selectTrack(trackId) {
    var selectedElements = [];
    Array.prototype.forEach.call(document.querySelectorAll('.box,.label'), function (element) {
      var box = boxes[Number(element.getAttribute('data-index'))];
      var selected = !!trackId && box && box.trackId === trackId;
      element.classList.toggle('track-muted', !!trackId && !selected);
      element.classList.toggle('track-selected', selected);
      if (selected && element.classList.contains('box')) selectedElements.push(element);
    });
    if (!trackId || !selectedElements.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedElements.forEach(function (element) { var bounds = element.getBBox(); minX = Math.min(minX, bounds.x); minY = Math.min(minY, bounds.y); maxX = Math.max(maxX, bounds.x + bounds.width); maxY = Math.max(maxY, bounds.y + bounds.height); });
    var width = Math.max(maxX - minX, 40), height = Math.max(maxY - minY, 40), padding = Math.max(width, height) * .25;
    viewBox = [minX - padding, minY - padding, width + padding * 2, height + padding * 2];
    setViewBox();
    showBox(boxes.filter(function (box) { return box.trackId === trackId; })[0]);
  }
  function renderLegend() { var counts = {}; boxes.forEach(function (box) { var name = box.className || box.classId || 'Unknown'; counts[name] = (counts[name] || 0) + 1; }); legend.innerHTML = Object.keys(counts).sort().map(function (name) { return '<div class="legend-item"><span class="swatch" style="background:' + color(name) + '"></span><span>' + escapeHtml(name) + '</span><strong>' + counts[name] + '</strong></div>'; }).join(''); }
  function renderSummary() { var grouped = {}, rows; boxes.forEach(function (box) { (grouped[box.trackId] || (grouped[box.trackId] = [])).push(box); }); rows = Object.keys(grouped).map(function (trackId) { var items = grouped[trackId], drift = Math.max.apply(null, items.map(function (box) { return box.drift || 0; })); return [trackId, items.length, drift, items[0].className || items[0].classId || '-']; }).sort(function (a,b) { return b[2]-a[2]; }); trackSelect.innerHTML = '<option value="">选择漂移 track</option>' + rows.map(function (row) { return '<option value="' + escapeHtml(row[0]) + '">' + escapeHtml(row[0]) + ' | ' + row[2].toFixed(2) + 'm</option>'; }).join(''); summary.innerHTML = rows.map(function (row) { var state = row[2] >= 1 ? 'bad' : (row[2] >= .3 ? 'warn' : ''); return '<tr><td>' + escapeHtml(row[3]) + '</td><td>' + escapeHtml(row[0]) + '</td><td>' + row[1] + '</td><td class="' + state + '">' + row[2].toFixed(3) + ' m</td></tr>'; }).join(''); }
  function unwrap(field) { ['original','effective'].forEach(function (key) { var last = null; poseSeries.forEach(function (row) { var pose = row[key], current = pose && pose[field]; if (!value(current)) return; if (last !== null) { while (current-last > Math.PI) current -= 2*Math.PI; while (current-last < -Math.PI) current += 2*Math.PI; } row[key + '_' + field] = current; last = current; }); }); }
  function chartLine(label, colorName, getter, old) { return {label:label, color:colorName, get:getter, old:old}; }
  function drawChart(canvasId, legendId, lines) {
    var canvas = document.getElementById(canvasId), rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(320, rect.width), height = Math.max(180, rect.height), context, values = [], times = [];
    canvas.width = width * ratio; canvas.height = height * ratio; context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0,0,width,height);
    poseSeries.forEach(function (row) { if (value(row.t)) times.push(row.t); lines.forEach(function (line) { var item = line.get(row); if (value(item)) values.push(item); }); });
    if (!times.length || !values.length) { context.fillStyle='#64748b'; context.font='13px Arial'; context.fillText('没有可绘制的 location 数据',52,34); return; }
    var left=52,right=14,top=14,bottom=30, innerWidth=width-left-right, innerHeight=height-top-bottom, x0=Math.min.apply(null,times), x1=Math.max.apply(null,times), y0=Math.min.apply(null,values), y1=Math.max.apply(null,values), padding;
    if (x0 === x1) { x0 -= .5; x1 += .5; } if (y0 === y1) { y0 -= .5; y1 += .5; } padding=(y1-y0)*.08; y0-=padding; y1+=padding;
    function x(input) { return left+(input-x0)/(x1-x0)*innerWidth; } function y(input) { return top+(y1-input)/(y1-y0)*innerHeight; }
    context.font='11px Arial'; context.strokeStyle='#e2e8f0'; context.fillStyle='#64748b'; context.lineWidth=1;
    for(var index=0;index<=4;index++){var gridY=top+index*innerHeight/4, gridValue=y1-(y1-y0)*index/4;context.beginPath();context.moveTo(left,gridY);context.lineTo(left+innerWidth,gridY);context.stroke();context.fillText(gridValue.toFixed(3),2,gridY+4);}
    context.fillText(x0.toFixed(2),left,top+innerHeight+20);context.fillText('相对时间 t (s)',left+innerWidth/2-34,top+innerHeight+20);context.fillText(x1.toFixed(2),left+innerWidth-32,top+innerHeight+20);
    context.fillStyle='rgba(245,158,11,.12)';poseSeries.forEach(function(row){if(row.corrected&&value(row.t))context.fillRect(x(row.t)-2,top,4,innerHeight);});
    lines.forEach(function (line) { var started=false;context.beginPath();context.strokeStyle=line.color;context.globalAlpha=line.old ? 0.48 : 1;context.setLineDash(line.old ? [6,4] : []);context.lineWidth=line.old ? 1.4 : 2;poseSeries.forEach(function(row){var item=line.get(row);if(!value(row.t)||!value(item)){started=false;return;}if(!started){context.moveTo(x(row.t),y(item));started=true;}else context.lineTo(x(row.t),y(item));});context.stroke();context.globalAlpha=1;context.setLineDash([]); });
    lines.forEach(function(line){if(line.old)return;context.fillStyle=line.color;poseSeries.forEach(function(row){var item=line.get(row);if(row.corrected&&value(row.t)&&value(item)){context.beginPath();context.arc(x(row.t),y(item),3,0,Math.PI*2);context.fill();}});});
    document.getElementById(legendId).innerHTML=lines.map(function(line){return '<span class="'+(line.old?'old':'')+'" style="color:'+line.color+'"><i></i>'+line.label+'</span>';}).join('');
  }
  function drawDelta(canvasId, field, colorName, unwrapped) {
    var canvas=document.getElementById(canvasId),rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1,width=Math.max(220,rect.width),height=Math.max(42,rect.height),context,rows=[],maxAbs=0;
    canvas.width=width*ratio;canvas.height=height*ratio;context=canvas.getContext('2d');context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
    poseSeries.forEach(function(row){var original=unwrapped?row['original_'+field]:row.original&&row.original[field],effective=unwrapped?row['effective_'+field]:row.effective&&row.effective[field];if(value(row.t)&&value(original)&&value(effective)){var delta=effective-original;rows.push({t:row.t,delta:delta,corrected:row.corrected});maxAbs=Math.max(maxAbs,Math.abs(delta));}});
    if(!rows.length)return;maxAbs=Math.max(maxAbs,.0001);var left=38,right=8,top=3,bottom=18,innerWidth=width-left-right,innerHeight=height-top-bottom,x0=rows[0].t,x1=rows[rows.length-1].t;
    if(x0===x1){x0-=.5;x1+=.5;}function x(input){return left+(input-x0)/(x1-x0)*innerWidth;}function y(input){return top+(maxAbs-input)/(maxAbs*2)*innerHeight;}
    context.strokeStyle='#dbe3ee';context.lineWidth=1;context.beginPath();context.moveTo(left,y(0));context.lineTo(left+innerWidth,y(0));context.stroke();context.fillStyle='#94a3b8';context.font='9px Arial';context.fillText('±'+maxAbs.toFixed(3),1,10);
    context.fillStyle='rgba(245,158,11,.14)';rows.forEach(function(row){if(row.corrected)context.fillRect(x(row.t)-2,top,4,innerHeight);});context.beginPath();context.strokeStyle=colorName;context.lineWidth=1.6;rows.forEach(function(row,index){if(index===0)context.moveTo(x(row.t),y(row.delta));else context.lineTo(x(row.t),y(row.delta));});context.stroke();context.fillStyle=colorName;rows.forEach(function(row){if(row.corrected){context.beginPath();context.arc(x(row.t),y(row.delta),2.5,0,Math.PI*2);context.fill();}});context.fillStyle='#64748b';context.font='9px Arial';context.fillText(x0.toFixed(2),left,top+innerHeight+14);context.fillText('t (s)',left+innerWidth/2-9,top+innerHeight+14);context.fillText(x1.toFixed(2),left+innerWidth-26,top+innerHeight+14);
  }
  function drawPoseChart(canvasId, legendId, deltaId, field, title, colorName, unwrapped) {
    drawChart(canvasId, legendId, [
      chartLine('原始 ' + title, '#94a3b8', function(row) { return unwrapped ? row['original_' + field] : row.original && row.original[field]; }, true),
      chartLine('校正后 ' + title, colorName, function(row) { return unwrapped ? row['effective_' + field] : row.effective && row.effective[field]; })
    ]);
    drawDelta(deltaId, field, colorName, unwrapped);
  }
  function drawCharts() {
    unwrap('yaw'); unwrap('pitch'); unwrap('roll');
    drawPoseChart('xChart','xLegend','xDelta','x','X','#ef4444',false);
    drawPoseChart('yChart','yLegend','yDelta','y','Y','#2563eb',false);
    drawPoseChart('zChart','zLegend','zDelta','z','Z','#16a34a',false);
    drawPoseChart('yawChart','yawLegend','yawDelta','yaw','Yaw','#7c3aed',true);
    drawPoseChart('pitchChart','pitchLegend','pitchDelta','pitch','Pitch','#ea580c',true);
    drawPoseChart('rollChart','rollLegend','rollDelta','roll','Roll','#0891b2',true);
    speedUnit.textContent=poseSeries.length&&poseSeries[0].timeUnit==='s'?'单位：m/s':'缺少时间戳，单位：m / frame';
    drawChart('speedChart','speedLegend',[chartLine('原始速度','#94a3b8',function(r){return r.originalSpeed;},true),chartLine('校正后速度','#dc2626',function(r){return r.effectiveSpeed;})]);
  }
  function exportHtml() {
    var clone=document.documentElement.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('canvas'),function(canvas){var original=document.getElementById(canvas.id),image=document.createElement('img');image.src=original.toDataURL('image/png');image.alt=canvas.id;image.style.cssText='display:block;width:100%;height:auto';canvas.parentNode.replaceChild(image,canvas);});
    Array.prototype.forEach.call(clone.querySelectorAll('script'),function(script){script.parentNode.removeChild(script);});
    var exportControl=clone.querySelector('#exportHtml');if(exportControl)exportControl.parentNode.removeChild(exportControl);
    var blob=new Blob(['<!doctype html>\n'+clone.outerHTML],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download='static-global-map-'+sceneId+'.html';document.body.appendChild(anchor);anchor.click();document.body.removeChild(anchor);setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  svg.onwheel=function(event){event.preventDefault();var point=pointer(event),factor=event.deltaY < 0 ? 0.85 : 1.18;viewBox[0]=point[0]-(point[0]-viewBox[0])*factor;viewBox[1]=point[1]-(point[1]-viewBox[1])*factor;viewBox[2]*=factor;viewBox[3]*=factor;setViewBox();};svg.onmousedown=function(event){dragging=true;start=pointer(event);};window.onmouseup=function(){dragging=false;};window.onmousemove=function(event){if(!dragging)return;var point=pointer(event);viewBox[0]-=point[0]-start[0];viewBox[1]-=point[1]-start[1];setViewBox();};searchInput.oninput=function(){var query=searchInput.value.toLowerCase();Array.prototype.forEach.call(document.querySelectorAll('.box,.label'),function(element){element.classList.toggle('dimmed',!!query&&!element.getAttribute('data-text').toLowerCase().includes(query));});};trackSelect.onchange=function(){selectTrack(trackSelect.value);};resetButton.onclick=function(){viewBox=initialViewBox.slice();setViewBox();};clearButton.onclick=function(){searchInput.value='';trackSelect.value='';Array.prototype.forEach.call(document.querySelectorAll('.dimmed,.track-muted,.track-selected'),function(element){element.classList.remove('dimmed','track-muted','track-selected');});};exportButton.onclick=exportHtml;
  function load() { var request = new XMLHttpRequest(); request.open('GET','/api/data/staticGlobalMapData/'+encodeURIComponent(sceneId),true); request.setRequestHeader('Cache-Control','no-store'); request.onreadystatechange=function(){if(request.readyState!==4)return;if(request.status<200||request.status>=300){info.textContent='加载失败：' + request.status;return;}try{var payload=JSON.parse(request.responseText),data=payload.data||payload;poses=data.poses||[];boxes=data.boxes||[];poseSeries=data.poseSeries||[];renderMap();drawCharts();info.textContent='Location 数据已加载。点击 box 查看详情。';window.onresize=drawCharts;}catch(error){info.textContent='页面数据解析失败：' + error.message;}};request.send(); }
  load();
}());
