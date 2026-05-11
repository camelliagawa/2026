'use strict';

// =====================================================================
// 状態管理
// =====================================================================
const state = {
  opencvReady: false,
  cameraActive: false,
  stream: null,
  facingMode: 'environment',     // 'environment'=背面 / 'user'=前面
  calibPixelsPerMm: null,        // px/mm
  calibrating: false,
  calibStart: null,              // {x, y} canvas座標
  calibEnd: null,                // {x, y} canvas座標
  manualMode: false,
  manualPoints: [],              // 手動計測点 [{x,y}, ...]
  history: [],
  autoDetectRunning: false,
  autoCalibRunning: false,
  animFrameId: null,
  pendingResult: null,
  params: {
    cannyLow: 50,
    cannyHigh: 150,
    minArea: 2000,
    showEdges: true,
    showContours: true,
  },
};

// =====================================================================
// DOM参照
// =====================================================================
const $ = id => document.getElementById(id);

const elems = {
  cameraSelect:       $('camera-select'),
  btnStartCamera:     $('btn-start-camera'),
  btnStopCamera:      $('btn-stop-camera'),
  btnFlipCamera:      $('btn-flip-camera'),
  refLength:          $('ref-length'),
  refType:            $('ref-type'),
  btnCalibrate:       $('btn-calibrate'),
  calibStatus:        $('calibration-status'),
  btnAutoDetect:      $('btn-auto-detect'),
  btnManualMeasure:   $('btn-manual-measure'),
  btnCapture:         $('btn-capture'),
  cannyLow:           $('canny-low'),
  cannyLowVal:        $('canny-low-val'),
  cannyHigh:          $('canny-high'),
  cannyHighVal:       $('canny-high-val'),
  minArea:            $('min-area'),
  minAreaVal:         $('min-area-val'),
  showEdges:          $('show-edges'),
  showContours:       $('show-contours'),
  btnSaveImage:       $('btn-save-image'),
  btnReset:           $('btn-reset'),
  video:              $('video'),
  overlayCanvas:      $('overlay-canvas'),
  processedCanvas:    $('processed-canvas'),
  resStatus:          $('res-status'),
  resBladeLength:     $('res-blade-length'),
  unitBladeLength:    $('unit-blade-length'),
  resTotalLength:     $('res-total-length'),
  unitTotalLength:    $('unit-total-length'),
  resBladeWidth:      $('res-blade-width'),
  unitBladeWidth:     $('unit-blade-width'),
  resBbox:            $('res-bbox'),
  unitBbox:           $('unit-bbox'),
  resAngle:           $('res-angle'),
  resCalib:           $('res-calib'),
  opencvStatus:       $('opencv-status'),
  btnAutoCalib:       $('btn-auto-calib'),
  annotatedCanvas:    $('annotated-canvas'),
  resultImageBox:     $('result-image-box'),
  historyBody:        $('history-body'),
  btnClearHistory:    $('btn-clear-history'),
  btnExportCsv:       $('btn-export-csv'),
  logOutput:          $('log-output'),
  detectionConfirm:   $('detection-confirm'),
  btnConfirmOk:       $('btn-confirm-ok'),
  btnConfirmRetry:    $('btn-confirm-retry'),
  confirmSummary:     $('confirm-summary'),
};

