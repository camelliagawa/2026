'use strict';

// =====================================================================
// 状態管理
// =====================================================================
const state = {
  opencvReady: false,
  cameraActive: false,
  stream: null,
  calibPixelsPerMm: null,        // px/mm
  calibrating: false,
  calibStart: null,              // {x, y} canvas座標
  calibEnd: null,                // {x, y} canvas座標
  manualMode: false,
  manualPoints: [],              // 手動計測点 [{x,y}, ...]
  history: [],
  autoDetectRunning: false,
  animFrameId: null,
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
  calibOverlay:       $('calibration-overlay'),
  processedCanvas:    $('processed-canvas'),
  resStatus:          $('res-status'),
  resBladeLength:     $('res-blade-length'),
  resBladeWidth:      $('res-blade-width'),
  resBbox:            $('res-bbox'),
  resAngle:           $('res-angle'),
  resCalib:           $('res-calib'),
  historyBody:        $('history-body'),
  btnClearHistory:    $('btn-clear-history'),
  btnExportCsv:       $('btn-export-csv'),
  logOutput:          $('log-output'),
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
  initCameraList();
};

window.onOpenCvError = () => {
  log('OpenCV.js 読み込み失敗。オフライン環境ではキャリブレーションと自動検出が制限されます。', 'warn');
  // OpenCVなしでも手動計測モードは動作する
  initCameraList();
};

// =====================================================================
// カメラ一覧取得
// =====================================================================
async function initCameraList() {
  try {
    // まず許可を得るために一時ストリームを取得
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
  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } }
  };

  try {
    if (state.stream) stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    elems.video.srcObject = state.stream;
    await new Promise(r => elems.video.onloadedmetadata = r);
    elems.video.play();

    resizeOverlayCanvas();
    state.cameraActive = true;
    elems.btnStartCamera.disabled = true;
    elems.btnStopCamera.disabled = false;
    elems.btnCalibrate.disabled = false;
    elems.btnAutoDetect.disabled = false;
    elems.btnManualMeasure.disabled = false;
    elems.btnCapture.disabled = false;

    log(`カメラ開始: ${elems.video.videoWidth}x${elems.video.videoHeight}`, 'info');
  } catch (err) {
    log(`カメラ起動エラー: ${err.message}`, 'error');
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  stopAutoDetect();
  elems.video.srcObject = null;
  state.cameraActive = false;
  elems.btnStartCamera.disabled = false;
  elems.btnStopCamera.disabled = true;
  elems.btnCalibrate.disabled = true;
  elems.btnAutoDetect.disabled = true;
  elems.btnManualMeasure.disabled = true;
  elems.btnCapture.disabled = true;
  clearOverlay();
  log('カメラ停止', 'info');
}

function resizeOverlayCanvas() {
  const vw = elems.video.videoWidth || 640;
  const vh = elems.video.videoHeight || 480;
  elems.overlayCanvas.width = vw;
  elems.overlayCanvas.height = vh;
  elems.processedCanvas.width = vw;
  elems.processedCanvas.height = vh;
}

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

// 基準タイプ変更時に長さを自動入力
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
  state.manualMode = false;
  state.manualPoints = [];

  elems.btnCalibrate.textContent = 'キャリブレーション中止';
  elems.btnCalibrate.className = 'btn btn-danger';
  elems.calibStatus.textContent = '基準物体の両端をクリックしてください';
  clearOverlay();
  drawCalibGuide();
  log('キャリブレーション開始。基準物体の一端をクリックしてください。', 'info');
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
    drawPoint(ctx, state.calibStart, '#ffff00', 8, '始点');
  }
  if (state.calibStart && state.calibEnd) {
    drawPoint(ctx, state.calibEnd, '#ffff00', 8, '終点');
    ctx.beginPath();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.moveTo(state.calibStart.x, state.calibStart.y);
    ctx.lineTo(state.calibEnd.x, state.calibEnd.y);
    ctx.stroke();
  }
}

// =====================================================================
// オーバーレイキャンバス クリック・マウス処理
// =====================================================================
elems.overlayCanvas.addEventListener('click', onCanvasClick);
elems.overlayCanvas.addEventListener('mousemove', onCanvasMouseMove);

