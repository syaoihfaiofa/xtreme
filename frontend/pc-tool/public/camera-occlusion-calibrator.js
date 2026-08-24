(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.CameraOcclusionCalibrator = api;
    }
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    'use strict';

    const VIEW_COUNT = 4;

    function roundCoordinate(value) {
        return Math.round(value * 1000000) / 1000000;
    }

    function normalizeCanvasPoint(x, y, width, height) {
        if (width <= 0 || height <= 0) {
            throw new Error(`Invalid canvas size: width=${width}, height=${height}`);
        }
        return {
            x: roundCoordinate(Math.min(1, Math.max(0, x / width))),
            y: roundCoordinate(Math.min(1, Math.max(0, y / height))),
        };
    }

    function buildConfig(pointsByView) {
        const views = {};
        pointsByView.forEach(function (points, index) {
            if (points.length >= 3) {
                views[String(index)] = {
                    points: points.map(function (point) {
                        return { x: point.x, y: point.y };
                    }),
                };
            }
        });
        return { version: 1, views: views };
    }

    function init() {
        const container = document.getElementById('views');
        const message = document.getElementById('message');
        const output = document.getElementById('output');
        const viewStates = [];

        function setMessage(text, isError) {
            message.textContent = text;
            message.className = isError ? 'message error' : 'message success';
        }

        function getPixelScale(canvas) {
            const rect = canvas.getBoundingClientRect();
            return canvas.width / Math.max(rect.width, 1);
        }

        function tracePolygon(context, points, width, height) {
            context.beginPath();
            points.forEach(function (point, index) {
                const x = point.x * width;
                const y = point.y * height;
                if (index === 0) {
                    context.moveTo(x, y);
                } else {
                    context.lineTo(x, y);
                }
            });
            if (points.length >= 3) {
                context.closePath();
            }
        }

        function draw(state) {
            const context = state.canvas.getContext('2d');
            context.clearRect(0, 0, state.canvas.width, state.canvas.height);
            if (!state.image) {
                return;
            }
            context.imageSmoothingEnabled = true;
            context.drawImage(state.image, 0, 0, state.canvas.width, state.canvas.height);
            if (state.points.length === 0) {
                state.counter.textContent = '0 个点';
                return;
            }

            const pixelScale = getPixelScale(state.canvas);
            const lineWidth = Math.max(6, 5 * pixelScale);
            const haloWidth = lineWidth + 4 * pixelScale;
            const pointRadius = Math.max(7, 6 * pixelScale);

            context.save();
            context.lineJoin = 'round';
            context.lineCap = 'round';
            context.miterLimit = 2;
            tracePolygon(context, state.points, state.canvas.width, state.canvas.height);
            if (state.points.length >= 3) {
                context.fillStyle = 'rgba(255, 234, 0, 0.38)';
                context.fill();
            }
            context.strokeStyle = '#111827';
            context.lineWidth = haloWidth;
            context.stroke();
            context.strokeStyle = '#ffe600';
            context.lineWidth = lineWidth;
            context.stroke();

            state.points.forEach(function (point, index) {
                const x = point.x * state.canvas.width;
                const y = point.y * state.canvas.height;
                context.beginPath();
                context.fillStyle = '#111827';
                context.arc(x, y, pointRadius + 2 * pixelScale, 0, Math.PI * 2);
                context.fill();
                context.beginPath();
                context.fillStyle = index === 0 ? '#22c55e' : '#ffe600';
                context.arc(x, y, pointRadius, 0, Math.PI * 2);
                context.fill();
            });
            context.restore();
            state.counter.textContent = `${state.points.length} 个点`;
        }

        function createView(index) {
            const card = document.createElement('section');
            card.className = 'view-card';
            card.innerHTML = `
                <div class="view-header">
                    <strong>视角 ${index}</strong>
                    <span class="counter">0 个点</span>
                </div>
                <label class="file-pick">
                    <input type="file" accept="image/*" hidden>
                    <span>选择图片</span>
                </label>
                <div class="canvas-wrap">
                    <canvas title="点击添加多边形点"></canvas>
                    <div class="placeholder">点上方「选择图片」加载本地照片</div>
                </div>
                <div class="view-actions">
                    <button type="button" data-action="undo">撤销一点</button>
                    <button type="button" data-action="clear">清空</button>
                </div>
            `;
            container.appendChild(card);

            const state = {
                image: null,
                points: [],
                canvas: card.querySelector('canvas'),
                counter: card.querySelector('.counter'),
                placeholder: card.querySelector('.placeholder'),
            };
            viewStates.push(state);

            card.querySelector('input').addEventListener('change', function (event) {
                const file = event.target.files && event.target.files[0];
                if (!file) {
                    return;
                }
                const url = URL.createObjectURL(file);
                const image = new Image();
                image.onload = function () {
                    URL.revokeObjectURL(url);
                    state.image = image;
                    state.points = [];
                    state.canvas.width = image.naturalWidth;
                    state.canvas.height = image.naturalHeight;
                    state.placeholder.hidden = true;
                    draw(state);
                    setMessage(`视角 ${index} 图片已加载`, false);
                };
                image.onerror = function () {
                    URL.revokeObjectURL(url);
                    setMessage(`无法读取视角 ${index} 图片：${file.name}`, true);
                };
                image.src = url;
            });

            state.canvas.addEventListener('click', function (event) {
                if (!state.image) {
                    setMessage(`请先选择视角 ${index} 图片`, true);
                    return;
                }
                const rect = state.canvas.getBoundingClientRect();
                state.points.push(
                    normalizeCanvasPoint(
                        event.clientX - rect.left,
                        event.clientY - rect.top,
                        rect.width,
                        rect.height,
                    ),
                );
                draw(state);
            });

            card.querySelector('[data-action="undo"]').addEventListener('click', function () {
                state.points.pop();
                draw(state);
            });
            card.querySelector('[data-action="clear"]').addEventListener('click', function () {
                state.points = [];
                draw(state);
            });
        }

        for (let index = 0; index < VIEW_COUNT; index += 1) {
            createView(index);
        }

        window.addEventListener('resize', function () {
            viewStates.forEach(draw);
        });

        function getConfigJson() {
            const invalidViews = viewStates
                .map(function (state, index) {
                    return state.image && state.points.length >= 3 ? null : index;
                })
                .filter(function (index) {
                    return index !== null;
                });
            if (invalidViews.length > 0) {
                throw new Error(`以下视角未加载图片或少于 3 个点：${invalidViews.join(', ')}`);
            }
            return JSON.stringify(
                buildConfig(
                    viewStates.map(function (state) {
                        return state.points;
                    }),
                ),
                null,
                2,
            );
        }

        document.getElementById('download').addEventListener('click', function () {
            try {
                const json = getConfigJson();
                const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'camera-occlusion-masks.json';
                link.click();
                URL.revokeObjectURL(link.href);
                output.value = json;
                setMessage('JSON 已下载', false);
            } catch (error) {
                setMessage(error.message, true);
            }
        });

        document.getElementById('copy').addEventListener('click', async function () {
            try {
                const json = getConfigJson();
                await navigator.clipboard.writeText(json);
                output.value = json;
                setMessage('JSON 已复制到剪贴板', false);
            } catch (error) {
                setMessage(`复制失败：${error.message}`, true);
            }
        });
    }

    return {
        buildConfig: buildConfig,
        init: init,
        normalizeCanvasPoint: normalizeCanvasPoint,
    };
});