// =====================================================================
// ログ
// =====================================================================
function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-${type}`;
  const t = new Date().toLocaleTimeString('ja-JP');
  div.textContent = `[${t}] ${msg}`;
  elems.logOutput.prepend(div);
  if (elems.logOutput.children.length > 60) {
    elems.logOutput.removeChild(elems.logOutput.lastChild);
  }
}

// =====================================================================
// OpenCV 準備
// =====================================================================
window.onOpenCvReady = () => {
  state.opencvReady = true;
  log('OpenCV.js 読み込み完了', 'info');
  elems.opencvStatus.textContent = 'OpenCV 準備完了 ✓';
  elems.opencvStatus.className = 'opencv-status opencv-ready';
  if (state.cameraActive) {
    elems.btnAutoDetect.disabled = false;
    elems.btnCapture.disabled = false;
    elems.btnAutoCalib.disabled = false;
  }
  initCameraList();
};

window.onOpenCvError = () => {
  log('OpenCV.js 読み込み失敗。手動計測モードは引き続き使用できます。', 'warn');
  elems.opencvStatus.textContent = 'OpenCV 読み込み失敗（手動計測のみ使用可）';
  elems.opencvStatus.className = 'opencv-status opencv-error';
  initCameraList();
};

// =====================================================================
// カメラ一覧取得
// =====================================================================
async function initCameraList() {
  try {
    // カメラ許可取得のために一時ストリームを開く
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    tmp.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    elems.cameraSelect.innerHTML = '';
    videoDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `カメラ ${i + 1}`;
      elems.cameraSelect.appendChild(opt);
    });

    if (videoDevices.length === 0) {
      log('カメラが見つかりません', 'error');
    } else {
      log(`${videoDevices.length}台のカメラを検出`, 'info');
    }
  } catch (err) {
    log(`カメラアクセスエラー: ${err.message}`, 'error');
  }
}

// =====================================================================
// カメラ開始・停止
// =====================================================================
elems.btnStartCamera.addEventListener('click', startCamera);
elems.btnStopCamera.addEventListener('click', stopCamera);

async function startCamera() {
  const deviceId = elems.cameraSelect.value;

  // deviceId指定がある場合はそれを優先、なければfacingModeを使用
  let constraints = deviceId
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } } }
    : { video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 960 } } };

  try {
    if (state.stream) stopCameraStream();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_) {
      // 解像度指定で失敗した場合はシンプルな制約でリトライ
      log('高解像度で失敗。標準解像度で再試行します。', 'warn');
      const fallback = deviceId
        ? { video: { deviceId: { exact: deviceId } } }
        : { video: { facingMode: state.facingMode } };
      state.stream = await navigator.mediaDevices.getUserMedia(fallback);
    }

    elems.video.srcObject = state.stream;
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      elems.video.addEventListener('loadedmetadata', finish, { once: true });
      setTimeout(finish, 5000); // 5秒でタイムアウト
    });
    elems.video.play();

    resizeOverlayCanvas();
    state.cameraActive = true;
    elems.btnStartCamera.disabled = true;
    elems.btnStopCamera.disabled = false;
    elems.btnFlipCamera.disabled = false;
    elems.btnCalibrate.disabled = false;
    elems.btnManualMeasure.disabled = false;
    elems.btnAutoDetect.disabled = !state.opencvReady;
    elems.btnCapture.disabled = !state.opencvReady;
    elems.btnAutoCalib.disabled = !state.opencvReady;

    const facing = state.facingMode === 'environment' ? '背面' : '前面';
    log(`カメラ開始: ${elems.video.videoWidth}x${elems.video.videoHeight} (${deviceId ? 'デバイス指定' : facing})`, 'info');
  } catch (err) {
    log(`カメラ起動エラー: ${err.message}`, 'error');
  }
}

function stopCameraStream() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
}

function stopCamera() {
  stopAutoDetect();
  stopAutoCalib();
  stopCameraStream();
  elems.video.srcObject = null;
  state.cameraActive = false;
  elems.btnStartCamera.disabled = false;
  elems.btnStopCamera.disabled = true;
  elems.btnFlipCamera.disabled = true;
  elems.btnCalibrate.disabled = true;
  elems.btnAutoDetect.disabled = true;
  elems.btnManualMeasure.disabled = true;
  elems.btnCapture.disabled = true;
  elems.btnAutoCalib.disabled = true;
  clearOverlay();
  log('カメラ停止', 'info');
}

// =====================================================================
// 前後カメラ切替
// =====================================================================
elems.btnFlipCamera.addEventListener('click', async () => {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  elems.cameraSelect.value = ''; // deviceId指定を解除してfacingModeで起動
  log(`カメラを${state.facingMode === 'environment' ? '背面' : '前面'}に切替`, 'info');
  await startCamera();
});

function resizeOverlayCanvas() {
  const vw = elems.video.videoWidth || 640;
  const vh = elems.video.videoHeight || 480;
  elems.overlayCanvas.width = vw;
  elems.overlayCanvas.height = vh;
  elems.processedCanvas.width = vw;
  elems.processedCanvas.height = vh;
}

// =====================================================================
// タブ切替（モバイル用）
// =====================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    if (panel) panel.classList.remove('hidden');
  });
});

// =====================================================================
// パラメータ同期
// =====================================================================
elems.cannyLow.addEventListener('input', () => {
  state.params.cannyLow = +elems.cannyLow.value;
  elems.cannyLowVal.textContent = elems.cannyLow.value;
});
elems.cannyHigh.addEventListener('input', () => {
  state.params.cannyHigh = +elems.cannyHigh.value;
  elems.cannyHighVal.textContent = elems.cannyHigh.value;
});
elems.minArea.addEventListener('input', () => {
  state.params.minArea = +elems.minArea.value;
  elems.minAreaVal.textContent = elems.minArea.value;
});
elems.showEdges.addEventListener('change', () => {
  state.params.showEdges = elems.showEdges.checked;
});
elems.showContours.addEventListener('change', () => {
  state.params.showContours = elems.showContours.checked;
});

elems.refType.addEventListener('change', () => {
  const presets = {
    'credit-card': 85,
    'a4-short': 210,
    'coin-500': 26.5,
    'custom': +elems.refLength.value,
  };
  const v = presets[elems.refType.value];
  if (v !== undefined) elems.refLength.value = v;
});

// =====================================================================
// キャリブレーション
// =====================================================================
elems.btnCalibrate.addEventListener('click', toggleCalibration);

function toggleCalibration() {
  if (state.calibrating) {
    cancelCalibration();
  } else {
    startCalibration();
  }
}

function startCalibration() {
  state.calibrating = true;
  state.calibStart = null;
  state.calibEnd = null;
  exitManualModeQuiet();

  elems.btnCalibrate.textContent = 'キャリブレーション中止';
  elems.btnCalibrate.className = 'btn btn-danger';
  elems.calibStatus.textContent = '基準物体の一端をタップしてください';
  clearOverlay();
  drawCalibGuide();
  log('キャリブレーション開始。基準物体の一端をタップ/クリックしてください。', 'info');
}

function cancelCalibration() {
  state.calibrating = false;
  elems.btnCalibrate.textContent = 'キャリブレーション開始';
  elems.btnCalibrate.className = 'btn btn-secondary';
  elems.calibStatus.textContent = '';
  clearOverlay();
  log('キャリブレーション中止', 'warn');
}

function drawCalibGuide() {
  const ctx = elems.overlayCanvas.getContext('2d');
  const w = elems.overlayCanvas.width;
  const h = elems.overlayCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,0,0.4)';
  ctx.setLineDash([10, 10]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.calibStart) {
    drawPoint(ctx, state.calibStart, '#ffff00', 10, '始点');
  }
  if (state.calibStart && state.calibEnd) {
    drawPoint(ctx, state.calibEnd, '#ffff00', 10, '終点');
    ctx.beginPath();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.moveTo(state.calibStart.x, state.calibStart.y);
    ctx.lineTo(state.calibEnd.x, state.calibEnd.y);
    ctx.stroke();
  }
}

// =====================================================================
// キャンバス座標変換（マウス・タッチ共通）
// =====================================================================
function canvasCoords(e) {
  const rect = elems.overlayCanvas.getBoundingClientRect();
  const scaleX = elems.overlayCanvas.width / rect.width;
  const scaleY = elems.overlayCanvas.height / rect.height;
  // touchend は changedTouches、touchmove は touches、マウスは clientX/Y
  const src = e.changedTouches
    ? e.changedTouches[0]
    : (e.touches ? e.touches[0] : e);
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY,
  };
}

// =====================================================================
// キャンバスイベントリスナー（マウス + タッチ）
// =====================================================================
elems.overlayCanvas.addEventListener('click', onCanvasClick);

elems.overlayCanvas.addEventListener('touchend', (e) => {
  e.preventDefault(); // ダブルタップズームを防止
  onCanvasClick(e);
}, { passive: false });

elems.overlayCanvas.addEventListener('mousemove', onCanvasMouseMove);

elems.overlayCanvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  onCanvasMouseMove(e);
}, { passive: false });

function onCanvasMouseMove(e) {
  if (!state.calibrating && !state.manualMode) return;
  const pos = canvasCoords(e);
  const ctx = elems.overlayCanvas.getContext('2d');

  if (state.calibrating) {
    drawCalibGuide();
    if (state.calibStart) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,0,0.6)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.moveTo(state.calibStart.x, state.calibStart.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else if (state.manualMode) {
    redrawManualPoints(pos);
  }
}

function onCanvasClick(e) {
  const pos = canvasCoords(e);

  if (state.calibrating) {
    handleCalibClick(pos);
  } else if (state.manualMode) {
    handleManualClick(pos);
  }
}

function handleCalibClick(pos) {
  if (!state.calibStart) {
    state.calibStart = pos;
    elems.calibStatus.textContent = '他端をタップしてください';
    drawCalibGuide();
  } else {
    state.calibEnd = pos;
    finishCalibration();
  }
}

function finishCalibration() {
  const dx = state.calibEnd.x - state.calibStart.x;
  const dy = state.calibEnd.y - state.calibStart.y;
  const pixelDist = Math.sqrt(dx * dx + dy * dy);
  const realMm = +elems.refLength.value;

  if (pixelDist < 10) {
    log('タップ点が近すぎます。もう一度試してください。', 'warn');
    state.calibStart = null;
    state.calibEnd = null;
    elems.calibStatus.textContent = '始点をタップしてください';
    return;
  }

  state.calibPixelsPerMm = pixelDist / realMm;
  state.calibrating = false;

  elems.btnCalibrate.textContent = 'キャリブレーション開始';
  elems.btnCalibrate.className = 'btn btn-secondary';
  elems.calibStatus.textContent = `完了: ${state.calibPixelsPerMm.toFixed(2)} px/mm`;
  elems.resCalib.textContent = state.calibPixelsPerMm.toFixed(2);

  drawCalibGuide();
  log(`キャリブレーション完了: ${state.calibPixelsPerMm.toFixed(2)} px/mm (${realMm}mm = ${pixelDist.toFixed(1)}px)`, 'info');
}

// =====================================================================
// 自動キャリブレーション（カード/コイン認識）
// =====================================================================
elems.btnAutoCalib.addEventListener('click', toggleAutoCalib);

let autoCalibFrameId = null;
let autoCalibConfirmCount = 0;
let lastAutoCalibTime = 0;

function toggleAutoCalib() {
  if (state.autoCalibRunning) {
    stopAutoCalib();
  } else {
    startAutoCalib();
  }
}

function startAutoCalib() {
  if (!state.opencvReady || !state.cameraActive) return;
  stopAutoDetect();
  exitManualModeQuiet();
  cancelCalibration();
  state.autoCalibRunning = true;
  autoCalibConfirmCount = 0;
  elems.btnAutoCalib.textContent = '自動校正中止';
  elems.btnAutoCalib.className = 'btn btn-danger';
  log('クレジットカードまたは500円硬貨をカメラに向けてください', 'info');
  clearOverlay();
  autoCalibLoop();
}

function stopAutoCalib() {
  state.autoCalibRunning = false;
  autoCalibConfirmCount = 0;
  if (autoCalibFrameId) {
    cancelAnimationFrame(autoCalibFrameId);
    autoCalibFrameId = null;
  }
  elems.btnAutoCalib.textContent = 'カード/コインで自動校正';
  elems.btnAutoCalib.className = 'btn btn-secondary';
}

function autoCalibLoop() {
  if (!state.autoCalibRunning || !state.cameraActive) return;
  const now = performance.now();
  if (now - lastAutoCalibTime > 300) {
    lastAutoCalibTime = now;
    runAutoCalibDetect();
  }
  autoCalibFrameId = requestAnimationFrame(autoCalibLoop);
}

function runAutoCalibDetect() {
  const vw = elems.video.videoWidth;
  const vh = elems.video.videoHeight;
  if (!vw || !vh) return;

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = vw;
  tmpCanvas.height = vh;
  tmpCanvas.getContext('2d').drawImage(elems.video, 0, 0, vw, vh);

  const found = detectReferenceObject(tmpCanvas);
  clearOverlay();

  if (found) {
    autoCalibConfirmCount++;
    drawCalibRefOverlay(elems.overlayCanvas.getContext('2d'), found);
    if (autoCalibConfirmCount >= 3) {
      applyAutoCalib(found);
    }
  } else {
    autoCalibConfirmCount = 0;
    const ctx = elems.overlayCanvas.getContext('2d');
    ctx.font = 'bold 14px sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(4, elems.overlayCanvas.height - 28, 260, 22);
    ctx.fillStyle = '#ffff00';
    ctx.fillText('カード/コインを探しています...', 8, elems.overlayCanvas.height - 8);
  }
}

function drawCalibRefOverlay(ctx, found) {
  ctx.save();
  ctx.strokeStyle = '#ffff00';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ffff00';
  ctx.shadowBlur = 8;

  if (found.type === 'card' && found.pts) {
    ctx.beginPath();
    ctx.moveTo(found.pts[0].x, found.pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(found.pts[i].x, found.pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;
    drawCalibLabel(ctx, `クレジットカード ✓  ${found.pixelsPerMm.toFixed(2)} px/mm`,
      found.pts[0].x, found.pts[0].y - 6);
  } else if (found.type === 'coin') {
    ctx.beginPath();
    ctx.arc(found.center.x, found.center.y, found.radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    drawCalibLabel(ctx, `500円硬貨 ✓  ${found.pixelsPerMm.toFixed(2)} px/mm`,
      found.center.x, found.center.y - found.radiusPx - 6);
  }
  ctx.restore();
}

function drawCalibLabel(ctx, text, x, y) {
  ctx.font = 'bold 14px sans-serif';
  ctx.textBaseline = 'bottom';
  const tw = ctx.measureText(text).width;
  x = Math.max(4, Math.min(x, elems.overlayCanvas.width - tw - 8));
  y = Math.max(20, y);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 3, y - 17, tw + 6, 19);
  ctx.fillStyle = '#ffff00';
  ctx.fillText(text, x, y);
}

function applyAutoCalib(found) {
  stopAutoCalib();
  state.calibPixelsPerMm = found.pixelsPerMm;
  const typeName = found.type === 'card' ? 'クレジットカード (85.6mm)' : '500円硬貨 (26.5mm)';
  elems.calibStatus.textContent = `自動校正完了: ${state.calibPixelsPerMm.toFixed(2)} px/mm`;
  elems.resCalib.textContent = state.calibPixelsPerMm.toFixed(2);
  drawCalibRefOverlay(elems.overlayCanvas.getContext('2d'), found);
  log(`自動キャリブレーション完了 [${typeName}]: ${state.calibPixelsPerMm.toFixed(2)} px/mm`, 'info');
}

function detectReferenceObject(tmpCanvas) {
  let src = null, gray = null, blurred = null, edges = null;
  let contours = null, hierarchy = null;
  try {
    src = cv.imread(tmpCanvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 30, 100);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = tmpCanvas.width * tmpCanvas.height;
    let bestCard = null;
    let bestCoin = null;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);

      if (area < imgArea * 0.02 || area > imgArea * 0.85) { cnt.delete(); continue; }

      const peri = cv.arcLength(cnt, true);
      if (peri < 20) { cnt.delete(); continue; }

      const circularity = 4 * Math.PI * area / (peri * peri);
      const rect = cv.minAreaRect(cnt);
      const rw = Math.max(rect.size.width, rect.size.height);
      const rh = Math.min(rect.size.width, rect.size.height);
      if (rh < 10) { cnt.delete(); continue; }
      const aspect = rw / rh;

      // クレジットカード: アスペクト比 ~1.586 (85.6mm / 54mm)、矩形
      if (aspect >= 1.35 && aspect <= 1.85 && circularity < 0.75) {
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        const corners = approx.rows;
        approx.delete();
        if (corners >= 4 && corners <= 7) {
          if (!bestCard || area > bestCard.area) {
            bestCard = {
              type: 'card',
              area,
              pixelsPerMm: rw / 85.6,
              pts: cv.RotatedRect.points(rect),
            };
          }
        }
      }

      // 500円硬貨: 高い真円度 (>0.72)、アスペクト比ほぼ1
      if (circularity > 0.72 && aspect < 1.3) {
        const radiusPx = Math.sqrt(area / Math.PI);
        if (!bestCoin || area > bestCoin.area) {
          bestCoin = {
            type: 'coin',
            area,
            pixelsPerMm: (radiusPx * 2) / 26.5,
            radiusPx,
            center: { x: rect.center.x, y: rect.center.y },
          };
        }
      }

      cnt.delete();
    }

    return bestCard || bestCoin || null;
  } catch (_) {
    return null;
  } finally {
    [src, gray, blurred, edges, contours, hierarchy].forEach(m => {
      try { if (m) m.delete(); } catch (_) {}
    });
  }
}

// =====================================================================
// 手動計測モード
// =====================================================================
elems.btnManualMeasure.addEventListener('click', toggleManualMode);

function toggleManualMode() {
  if (state.manualMode) {
    exitManualMode();
  } else {
    enterManualMode();
  }
}

function enterManualMode() {
  stopAutoDetect();
  stopAutoCalib();
  state.manualMode = true;
  state.manualPoints = [];
  state.calibrating = false;
  elems.btnManualMeasure.textContent = '手動計測終了';
  elems.btnManualMeasure.className = 'btn btn-danger';
  clearOverlay();
  log('手動計測: 刃の両端を2点タップしてください。', 'info');
  updateStatus('手動計測: 刃の両端をタップ');
}

function exitManualMode() {
  exitManualModeQuiet();
  log('手動計測モード終了', 'info');
}

function exitManualModeQuiet() {
  state.manualMode = false;
  state.manualPoints = [];
  elems.btnManualMeasure.textContent = '手動計測（2点タップ）';
  elems.btnManualMeasure.className = 'btn btn-secondary';
  clearOverlay();
}

function handleManualClick(pos) {
  state.manualPoints.push(pos);
  redrawManualPoints(null);

  if (state.manualPoints.length === 2) {
    calculateManualMeasurement();
  } else if (state.manualPoints.length > 2) {
    state.manualPoints = state.manualPoints.slice(-2);
    redrawManualPoints(null);
    calculateManualMeasurement();
  }
}

function redrawManualPoints(cursor) {
  clearOverlay();
  const ctx = elems.overlayCanvas.getContext('2d');

  state.manualPoints.forEach((p, i) => {
    drawPoint(ctx, p, '#ffff00', 10, i === 0 ? '始点' : '終点');
  });

  if (state.manualPoints.length === 1 && cursor) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,0,0.6)';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.moveTo(state.manualPoints[0].x, state.manualPoints[0].y);
    ctx.lineTo(cursor.x, cursor.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.manualPoints.length === 2) {
    const [p1, p2] = state.manualPoints;
    ctx.beginPath();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
}

function calculateManualMeasurement() {
  if (state.manualPoints.length < 2) return;
  const [p1, p2] = state.manualPoints;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const pixelLen = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;

  let lengthMm = null;
  if (state.calibPixelsPerMm) {
    lengthMm = pixelLen / state.calibPixelsPerMm;
    elems.resBladeLength.textContent = lengthMm.toFixed(1);
    elems.unitBladeLength.textContent = 'mm';
    log(`手動計測: 刃渡り = ${lengthMm.toFixed(1)} mm (${pixelLen.toFixed(1)} px)`, 'detect');
  } else {
    elems.resBladeLength.textContent = pixelLen.toFixed(0);
    elems.unitBladeLength.textContent = 'px';
    log(`手動計測: ${pixelLen.toFixed(0)} px (キャリブレーション未設定)`, 'warn');
  }
  // 手動計測は刃のみを2点指定するため全長欄はクリア
  elems.resTotalLength.textContent = '--';
  elems.unitTotalLength.textContent = 'mm';

  elems.resAngle.textContent = angle.toFixed(1);
  elems.resStatus.textContent = '手動計測完了';

  if (lengthMm !== null) {
    addHistory({ bladeLength: lengthMm, bladeWidth: null, angle });
  }
}

// =====================================================================
// 自動検出モード
// =====================================================================
elems.btnAutoDetect.addEventListener('click', toggleAutoDetect);

function toggleAutoDetect() {
  if (state.autoDetectRunning) {
    stopAutoDetect();
  } else {
    startAutoDetect();
  }
}

function startAutoDetect() {
  if (!state.opencvReady) {
    log('OpenCV未準備のため自動検出不可。手動計測を使用してください。', 'warn');
    return;
  }
  exitManualModeQuiet();
  stopAutoCalib();
  state.autoDetectRunning = true;
  elems.btnAutoDetect.textContent = '自動検出停止';
  elems.btnAutoDetect.className = 'btn btn-danger';
  log('自動検出開始', 'info');
  autoDetectLoop();
}

function stopAutoDetect() {
  state.autoDetectRunning = false;
  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  elems.btnAutoDetect.textContent = '自動検出';
  elems.btnAutoDetect.className = 'btn btn-primary';
}

let lastDetectTime = 0;
const DETECT_INTERVAL_MS = 200; // 約5fps で処理

function autoDetectLoop() {
  if (!state.autoDetectRunning || !state.cameraActive) return;

  const now = performance.now();
  if (now - lastDetectTime > DETECT_INTERVAL_MS) {
    lastDetectTime = now;
    detectKnifeFrame();
  }

  state.animFrameId = requestAnimationFrame(autoDetectLoop);
}

// =====================================================================
// 撮影・解析ボタン
// =====================================================================
elems.btnCapture.addEventListener('click', () => {
  if (!state.opencvReady) {
    log('OpenCV未準備のため自動解析不可。', 'warn');
    return;
  }
  stopAutoDetect();
  detectKnifeFrame(true);
});

// =====================================================================
// OpenCV 包丁検出コア
// =====================================================================
function detectKnifeFrame(saveResult = false) {
  if (!state.opencvReady || !state.cameraActive) return;

  const vw = elems.video.videoWidth;
  const vh = elems.video.videoHeight;
  if (!vw || !vh) return;

  let src, gray, blurred, edges, contours, hierarchy, result;

  try {
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = vw;
    tmpCanvas.height = vh;
    tmpCanvas.getContext('2d').drawImage(elems.video, 0, 0, vw, vh);

    src = cv.imread(tmpCanvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, state.params.cannyLow, state.params.cannyHigh);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    result = new cv.Mat();
    if (state.params.showEdges) {
      cv.cvtColor(edges, result, cv.COLOR_GRAY2RGBA);
    } else {
      src.copyTo(result);
    }

    // 最大スコアの細長い輪郭を包丁候補として選択
    let bestContour = null;
    let bestScore = 0;
    let bestRect = null;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < state.params.minArea) { cnt.delete(); continue; }

      const rect = cv.minAreaRect(cnt);
      const w = Math.max(rect.size.width, rect.size.height);
      const h = Math.min(rect.size.width, rect.size.height);
      if (h < 1) { cnt.delete(); continue; }

      const aspect = w / h;
      if (aspect < 2.5 || aspect > 25) { cnt.delete(); continue; }

      const score = area * Math.min(aspect, 15);
      if (score > bestScore) {
        bestScore = score;
        if (bestContour) bestContour.delete();
        bestContour = cnt;
        bestRect = { rect, area, aspect, w, h };
      } else {
        cnt.delete();
      }
    }

    const overlayCtx = elems.overlayCanvas.getContext('2d');
    clearOverlay();

    if (bestContour && bestRect) {
      const rectPts = cv.RotatedRect.points(bestRect.rect);
      if (state.params.showContours) {
        drawRotatedRect(overlayCtx, rectPts, '#00ff88', 2);
      }

      const totalLengthPx = bestRect.w;   // 刃＋柄の全長
      const bladeWidthPx  = bestRect.h;
      const angleRaw      = bestRect.rect.angle;

      // 幅プロファイル解析で刃部分のみの長さを推定
      const bladeResult = estimateBladeLength(bestContour, bestRect.rect);
      const bladeOnlyPx = bladeResult ? bladeResult.lengthPx : totalLengthPx;

      let bladeOnlyMm   = null;
      let totalLengthMm = null;
      let bladeWidthMm  = null;
      if (state.calibPixelsPerMm) {
        bladeOnlyMm   = bladeOnlyPx   / state.calibPixelsPerMm;
        totalLengthMm = totalLengthPx / state.calibPixelsPerMm;
        bladeWidthMm  = bladeWidthPx  / state.calibPixelsPerMm;
      }

      const bbox = cv.boundingRect(bestContour);

      updateResults({
        status: '包丁検出',
        bladeOnlyPx,   bladeOnlyMm,
        totalLengthPx, totalLengthMm,
        bladeWidthPx,  bladeWidthMm,
        bbox, angle: angleRaw,
      });

      drawAnnotatedResult(tmpCanvas, rectPts, bladeResult, state.calibPixelsPerMm);

      if (saveResult) {
        log(`撮影解析: 刃渡り ${bladeOnlyMm ? bladeOnlyMm.toFixed(1) + ' mm' : bladeOnlyPx.toFixed(0) + ' px'} / 全長 ${totalLengthMm ? totalLengthMm.toFixed(1) + ' mm' : totalLengthPx.toFixed(0) + ' px'}`, 'detect');
        showDetectionConfirm({
          bladeLength: bladeOnlyMm ?? bladeOnlyPx,
          bladeWidth:  bladeWidthMm ?? bladeWidthPx,
          angle: angleRaw,
          bladeOnlyMm,
          bladeOnlyPx,
        });
      }

      bestContour.delete();
    } else {
      updateStatus('包丁未検出');
      if (saveResult) log('包丁を検出できませんでした。パラメータを調整してください。', 'warn');
    }

    cv.imshow(elems.processedCanvas, result);
    elems.btnSaveImage.disabled = false;

  } catch (err) {
    log(`検出エラー: ${err.message || err}`, 'error');
  } finally {
    [src, gray, blurred, edges, contours, hierarchy, result].forEach(m => {
      try { if (m) m.delete(); } catch (_) {}
    });
  }
}

// =====================================================================
// 描画ヘルパー
// =====================================================================
function drawPoint(ctx, p, color, r, label) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    ctx.fillStyle = color;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(label, p.x + r + 4, p.y - r);
  }
}

function drawRotatedRect(ctx, pts, color, lineWidth) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function clearOverlay() {
  const ctx = elems.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, elems.overlayCanvas.width, elems.overlayCanvas.height);
}

// =====================================================================
// 計測結果アノテーション描画
// =====================================================================
function drawAnnotatedResult(srcCanvas, rectPts, bladeResult, calibPpm) {
  const ac = elems.annotatedCanvas;
  ac.width  = srcCanvas.width;
  ac.height = srcCanvas.height;
  const ctx = ac.getContext('2d');

  // 元フレームを描画
  ctx.drawImage(srcCanvas, 0, 0);

  // バウンディングボックス（破線）
  ctx.save();
  ctx.strokeStyle = 'rgba(0,255,136,0.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(rectPts[0].x, rectPts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(rectPts[i].x, rectPts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  if (bladeResult) {
    const { lengthPx, tipPt, juncPt, handleEndPt } = bladeResult;
    const bladeLabel = calibPpm
      ? `刃渡り ${(lengthPx / calibPpm).toFixed(1)} mm`
      : `刃渡り ${lengthPx.toFixed(0)} px`;

    // 柄ライン（橙）
    drawMeasLine(ctx, juncPt, handleEndPt, '#ff9900', '柄', 3, 5, 6);
    // 刃ライン（緑）
    drawMeasLine(ctx, tipPt, juncPt, '#00e87a', bladeLabel, 3, 8, 8);

    // 刃元マーカー
    ctx.beginPath();
    ctx.arc(juncPt.x, juncPt.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,153,0,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  elems.resultImageBox.classList.remove('hidden');
}

function drawMeasLine(ctx, p1, p2, color, label, lw, dotR, tickLen) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const nx = -dy / len;
  const ny =  dx / len;
  const fs = Math.max(14, Math.min(22, Math.round(len / 8)));

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;

  // メインライン
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 端部チック
  [p1, p2].forEach(p => {
    ctx.beginPath();
    ctx.moveTo(p.x + nx * tickLen, p.y + ny * tickLen);
    ctx.lineTo(p.x - nx * tickLen, p.y - ny * tickLen);
    ctx.stroke();
  });

  // 端点ドット
  ctx.fillStyle = color;
  [p1, p2].forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    ctx.fill();
  });

  // ラベル（中点から法線方向にオフセット）
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const offset = fs + tickLen + 6;
  const lx = mx + nx * offset;
  const ly = my + ny * offset;

  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;

  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(lx - tw / 2 - 5, ly - fs * 0.65, tw + 10, fs * 1.3);
  ctx.fillStyle = color;
  ctx.fillText(label, lx, ly);

  ctx.restore();
}

// =====================================================================
// 刃部分のみ長さ推定（幅プロファイル解析）
// =====================================================================
function estimateBladeLength(contour, rect) {
  const angle = rect.angle;
  const cx = rect.center.x;
  const cy = rect.center.y;
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // 輪郭点群を回転して長軸を水平に揃える
  const pts = [];
  for (let i = 0; i < contour.rows; i++) {
    const px = contour.data32S[i * 2];
    const py = contour.data32S[i * 2 + 1];
    pts.push({
      x:  cos * (px - cx) + sin * (py - cy),
      y: -sin * (px - cx) + cos * (py - cy),
    });
  }

  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const range = maxX - minX;
  if (range < 1) return null;

  // 50ビンの幅プロファイルを作成
  const BINS = 50;
  const binSize = range / BINS;
  const minY = new Array(BINS).fill(Infinity);
  const maxY = new Array(BINS).fill(-Infinity);
  pts.forEach(p => {
    const b = Math.min(Math.floor((p.x - minX) / binSize), BINS - 1);
    if (p.y < minY[b]) minY[b] = p.y;
    if (p.y > maxY[b]) maxY[b] = p.y;
  });
  const widths = minY.map((mn, i) => mn === Infinity ? 0 : maxY[i] - mn);

  // 移動平均スムージング（窓幅3）
  const smoothed = widths.map((_, i) => {
    const s = Math.max(0, i - 1);
    const e = Math.min(BINS - 1, i + 1);
    const vals = widths.slice(s, e + 1).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });

  const maxWidth = Math.max(...smoothed);
  if (maxWidth < 1) return null;

  // 幅が最大幅の60%を超える箇所を「柄」とみなす閾値
  const threshold = maxWidth * 0.60;

  // 最大幅ビンの位置で刃先側を判定する
  // 刃元（刃と柄の境界に近い刃側）が最も幅広いため、刃先は最大幅ビンの反対側にある
  const maxBin = smoothed.indexOf(Math.max(...smoothed));
  const tipSide = maxBin >= BINS / 2 ? 'left' : 'right';

  // 刃先から柄に向かって走査し、閾値を超えた点を刃元（境界）とする
  let junctionBin;
  if (tipSide === 'left') {
    junctionBin = smoothed.findIndex((w, i) => i > 2 && w > threshold);
    if (junctionBin < 0) junctionBin = BINS - 1;
  } else {
    const rev = [...smoothed].reverse();
    const idx  = rev.findIndex((w, i) => i > 2 && w > threshold);
    junctionBin = idx >= 0 ? BINS - 1 - idx : 0;
  }

  const tipBin  = tipSide === 'left' ? 0 : BINS - 1;
  const lengthPx = Math.abs(junctionBin - tipBin) * binSize;

  // 回転座標から元画像座標へ逆変換（中心線 y_rot=0 として）
  const tipX_rot    = tipSide === 'left' ? minX : maxX;
  const juncX_rot   = minX + junctionBin * binSize;
  const handleX_rot = tipSide === 'left' ? maxX : minX;
  const imgPt = xr => ({ x: cos * xr + cx, y: sin * xr + cy });

  return {
    lengthPx,
    tipPt:       imgPt(tipX_rot),
    juncPt:      imgPt(juncX_rot),
    handleEndPt: imgPt(handleX_rot),
  };
}

// =====================================================================
// 結果表示
// =====================================================================
function setVal(valElem, unitElem, mm, px, unitLabel = 'mm') {
  if (mm !== null && mm !== undefined) {
    valElem.textContent = mm.toFixed(1);
    unitElem.textContent = unitLabel;
  } else {
    valElem.textContent = px !== undefined ? px.toFixed(0) : '--';
    unitElem.textContent = 'px';
  }
}

function updateResults({ status, bladeOnlyPx, bladeOnlyMm, totalLengthPx, totalLengthMm,
                         bladeWidthPx, bladeWidthMm, bbox, angle }) {
  const calib = state.calibPixelsPerMm;
  elems.resStatus.textContent = calib ? status : `${status}（キャリブレーション未設定・px表示）`;

  setVal(elems.resBladeLength,  elems.unitBladeLength,  bladeOnlyMm,   bladeOnlyPx);
  setVal(elems.resTotalLength,  elems.unitTotalLength,  totalLengthMm, totalLengthPx);
  setVal(elems.resBladeWidth,   elems.unitBladeWidth,   bladeWidthMm,  bladeWidthPx);

  if (bbox && calib) {
    elems.resBbox.textContent = `${(bbox.width / calib).toFixed(1)} × ${(bbox.height / calib).toFixed(1)}`;
    elems.unitBbox.textContent = 'mm';
  } else if (bbox) {
    elems.resBbox.textContent = `${bbox.width} × ${bbox.height}`;
    elems.unitBbox.textContent = 'px';
  }

  elems.resAngle.textContent = angle !== undefined ? angle.toFixed(1) : '--';
}

function updateStatus(text) {
  elems.resStatus.textContent = text;
}

// =====================================================================
// 検出確認ダイアログ
// =====================================================================
function showDetectionConfirm(result) {
  state.pendingResult = result;
  const label = result.bladeOnlyMm != null
    ? `刃渡り ${result.bladeOnlyMm.toFixed(1)} mm`
    : `刃渡り ${result.bladeOnlyPx.toFixed(0)} px`;
  elems.confirmSummary.textContent = label;
  elems.detectionConfirm.classList.remove('hidden');
}

function hideDetectionConfirm() {
  elems.detectionConfirm.classList.add('hidden');
  state.pendingResult = null;
}

elems.btnConfirmOk.addEventListener('click', () => {
  if (state.pendingResult) {
    addHistory(state.pendingResult);
    document.querySelector('.tab-btn[data-tab="result"]').click();
  }
  hideDetectionConfirm();
  log('検出結果を確定しました', 'detect');
});

elems.btnConfirmRetry.addEventListener('click', () => {
  hideDetectionConfirm();
  elems.resultImageBox.classList.add('hidden');
  updateStatus('待機中');
  elems.resBladeLength.textContent = '--';
  elems.unitBladeLength.textContent = 'mm';
  elems.resTotalLength.textContent = '--';
  elems.unitTotalLength.textContent = 'mm';
  log('やり直し: 再度「撮影・解析」ボタンを押してください', 'warn');
});

// =====================================================================
// 履歴管理
// =====================================================================
function addHistory({ bladeLength, bladeWidth, angle }) {
  const entry = {
    bladeLength,
    bladeWidth,
    angle,
    time: new Date().toLocaleTimeString('ja-JP'),
  };
  state.history.push(entry);

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${state.history.length}</td>
    <td>${bladeLength !== null ? bladeLength.toFixed(1) : '--'}</td>
    <td>${bladeWidth !== null ? bladeWidth.toFixed(1) : '--'}</td>
    <td>${angle !== null ? angle.toFixed(1) : '--'}</td>
    <td>${entry.time}</td>
  `;
  elems.historyBody.prepend(tr);
}