function canvasCoords(e) {
  const rect = elems.overlayCanvas.getBoundingClientRect();
  const scaleX = elems.overlayCanvas.width / rect.width;
  const scaleY = elems.overlayCanvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

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
    elems.calibStatus.textContent = '終端をクリックしてください';
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
    log('キャリブレーション線が短すぎます。もう一度試してください。', 'warn');
    state.calibStart = null;
    state.calibEnd = null;
    elems.calibStatus.textContent = '始点をクリックしてください';
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
  state.manualMode = true;
  state.manualPoints = [];
  state.calibrating = false;
  elems.btnManualMeasure.textContent = '手動計測終了';
  elems.btnManualMeasure.className = 'btn btn-danger';
  clearOverlay();
  log('手動計測モード開始。刃の両端をクリックしてください。2点以上クリックで計測。', 'info');
  updateStatus('手動計測モード: 刃の両端をクリック');
}

function exitManualMode() {
  state.manualMode = false;
  state.manualPoints = [];
  elems.btnManualMeasure.textContent = '手動計測';
  elems.btnManualMeasure.className = 'btn btn-secondary';
  clearOverlay();
  log('手動計測モード終了', 'info');
}

function handleManualClick(pos) {
  state.manualPoints.push(pos);
  redrawManualPoints(null);

  if (state.manualPoints.length === 2) {
    calculateManualMeasurement();
  } else if (state.manualPoints.length > 2) {
    // 最後2点で計測
    state.manualPoints = state.manualPoints.slice(-2);
    redrawManualPoints(null);
    calculateManualMeasurement();
  }
}

