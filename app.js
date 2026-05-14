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
  manualMode: false,
  manualPoints: [],              // 手動計測点 [{x,y}, ...]
  history: [],
  autoDetectRunning: false,
  autoCalibRunning: false,
  animFrameId: null,
  pendingResult: null,
  calTapMode: false,
  calTapPts: [],
  roiTapMode: false,
  roiTapPts: [],
  lastCanvas: null,
  lastRectPts: null,
  lastBladeResult: null,
  lastKnifeMetrics: null,
  lastContourPts: null,
  lastRect: null,
  lastBladeCurvePts: null,
  preCurveImageData: null,
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
  calibStatus:        $('calibration-status'),
  btnCapture:         $('btn-capture'),
  fileInput:          $('file-input'),
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
  annotatedCanvas:    $('annotated-canvas'),
  resultImageBox:     $('result-image-box'),
  btnCalibFromCard:   $('btn-calib-from-card'),
  calibTapHint:       $('calib-tap-hint'),
  btnCancelCalibTap:  $('btn-cancel-calib-tap'),
  btnRoiDetect:       $('btn-roi-detect'),
  roiTapHint:         $('roi-tap-hint'),
  btnCancelRoiTap:    $('btn-cancel-roi-tap'),
  cardDetectFailed:   $('card-detect-failed'),
  btnRetryRoi:        $('btn-retry-roi'),
  btnBladeCurve:      $('btn-blade-curve'),
  bladeCurveStatus:   $('blade-curve-status'),
  bladeDotInterval:   $('blade-dot-interval'),
  versionInfo:        $('version-info'),
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
    elems.btnCapture.disabled = false;
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

    // 先頭に「自動（背面カメラ優先）」オプションを追加
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '自動（背面カメラ）';
    elems.cameraSelect.appendChild(autoOpt);

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
    elems.btnCapture.disabled = !state.opencvReady;

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
  stopCameraStream();
  elems.video.srcObject = null;
  state.cameraActive = false;
  elems.btnStartCamera.disabled = false;
  elems.btnStopCamera.disabled = true;
  elems.btnFlipCamera.disabled = true;
  elems.btnCapture.disabled = true;
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
  if (!state.manualMode) return;
  redrawManualPoints(canvasCoords(e));
}

function onCanvasClick(e) {
  if (state.manualMode) handleManualClick(canvasCoords(e));
}

// =====================================================================
// 撮影画像の一括解析（自動校正 + 刃渡り計測）
// =====================================================================
function analyzeImage(canvas) {
  if (!state.opencvReady) {
    log('OpenCV未準備のため解析できません', 'error');
    return;
  }
  log('画像解析開始', 'info');
  if (elems.bladeCurveStatus) elems.bladeCurveStatus.classList.add('hidden');

  state.lastCanvas = canvas;

  // 撮影画像をプレビューに表示
  elems.processedCanvas.width  = canvas.width;
  elems.processedCanvas.height = canvas.height;
  elems.processedCanvas.getContext('2d').drawImage(canvas, 0, 0);

  // 読み込んだ画像を結果エリアに即座に表示（検出失敗時も画像が見えるように）
  const ac = elems.annotatedCanvas;
  ac.width  = canvas.width;
  ac.height = canvas.height;
  ac.getContext('2d').drawImage(canvas, 0, 0);
  elems.resultImageBox.classList.remove('hidden');
  // モバイルでは結果タブに切り替えて画像を見えるようにする
  const resultTabBtn = document.querySelector('.tab-btn[data-tab="result"]');
  if (resultTabBtn && window.getComputedStyle(document.getElementById('tab-nav')).display !== 'none') {
    resultTabBtn.click();
  }

  // Step 1: クレジットカード/コインを検出してスケール自動校正
  const calRef = detectReferenceObject(canvas);
  if (calRef) {
    state.calibPixelsPerMm = calRef.pixelsPerMm;
    const typeName = calRef.type === 'card' ? 'クレジットカード (85.6mm)' : '500円硬貨 (26.5mm)';
    elems.calibStatus.textContent = `自動校正完了: ${state.calibPixelsPerMm.toFixed(2)} px/mm`;
    elems.resCalib.textContent     = state.calibPixelsPerMm.toFixed(2);
    log(`自動キャリブレーション [${typeName}]: ${state.calibPixelsPerMm.toFixed(2)} px/mm`, 'info');
    updateBladeCurveBtn();
  } else if (!state.calibPixelsPerMm) {
    log('クレジットカード/コインが検出できませんでした。カードが画面に収まっているか確認してください。寸法はpx表示になります。', 'warn');
  }

  // Step 2: 包丁検出・計測
  detectKnifeOnCanvas(canvas, true);

  // Step 3: 検出結果画像にカード枠を描画
  if (calRef) {
    drawCalibRefOverlay(elems.annotatedCanvas.getContext('2d'), calRef);
  }
}