elems.btnClearHistory.addEventListener('click', () => {
  state.history = [];
  elems.historyBody.innerHTML = '';
  log('履歴クリア', 'info');
});

elems.btnExportCsv.addEventListener('click', exportCsv);

function exportCsv() {
  if (state.history.length === 0) {
    log('エクスポートするデータがありません', 'warn');
    return;
  }
  const header = ['#', '刃渡り(mm)', '刃幅(mm)', '角度(°)', '時刻'];
  const rows = state.history.map((h, i) => [
    i + 1,
    h.bladeLength !== null ? h.bladeLength.toFixed(1) : '',
    h.bladeWidth !== null ? h.bladeWidth.toFixed(1) : '',
    h.angle !== null ? h.angle.toFixed(1) : '',
    h.time,
  ]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `knife-measure-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  log('CSV出力完了', 'info');
}

// =====================================================================
// 画像保存
// =====================================================================
elems.btnSaveImage.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `knife-${Date.now()}.png`;
  link.href = elems.processedCanvas.toDataURL('image/png');
  link.click();
  log('処理済み画像を保存しました', 'info');
});

// =====================================================================
// リセット
// =====================================================================
elems.btnReset.addEventListener('click', () => {
  stopAutoDetect();
  stopAutoCalib();
  exitManualModeQuiet();
  cancelCalibration();
  clearOverlay();
  state.calibPixelsPerMm = null;
  state.history = [];
  elems.historyBody.innerHTML = '';
  elems.calibStatus.textContent = '';
  elems.resCalib.textContent = '未設定';
  elems.resBladeLength.textContent = '--';
  elems.unitBladeLength.textContent = 'mm';
  elems.resTotalLength.textContent = '--';
  elems.unitTotalLength.textContent = 'mm';
  elems.resBladeWidth.textContent = '--';
  elems.unitBladeWidth.textContent = 'mm';
  elems.resBbox.textContent = '--';
  elems.unitBbox.textContent = 'mm';
  elems.resAngle.textContent = '--';
  elems.resStatus.textContent = '待機中';
  elems.processedCanvas.getContext('2d').clearRect(
    0, 0, elems.processedCanvas.width, elems.processedCanvas.height
  );
  elems.resultImageBox.classList.add('hidden');
  log('全設定をリセット', 'warn');
});

// =====================================================================
// ウィンドウリサイズ対応
// =====================================================================
window.addEventListener('resize', () => {
  if (state.cameraActive) resizeOverlayCanvas();
});

// =====================================================================
// 起動ログ
// =====================================================================
log('アプリ起動完了。カメラ開始ボタンを押してください。', 'info');
log('OpenCV.js を読み込み中...', 'info');