function redrawManualPoints(cursor) {
  const ctx = elems.overlayCanvas.getContext('2d');
  clearOverlay();

  state.manualPoints.forEach((p, i) => {
    drawPoint(ctx, p, '#ffff00', 8, i === 0 ? '始点' : '終点');
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
    log(`手動計測: 刃渡り = ${lengthMm.toFixed(1)} mm (${pixelLen.toFixed(1)} px)`, 'detect');
  } else {
    elems.resBladeLength.textContent = `${pixelLen.toFixed(0)} px`;
    log(`手動計測: ${pixelLen.toFixed(0)} px (キャリブレーション未設定)`, 'warn');
  }

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
  stopManualIfActive();
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

function stopManualIfActive() {
  if (state.manualMode) {
    state.manualMode = false;
    state.manualPoints = [];
    elems.btnManualMeasure.textContent = '手動計測';
    elems.btnManualMeasure.className = 'btn btn-secondary';
  }
}

let lastDetectTime = 0;
const DETECT_INTERVAL_MS = 200; // 5fps で処理

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

  let src, gray, blurred, edges, contours, hierarchy;
  let result;

  try {
    // video フレームを Canvas に描画して取得
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = vw;
    tmpCanvas.height = vh;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(elems.video, 0, 0, vw, vh);

    src = cv.imread(tmpCanvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, state.params.cannyLow, state.params.cannyHigh);

    // モルフォロジー膨張でエッジを繋げる
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // 処理済み画像の描画
    result = new cv.Mat();
    if (state.params.showEdges) {
      cv.cvtColor(edges, result, cv.COLOR_GRAY2RGBA);
    } else {
      src.copyTo(result);
    }

    // 最大の細長い輪郭を包丁候補として選択
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
      // 包丁らしさ: アスペクト比 3〜20 程度、細長い形状
      if (aspect < 2.5 || aspect > 25) { cnt.delete(); continue; }

      // スコア: 面積 × アスペクト比
      const score = area * Math.min(aspect, 15);
      if (score > bestScore) {
        bestScore = score;
        bestContour = cnt;
        bestRect = { rect, area, aspect, w, h };
      } else {
        cnt.delete();
      }
    }

    // 結果描画
    const overlayCtx = elems.overlayCanvas.getContext('2d');
    clearOverlay();

    if (bestContour && bestRect) {
      if (state.params.showContours) {
        const pts = cv.RotatedRect.points(bestRect.rect);
        drawRotatedRect(overlayCtx, pts, '#00ff88', 2);
      }

      // 刃渡り = 長軸の長さ
      const bladeLengthPx = bestRect.w;
      const bladeWidthPx = bestRect.h;
      const angleRaw = bestRect.rect.angle;

      let bladeLengthMm = null;
      let bladeWidthMm = null;
      if (state.calibPixelsPerMm) {
        bladeLengthMm = bladeLengthPx / state.calibPixelsPerMm;
        bladeWidthMm = bladeWidthPx / state.calibPixelsPerMm;
      }

      // BBox
      const bbox = cv.boundingRect(bestContour);

      // 結果更新
      updateResults({
        status: '包丁検出',
        bladeLengthPx,
        bladeLengthMm,
        bladeWidthPx,
        bladeWidthMm,
        bbox,
        angle: angleRaw,
      });

      if (saveResult) {
        addHistory({
          bladeLength: bladeLengthMm ?? bladeLengthPx,
          bladeWidth: bladeWidthMm ?? bladeWidthPx,
          angle: angleRaw,
        });
        log(`撮影解析: 刃渡り ${bladeLengthMm ? bladeLengthMm.toFixed(1) + ' mm' : bladeLengthPx.toFixed(0) + ' px'}`, 'detect');
      }

      bestContour.delete();
    } else {
      updateStatus('包丁未検出');
      if (saveResult) log('包丁を検出できませんでした。パラメータを調整してください。', 'warn');
    }

    // 処理済み画像表示
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
    ctx.font = '14px sans-serif';
    ctx.fillText(label, p.x + r + 2, p.y - r);
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
// 結果表示
// =====================================================================
function updateResults({ status, bladeLengthPx, bladeLengthMm, bladeWidthPx, bladeWidthMm, bbox, angle }) {
  elems.resStatus.textContent = status;

  if (bladeLengthMm !== null && bladeLengthMm !== undefined) {
    elems.resBladeLength.textContent = bladeLengthMm.toFixed(1);
  } else {
    elems.resBladeLength.textContent = `${bladeLengthPx.toFixed(0)} px`;
  }

  if (bladeWidthMm !== null && bladeWidthMm !== undefined) {
    elems.resBladeWidth.textContent = bladeWidthMm.toFixed(1);
  } else {
    elems.resBladeWidth.textContent = `${bladeWidthPx.toFixed(0)} px`;
  }

  if (bbox && state.calibPixelsPerMm) {
    const bw = (bbox.width / state.calibPixelsPerMm).toFixed(1);
    const bh = (bbox.height / state.calibPixelsPerMm).toFixed(1);
    elems.resBbox.textContent = `${bw} × ${bh}`;
  } else if (bbox) {
    elems.resBbox.textContent = `${bbox.width} × ${bbox.height} px`;
  }

  elems.resAngle.textContent = angle !== undefined ? angle.toFixed(1) : '--';
}

function updateStatus(text) {
  elems.resStatus.textContent = text;
}

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
  exitManualMode();
  cancelCalibration();
  clearOverlay();
  state.calibPixelsPerMm = null;
  state.history = [];
  elems.historyBody.innerHTML = '';
  elems.calibStatus.textContent = '';
  elems.resCalib.textContent = '未設定';
  elems.resBladeLength.textContent = '--';
  elems.resBladeWidth.textContent = '--';
  elems.resBbox.textContent = '--';
  elems.resAngle.textContent = '--';
  elems.resStatus.textContent = '待機中';
  const ctx = elems.processedCanvas.getContext('2d');
  ctx.clearRect(0, 0, elems.processedCanvas.width, elems.processedCanvas.height);
  log('全設定をリセット', 'warn');
});

// =====================================================================
// ウィンドウリサイズ対応
// =====================================================================
window.addEventListener('resize', () => {
  if (state.cameraActive) resizeOverlayCanvas();
});

// =====================================================================
// 初期ログ
// =====================================================================
log('アプリ起動完了。カメラを選択して開始してください。', 'info');
log('OpenCV.js を読み込み中...', 'info');