function drawCalibRefOverlay(ctx, found) {
  ctx.save();
  ctx.strokeStyle = '#ffff00';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ffff00';
  ctx.shadowBlur = 8;

  if (found.type === 'card' && found.pts) {
    // カード輪郭（破線）
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(found.pts[0].x, found.pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(found.pts[i].x, found.pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    // 長辺を太線で強調
    if (found.longEdgePts) {
      ctx.lineWidth = 4;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(found.longEdgePts[0].x, found.longEdgePts[0].y);
      ctx.lineTo(found.longEdgePts[1].x, found.longEdgePts[1].y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 端点マーカー
      [found.longEdgePts[0], found.longEdgePts[1]].forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#ffff00';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    ctx.shadowBlur = 0;
    const labelPt = found.longEdgePts ? found.longEdgePts[0] : found.pts[0];
    drawCalibLabel(ctx, `カード長辺 85.6mm ✓  ${found.pixelsPerMm.toFixed(2)} px/mm`,
      labelPt.x, labelPt.y - 10);
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
  const canvasW = ctx.canvas ? ctx.canvas.width : elems.overlayCanvas.width;
  x = Math.max(4, Math.min(x, canvasW - tw - 8));
  y = Math.max(20, y);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 3, y - 17, tw + 6, 19);
  ctx.fillStyle = '#ffff00';
  ctx.fillText(text, x, y);
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
    cv.Canny(blurred, edges, 20, 80);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = tmpCanvas.width * tmpCanvas.height;
    let bestCard = null;
    let bestCoin = null;

    // カード検出を2パスで試みる：1パス目は標準、2パス目はより緩い条件
    const passes = [
      { minArea: 0.001, maxArea: 0.85, aspectMin: 1.2, aspectMax: 2.1, maxCorners: 10 },
      { minArea: 0.0003, maxArea: 0.90, aspectMin: 1.0, aspectMax: 2.8, maxCorners: 14 },
    ];

    outer: for (const pass of passes) {
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);

        if (area < imgArea * pass.minArea || area > imgArea * pass.maxArea) { cnt.delete(); continue; }

        const peri = cv.arcLength(cnt, true);
        if (peri < 20) { cnt.delete(); continue; }

        const circularity = 4 * Math.PI * area / (peri * peri);
        const rect = cv.minAreaRect(cnt);
        const rw = Math.max(rect.size.width, rect.size.height);
        const rh = Math.min(rect.size.width, rect.size.height);
        if (rh < 8) { cnt.delete(); continue; }
        const aspect = rw / rh;

        // クレジットカード: アスペクト比 ~1.586 (85.6mm / 54mm)、矩形
        if (aspect >= pass.aspectMin && aspect <= pass.aspectMax && circularity < 0.78) {
          const approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
          const corners = approx.rows;
          approx.delete();
          if (corners >= 4 && corners <= pass.maxCorners) {
            const pts = cv.RotatedRect.points(rect);
            // 長辺の両端点を特定（隣接する辺のうち長い方）
            const d01 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const d12 = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
            const longEdgePts = d01 >= d12 ? [pts[0], pts[1]] : [pts[1], pts[2]];
            if (!bestCard || area > bestCard.area) {
              bestCard = {
                type: 'card',
                area,
                pixelsPerMm: rw / 85.6,
                pts,
                longEdgePts,
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
      // 1パス目でカードが見つかれば2パス目は不要
      if (bestCard) break outer;
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
function exitManualModeQuiet() {
  state.manualMode = false;
  state.manualPoints = [];
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
// 撮影ボタン・ファイル入力
// =====================================================================
elems.btnCapture.addEventListener('click', () => {
  if (!state.opencvReady) {
    log('OpenCV未準備のため解析不可', 'warn');
    return;
  }
  const vw = elems.video.videoWidth;
  const vh = elems.video.videoHeight;
  if (!vw || !vh) {
    log('カメラ映像が取得できません', 'error');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  canvas.getContext('2d').drawImage(elems.video, 0, 0, vw, vh);
  analyzeImage(canvas);
});

elems.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';   // 同じファイルを再選択できるようにリセット
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    // ファイル読み込み時はカメラ不要なのでOpenCVだけ確認
    if (!state.opencvReady) {
      log('OpenCV未準備のため解析不可。少し待ってから再試行してください。', 'warn');
      return;
    }
    log(`画像読み込み: ${img.naturalWidth}×${img.naturalHeight}`, 'info');
    // オーバーレイキャンバスを画像サイズに合わせる
    elems.overlayCanvas.width  = img.naturalWidth;
    elems.overlayCanvas.height = img.naturalHeight;
    analyzeImage(canvas);
  };
  img.onerror = () => log('画像の読み込みに失敗しました', 'error');
  img.src = url;
});

// =====================================================================
// OpenCV 包丁検出コア
// =====================================================================
function detectKnifeOnCanvas(srcCanvas, saveResult = false) {
  if (!state.opencvReady) return;

  let src, gray, blurred, edges, contours, hierarchy, result;

  try {
    src = cv.imread(srcCanvas);
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

      state.lastRectPts = rectPts;
      state.lastBladeResult = bladeResult;
      state.lastKnifeMetrics = { bladeOnlyPx, totalLengthPx, bladeWidthPx, bbox, angle: angleRaw };

      updateResults({
        status: '包丁検出',
        bladeOnlyPx,   bladeOnlyMm,
        totalLengthPx, totalLengthMm,
        bladeWidthPx,  bladeWidthMm,
        bbox, angle: angleRaw,
      });

      drawAnnotatedResult(srcCanvas, rectPts, bladeResult, state.calibPixelsPerMm);

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

      // 刃渡り曲線用に輪郭点群と矩形を保存
      state.lastContourPts = [];
      for (let i = 0; i < bestContour.rows; i++) {
        state.lastContourPts.push({
          x: bestContour.data32S[i * 2],
          y: bestContour.data32S[i * 2 + 1],
        });
      }
      state.lastRect = {
        angle:  bestRect.rect.angle,
        center: { x: bestRect.rect.center.x, y: bestRect.rect.center.y },
        size:   { width: bestRect.rect.size.width, height: bestRect.rect.size.height },
      };
      updateBladeCurveBtn();
      autoDrawBladeCurve();
      bestContour.delete();
    } else {
      updateStatus('包丁未検出');
      if (saveResult) log('包丁を検出できませんでした。パラメータを調整してください。', 'warn');
    }

    if (state.params.showEdges) {
      cv.imshow(elems.processedCanvas, result);
    }
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
  // OpenCVのminAreaRectはangle=widthベクトルのX軸からの角度(-90,0]を返す。
  // height > width の場合、widthが短軸になっているため90°補正して長軸を水平に揃える。
  let angle = rect.angle;
  if (rect.size.height > rect.size.width) {
    angle += 90;
  }
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

  // 最大幅ビンの位置で刃先側を判定する
  // 包丁は刃先（細）→刃元（最大幅）→柄 の順に幅が変化するため、最大幅位置が刃渡りの終端
  const maxBin = smoothed.indexOf(Math.max(...smoothed));
  const tipSide = maxBin >= BINS / 2 ? 'left' : 'right';

  // 幅が最大の40%に達する最初のビン = アゴ（柄→刃の移行点）
  const junctionBin = detectJuncBin(smoothed, maxBin, tipSide, BINS);

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
// カード手動校正（2点タップ）
// =====================================================================
function annotatedCanvasCoords(e) {
  const rect = elems.annotatedCanvas.getBoundingClientRect();
  const scaleX = elems.annotatedCanvas.width / rect.width;
  const scaleY = elems.annotatedCanvas.height / rect.height;
  const src = e.changedTouches ? e.changedTouches[0] : (e.touches ? e.touches[0] : e);
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY,
  };
}

elems.btnCalibFromCard.addEventListener('click', () => {
  state.calTapMode = true;
  state.calTapPts = [];
  elems.btnCalibFromCard.classList.add('hidden');
  elems.calibTapHint.classList.remove('hidden');
  elems.btnCancelCalibTap.classList.remove('hidden');
  elems.annotatedCanvas.classList.add('tap-mode');
  log('カードの長辺の両端を2点タップしてください（85.6mm）', 'info');
});

elems.btnCancelCalibTap.addEventListener('click', exitCalibTapMode);

function exitCalibTapMode() {
  state.calTapMode = false;
  state.calTapPts = [];
  elems.btnCalibFromCard.classList.remove('hidden');
  elems.calibTapHint.classList.add('hidden');
  elems.btnCancelCalibTap.classList.add('hidden');
  elems.annotatedCanvas.classList.remove('tap-mode');
}

elems.annotatedCanvas.addEventListener('click', onAnnotatedCanvasClick);
elems.annotatedCanvas.addEventListener('touchend', (e) => {
  if (!state.calTapMode && !state.roiTapMode) return;
  e.preventDefault();
  onAnnotatedCanvasClick(e);
}, { passive: false });

function onAnnotatedCanvasClick(e) {
  if (!state.calTapMode && !state.roiTapMode) return;
  const pt = annotatedCanvasCoords(e);
  const ctx = elems.annotatedCanvas.getContext('2d');

  if (state.calTapMode) {
    state.calTapPts.push(pt);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = state.calTapPts.length === 1 ? '#ffff00' : '#00e87a';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (state.calTapPts.length >= 2) {
      const [p1, p2] = state.calTapPts;
      const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      state.calibPixelsPerMm = distPx / 85.6;
      log(`手動校正完了: ${state.calibPixelsPerMm.toFixed(2)} px/mm（${distPx.toFixed(0)} px = 85.6 mm）`, 'info');
      elems.calibStatus.textContent = `手動校正: ${state.calibPixelsPerMm.toFixed(2)} px/mm`;
      elems.resCalib.textContent = state.calibPixelsPerMm.toFixed(2);
      exitCalibTapMode();
      applyCalibration();
      updateBladeCurveBtn();
    }
  } else if (state.roiTapMode) {
    state.roiTapPts.push(pt);
    // 1点目: コーナーマーカー
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ff9900';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (state.roiTapPts.length >= 2) {
      const [p1, p2] = state.roiTapPts;
      // ROI矩形を描画
      ctx.strokeStyle = '#ff9900';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.setLineDash([]);
      detectInRoi(p1.x, p1.y, p2.x, p2.y);
    }
  }
}

function applyCalibration() {
  const ppm = state.calibPixelsPerMm;
  if (!ppm || !state.lastKnifeMetrics) return;
  const { bladeOnlyPx, totalLengthPx, bladeWidthPx, bbox, angle } = state.lastKnifeMetrics;
  updateResults({
    status: '包丁検出',
    bladeOnlyPx,  bladeOnlyMm:   bladeOnlyPx / ppm,
    totalLengthPx, totalLengthMm: totalLengthPx / ppm,
    bladeWidthPx, bladeWidthMm:  bladeWidthPx / ppm,
    bbox, angle,
  });
  if (state.lastCanvas && state.lastRectPts && state.lastBladeResult) {
    drawAnnotatedResult(state.lastCanvas, state.lastRectPts, state.lastBladeResult, ppm);
    autoDrawBladeCurve();
  }
}

// =====================================================================
// ROIエリア指定カード検出
// =====================================================================
elems.btnRoiDetect.addEventListener('click', enterRoiTapMode);
elems.btnCancelRoiTap.addEventListener('click', exitRoiTapMode);
elems.btnRetryRoi.addEventListener('click', () => {
  elems.cardDetectFailed.classList.add('hidden');
  enterRoiTapMode();
});

function enterRoiTapMode() {
  state.roiTapMode = true;
  state.roiTapPts = [];
  elems.btnRoiDetect.classList.add('hidden');
  elems.btnCalibFromCard.classList.add('hidden');
  elems.roiTapHint.classList.remove('hidden');
  elems.btnCancelRoiTap.classList.remove('hidden');
  elems.cardDetectFailed.classList.add('hidden');
  elems.annotatedCanvas.classList.add('tap-mode');
  log('カードが写っている範囲の対角2点をタップしてください', 'info');
}

function exitRoiTapMode() {
  state.roiTapMode = false;
  state.roiTapPts = [];
  elems.btnRoiDetect.classList.remove('hidden');
  elems.btnCalibFromCard.classList.remove('hidden');
  elems.roiTapHint.classList.add('hidden');
  elems.btnCancelRoiTap.classList.add('hidden');
  elems.annotatedCanvas.classList.remove('tap-mode');
}

function detectInRoi(x1, y1, x2, y2) {
  if (!state.lastCanvas) return;
  const cropX = Math.round(Math.min(x1, x2));
  const cropY = Math.round(Math.min(y1, y2));
  const cropW = Math.round(Math.abs(x2 - x1));
  const cropH = Math.round(Math.abs(y2 - y1));
  if (cropW < 20 || cropH < 20) {
    log('選択エリアが小さすぎます', 'warn');
    exitRoiTapMode();
    return;
  }

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  cropCanvas.getContext('2d').drawImage(
    state.lastCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH
  );

  const result = detectReferenceObject(cropCanvas);

  if (result) {
    // 座標を元画像の絶対座標に変換
    if (result.pts) {
      result.pts = result.pts.map(p => ({ x: p.x + cropX, y: p.y + cropY }));
    }
    if (result.longEdgePts) {
      result.longEdgePts = result.longEdgePts.map(p => ({ x: p.x + cropX, y: p.y + cropY }));
    }
    if (result.center) {
      result.center = { x: result.center.x + cropX, y: result.center.y + cropY };
    }
    state.calibPixelsPerMm = result.pixelsPerMm;
    elems.calibStatus.textContent = `ROI自動校正: ${result.pixelsPerMm.toFixed(2)} px/mm`;
    elems.resCalib.textContent = result.pixelsPerMm.toFixed(2);
    log(`ROI内カード検出成功: ${result.pixelsPerMm.toFixed(2)} px/mm`, 'info');
    applyCalibration();
    updateBladeCurveBtn();
    // カードのオーバーレイを追記
    drawCalibRefOverlay(elems.annotatedCanvas.getContext('2d'), result);
    exitRoiTapMode();
  } else {
    log('指定エリア内でカードを検出できませんでした', 'warn');
    exitRoiTapMode();
    elems.cardDetectFailed.classList.remove('hidden');
  }
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
// 刃渡り曲線抽出・描画・CSV出力
// =====================================================================
function updateBladeCurveBtn() {
  if (elems.btnBladeCurve) {
    elems.btnBladeCurve.disabled = !(state.calibPixelsPerMm && state.lastContourPts);
  }
}

function autoDrawBladeCurve() {
  if (!state.calibPixelsPerMm || !state.lastContourPts) return;
  const pts = extractBladeEdgeCurve();
  if (!pts || pts.length === 0) return;
  state.lastBladeCurvePts = pts;
  drawBladeEdgeCurve(pts);
  if (elems.bladeCurveStatus) {
    elems.bladeCurveStatus.textContent = `✓ 刃渡り曲線描画済み (${bladeDotCount(pts)}点)`;
    elems.bladeCurveStatus.classList.remove('hidden');
  }
  log(`刃渡り曲線描画: ${bladeDotCount(pts)}点`, 'detect');
}

// Find the blade-tang junction bin (アゴ) more accurately than just maxBin.
// Estimates the handle (tang) width from the 3 extreme handle-side bins, then
// uses the midpoint between tang and peak width as the threshold.
// This adapts to any tang/blade width ratio.
function detectJuncBin(wSmoothed, maxBin, tipSide, BINS) {
  const globalMaxW = wSmoothed[maxBin];
  if (globalMaxW === 0) return maxBin;

  // If the global maximum is within the handle-end zone (first/last 20% of bins),
  // it likely represents the handle/bolster rather than the blade heel.
  // In that case, find the blade-region peak in the remaining 80% of bins.
  const skip = Math.round(BINS * 0.20);
  let bladeMaxBin = maxBin, bladeMaxW = globalMaxW;
  if (tipSide === 'right' && maxBin < skip) {
    bladeMaxW = 0;
    for (let i = skip; i < BINS; i++) {
      if (wSmoothed[i] > bladeMaxW) { bladeMaxW = wSmoothed[i]; bladeMaxBin = i; }
    }
    if (bladeMaxW === 0) return BINS - 1;
  } else if (tipSide === 'left' && maxBin >= BINS - skip) {
    bladeMaxW = 0;
    for (let i = BINS - 1 - skip; i >= 0; i--) {
      if (wSmoothed[i] > bladeMaxW) { bladeMaxW = wSmoothed[i]; bladeMaxBin = i; }
    }
    if (bladeMaxW === 0) return 0;
  }

  // Find the tang minimum between handle end and blade heel.
  // Initialising to bladeMaxW means handle-side bins that are wider than the
  // blade heel (which can happen when the handle is the global max) are ignored.
  let tangMinBin = tipSide === 'right' ? 0 : BINS - 1;
  let tangMinW   = bladeMaxW;
  if (tipSide === 'right') {
    for (let i = 0; i < bladeMaxBin; i++) {
      if (wSmoothed[i] < tangMinW) { tangMinW = wSmoothed[i]; tangMinBin = i; }
    }
  } else {
    for (let i = BINS - 1; i > bladeMaxBin; i--) {
      if (wSmoothed[i] < tangMinW) { tangMinW = wSmoothed[i]; tangMinBin = i; }
    }
  }

  // アゴ = the tang minimum itself.
  // The narrowest cross-section between the handle and the blade heel
  // is the physical blade-to-handle junction (アゴ/heel).
  return tangMinBin;
}

// Gaussian smooth an array (skips emptyVal entries)
function gaussianSmoothArr(arr, emptyVal, sigma) {
  const kr = Math.ceil(3 * sigma);
  return arr.map((_, i) => {
    let sum = 0, w = 0;
    for (let j = Math.max(0, i - kr); j <= Math.min(arr.length - 1, i + kr); j++) {
      if (arr[j] === emptyVal) continue;
      const wt = Math.exp(-0.5 * ((j - i) / sigma) ** 2);
      sum += arr[j] * wt; w += wt;
    }
    return w > 0 ? sum / w : emptyVal;
  });
}


function extractBladeEdgeCurve() {
  const ppm = state.calibPixelsPerMm;
  if (!ppm || !state.lastContourPts || !state.lastRect) return null;

  const { angle: rawAngle, center, size } = state.lastRect;
  let angle = rawAngle;
  if (size.height > size.width) angle += 90;
  const cx = center.x, cy = center.y;
  const rad = angle * Math.PI / 180;
  const cosA = Math.cos(rad), sinA = Math.sin(rad);

  const rotPts = state.lastContourPts.map(p => ({
    x:  cosA * (p.x - cx) + sinA * (p.y - cy),
    y: -sinA * (p.x - cx) + cosA * (p.y - cy),
  }));

  let minX = Infinity, maxX = -Infinity;
  rotPts.forEach(p => { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; });
  const range = maxX - minX;
  if (range < 1) return null;

  // 50-bin coarse profile to locate junction/tip (same as estimateBladeLength)
  const BINS = 50;
  const coarseBin = range / BINS;
  const coarseMinY = new Array(BINS).fill(Infinity);
  const coarseMaxY = new Array(BINS).fill(-Infinity);
  rotPts.forEach(p => {
    const b = Math.min(Math.floor((p.x - minX) / coarseBin), BINS - 1);
    if (p.y < coarseMinY[b]) coarseMinY[b] = p.y;
    if (p.y > coarseMaxY[b]) coarseMaxY[b] = p.y;
  });
  const widths = coarseMinY.map((mn, i) => mn === Infinity ? 0 : coarseMaxY[i] - mn);
  const wSmoothed = widths.map((_, i) => {
    const s = Math.max(0, i - 1), e = Math.min(BINS - 1, i + 1);
    const vals = widths.slice(s, e + 1).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });
  const maxBin  = wSmoothed.indexOf(Math.max(...wSmoothed));
  const tipSide = maxBin >= BINS / 2 ? 'left' : 'right';
  const juncBin   = detectJuncBin(wSmoothed, maxBin, tipSide, BINS);
  const juncX_rot = minX + juncBin * coarseBin;
  const tipX_rot  = tipSide === 'left' ? minX : maxX;

  const bladeMinX = Math.min(juncX_rot, tipX_rot);
  const bladeMaxX = Math.max(juncX_rot, tipX_rot);
  const bladeRange = bladeMaxX - bladeMinX;
  if (bladeRange < 1) return null;

  // Aggregate into medium bins (~3px each) — dense enough to always capture both edges
  const binPx = Math.max(3, Math.round(bladeRange / 200));
  const nBins  = Math.ceil(bladeRange / binPx);
  const medMinY = new Array(nBins).fill(Infinity);
  const medMaxY = new Array(nBins).fill(-Infinity);
  rotPts.forEach(p => {
    if (p.x < bladeMinX - binPx || p.x > bladeMaxX + binPx) return;
    const b = Math.max(0, Math.min(nBins - 1, Math.floor((p.x - bladeMinX) / binPx)));
    if (p.y < medMinY[b]) medMinY[b] = p.y;
    if (p.y > medMaxY[b]) medMaxY[b] = p.y;
  });

  // Fill remaining gaps by propagation
  const fillArr = (arr, empty) => {
    const first = arr.findIndex(v => v !== empty);
    if (first === -1) return;
    for (let i = 0; i < first; i++) arr[i] = arr[first];
    let prev = first;
    for (let i = first + 1; i < arr.length; i++) {
      if (arr[i] !== empty) {
        if (i - prev > 1) {
          const a = arr[prev], b = arr[i], n = i - prev;
          for (let j = prev + 1; j < i; j++) arr[j] = a + (b - a) * (j - prev) / n;
        }
        prev = i;
      }
    }
    for (let i = prev + 1; i < arr.length; i++) arr[i] = arr[prev];
  };
  fillArr(medMinY, Infinity);
  fillArr(medMaxY, -Infinity);

  // Gaussian smoothing: sigma = 4% of bin count (eliminates jagged noise)
  const sigma = Math.max(5, Math.round(nBins * 0.06));
  const smMinY = gaussianSmoothArr(medMinY, Infinity,   sigma);
  const smMaxY = gaussianSmoothArr(medMaxY, -Infinity,  sigma);

  // Blade edge = smMaxY (lower edge in rotated frame).
  // When a knife is photographed in normal orientation (cutting edge facing down),
  // the cutting edge is always the lower silhouette → smMaxY.
  const bladeArr = smMaxY;
  const emptyVal  = -Infinity;

  // Y at heel (junction) as y=0 reference for CSV
  const heelBin = Math.max(0, Math.min(nBins - 1, Math.round((juncX_rot - bladeMinX) / binPx)));
  const heelY   = bladeArr[heelBin] !== emptyVal ? bladeArr[heelBin] : 0;

  // Resample at exactly 0.1mm intervals using linear interpolation
  const stepPx = 0.1 * ppm;
  const pts = [];
  for (let xOff = 0; xOff <= bladeRange; xOff += stepPx) {
    const fracBin = xOff / binPx;
    const b0 = Math.min(Math.floor(fracBin), nBins - 1);
    const b1 = Math.min(b0 + 1, nBins - 1);
    const t  = fracBin - Math.floor(fracBin);
    const v0 = bladeArr[b0], v1 = bladeArr[b1];
    if (v0 === emptyVal || v1 === emptyVal) continue;
    const yRot = v0 * (1 - t) + v1 * t;
    const xRot = bladeMinX + xOff;

    const distPx = tipSide === 'left' ? (juncX_rot - xRot) : (xRot - juncX_rot);
    const xMm = distPx / ppm;
    const yMm = (yRot - heelY) / ppm;

    const imgX = cosA * xRot - sinA * yRot + cx;
    const imgY = sinA * xRot + cosA * yRot + cy;
    pts.push({ xMm, yMm, imgX, imgY });
  }

  return pts.sort((a, b) => a.xMm - b.xMm);
}

function bladeDotCount(pts) {
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const dotStep = Math.max(1, Math.round(intervalMm / 0.1));
  return Math.floor(pts.length / dotStep);
}

function drawBladeEdgeCurve(pts) {
  if (pts.length < 2) return;
  const ctx = elems.annotatedCanvas.getContext('2d');
  // 高解像度写真でも見えるよう画像サイズに合わせてスケール
  const scale = Math.max(elems.annotatedCanvas.width, elems.annotatedCanvas.height) / 1000;
  const lw   = Math.max(3, Math.round(4 * scale));
  const mr   = Math.max(4, Math.round(5 * scale));
  const blur = Math.max(8, Math.round(12 * scale));
  ctx.save();
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur = blur;
  ctx.beginPath();
  ctx.moveTo(pts[0].imgX, pts[0].imgY);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].imgX, pts[i].imgY);
  ctx.stroke();
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const dotStep = Math.max(1, Math.round(intervalMm / 0.1));
  ctx.fillStyle = '#00ffff';
  ctx.shadowBlur = 0;
  pts.forEach((p, i) => {
    if (i % dotStep === 0) {
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, mr, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.restore();
}

function exportBladeEdgeCsv(pts) {
  const rows = pts.map(p => `${p.xMm.toFixed(2)},${p.yMm.toFixed(2)}`);
  const csv = ['x_mm,y_mm', ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blade-curve-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  log(`刃渡り曲線CSV出力: ${pts.length}点`, 'info');
}

elems.btnBladeCurve.addEventListener('click', () => {
  const pts = extractBladeEdgeCurve();
  if (!pts || pts.length === 0) {
    log('刃渡り曲線を抽出できませんでした', 'warn');
    if (elems.bladeCurveStatus) {
      elems.bladeCurveStatus.textContent = '⚠ 抽出失敗';
      elems.bladeCurveStatus.classList.remove('hidden');
    }
    return;
  }
  state.lastBladeCurvePts = pts;
  drawBladeEdgeCurve(pts);
  exportBladeEdgeCsv(pts);
  if (elems.bladeCurveStatus) {
    elems.bladeCurveStatus.textContent = `✓ 刃渡り曲線描画済み (${bladeDotCount(pts)}点)`;
    elems.bladeCurveStatus.classList.remove('hidden');
  }
  log(`刃渡り曲線描画: ${bladeDotCount(pts)}点`, 'detect');
});

elems.bladeDotInterval?.addEventListener('input', () => {
  if (!state.lastBladeCurvePts || !state.lastCanvas) return;
  drawAnnotatedResult(state.lastCanvas, state.lastRectPts, state.lastBladeResult, state.calibPixelsPerMm);
  drawBladeEdgeCurve(state.lastBladeCurvePts);
  if (elems.bladeCurveStatus) {
    elems.bladeCurveStatus.textContent = `✓ 刃渡り曲線描画済み (${bladeDotCount(state.lastBladeCurvePts)}点)`;
  }
});

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
  exitManualModeQuiet();
  clearOverlay();
  state.calibPixelsPerMm = null;
  state.lastContourPts = null;
  state.lastRect = null;
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
  if (elems.bladeCurveStatus) elems.bladeCurveStatus.classList.add('hidden');
  updateBladeCurveBtn();
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

// バージョン情報取得
fetch('version.json')
  .then(r => r.json())
  .then(v => {
    if (elems.versionInfo) {
      const note = v.note ? `  ${v.note}` : '';
      elems.versionInfo.textContent = `v${v.version}${note}  ${v.date}`;
    }
  })
  .catch(() => {});
