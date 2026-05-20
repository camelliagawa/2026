'use strict';

// クレジットカード長辺寸法（ISO/IEC 7810 ID-1規格: 85.60 × 53.98 mm）
// 校正の基準値として全コードで統一使用する
const CARD_LONG_MM = 85.6;

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
  lastCanvas: null,
  lastRectPts: null,
  lastBladeResult: null,
  lastKnifeMetrics: null,
  lastContourPts: null,
  lastRect: null,
  lastBladeCurvePts: null,
  edgeCanvasImageData: null,
  manualBlade: { step: 0, ago: null, kissaki: null, dragging: null },
  // step: 0=inactive 1=awaiting ago 2=awaiting kissaki 3=both placed (drag enabled)
  edgeCardCalib: { step: 0, pts: [], dragging: null },
  // step: 0=inactive 1=awaiting p1 2=awaiting p2 3=awaiting p3 4=done(drag enabled)
  params: {
    cannyLow: 50,
    cannyHigh: 150,
    minArea: 2000,
    noiseMinArea: 0,
    dotRadius: 5,
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
  noiseMinArea:       $('noise-min-area'),
  noiseMinAreaVal:    $('noise-min-area-val'),
  dotRadius:          $('dot-radius'),
  dotRadiusVal:       $('dot-radius-val'),
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
  resCurveLength:     $('res-curve-length'),
  unitCurveLength:    $('unit-curve-length'),
  resTotalLength:     $('res-total-length'),
  unitTotalLength:    $('unit-total-length'),
  resBladeWidth:      $('res-blade-width'),
  unitBladeWidth:     $('unit-blade-width'),
  resBbox:            $('res-bbox'),
  unitBbox:           $('unit-bbox'),
  resAngle:           $('res-angle'),
  resCalib:           $('res-calib'),
  opencvStatus:       $('opencv-status'),
  annotatedCanvas:         $('annotated-canvas'),
  resultImageBox:          $('result-image-box'),
  resultProcessedCanvas:   $('result-processed-canvas'),
  resultProcessedImageBox: $('processed-image-box'),
  btnBladeCurve:      $('btn-blade-curve'),
  bladeCurveStatus:   $('blade-curve-status'),
  bladeDotInterval:       $('blade-dot-interval'),
  videoContainer:         $('video-container'),
  btnManualBlade:         $('btn-manual-blade'),
  btnManualBladeReset:    $('btn-manual-blade-reset'),
  manualBladeHint:        $('manual-blade-hint'),
  btnEdgeCardCalib:       $('btn-edge-card-calib'),
  btnEdgeCardCalibReset:  $('btn-edge-card-calib-reset'),
  edgeCalibHint:          $('edge-calib-hint'),
  versionInfo:            $('version-info'),
  historyBody:        $('history-body'),
  btnClearHistory:    $('btn-clear-history'),
  btnExportCsv:       $('btn-export-csv'),
  logOutput:          $('log-output'),
  detectionConfirm:   $('detection-confirm'),
  btnConfirmOk:       $('btn-confirm-ok'),
  btnConfirmRetry:    $('btn-confirm-retry'),
  confirmSummary:     $('confirm-summary'),
  bladePreviewModal:       $('blade-preview-modal'),
  bladePreviewCanvas:      $('blade-preview-canvas'),
  bladePreviewInfo:        $('blade-preview-info'),
  bladeYConst:             $('blade-y-const'),
  btnBladePreviewCancel:   $('btn-blade-preview-cancel'),
  btnBladePreviewOk:       $('btn-blade-preview-ok'),
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

    elems.videoContainer.style.display = 'block';
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
  elems.videoContainer.style.display = 'none';
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
elems.noiseMinArea.addEventListener('input', () => {
  state.params.noiseMinArea = +elems.noiseMinArea.value;
  elems.noiseMinAreaVal.textContent = elems.noiseMinArea.value;
  // Re-run detection to apply new noise threshold
  if (state.lastCanvas) detectKnifeOnCanvas(state.lastCanvas, false);
});
elems.dotRadius.addEventListener('input', () => {
  state.params.dotRadius = +elems.dotRadius.value;
  elems.dotRadiusVal.textContent = elems.dotRadius.value;
  // Redraw blade curve with new dot size
  if (state.manualBlade.ago && state.manualBlade.kissaki) redrawManualBladeOverlay();
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
    const typeName = calRef.type === 'card' ? `クレジットカード (${CARD_LONG_MM}mm)` : '500円硬貨 (26.5mm)';
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
    // カード長辺ラベルは精度上の理由で非表示
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

        // クレジットカード: アスペクト比 ~1.586 (CARD_LONG_MM=85.6mm / 54mm)、矩形
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
                pixelsPerMm: rw / CARD_LONG_MM,
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

  let src, gray, blurred, edges, edgesDisplay, contours, hierarchy, result;

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

    // Clone edges before findContours — OpenCV.js clears the source Mat during findContours.
    edgesDisplay = edges.clone();
    // Remove small noise components (background texture dots) by zeroing their pixels.
    if (state.params.noiseMinArea > 0) {
      const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
      cv.connectedComponentsWithStats(edgesDisplay, labels, stats, centroids, 8, cv.CV_32S);
      centroids.delete();
      const keepLabels = new Set();
      for (let i = 1; i < stats.rows; i++) {
        if (stats.intAt(i, cv.CC_STAT_AREA) >= state.params.noiseMinArea) keepLabels.add(i);
      }
      stats.delete();
      const labelsArr = labels.data32S;
      const edgesArr = edgesDisplay.data;
      for (let px = 0; px < labelsArr.length; px++) {
        if (!keepLabels.has(labelsArr[px])) edgesArr[px] = 0;
      }
      labels.delete();
    }
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    result = new cv.Mat();
    if (state.params.showEdges) {
      cv.cvtColor(edgesDisplay, result, cv.COLOR_GRAY2RGBA);
    } else {
      src.copyTo(result);
    }

    if (state.params.showEdges) {
      cv.imshow(elems.processedCanvas, result);
    }
    if (elems.resultProcessedCanvas && elems.resultProcessedImageBox && edgesDisplay) {
      const edgeRgba = new cv.Mat();
      cv.cvtColor(edgesDisplay, edgeRgba, cv.COLOR_GRAY2RGBA);
      cv.imshow(elems.resultProcessedCanvas, edgeRgba);
      edgeRgba.delete();
      // Cache the clean edge image for manual selection snap/trace/redraw
      const ec = elems.resultProcessedCanvas;
      state.edgeCanvasImageData = ec.getContext('2d').getImageData(0, 0, ec.width, ec.height);
      elems.resultProcessedImageBox.classList.remove('hidden');
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
      bestContour.delete();
    } else {
      updateStatus('包丁未検出');
      if (saveResult) log('包丁を検出できませんでした。パラメータを調整してください。', 'warn');
    }

    elems.btnSaveImage.disabled = false;

  } catch (err) {
    log(`検出エラー: ${err.message || err}`, 'error');
  } finally {
    [src, gray, blurred, edges, edgesDisplay, contours, hierarchy, result].forEach(m => {
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

  // 刃渡り・柄・刃元マーカーは精度上の理由で非表示

  elems.resultImageBox.classList.remove('hidden');
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

  const junctionBin = detectJuncBin(smoothed, maxY, maxBin, tipSide, BINS);

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
  }
}

// =====================================================================
// 検出確認ダイアログ
// =====================================================================
function showDetectionConfirm(result) {
  state.pendingResult = result;
  elems.confirmSummary.textContent = '';
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
  if (elems.resultProcessedImageBox) elems.resultProcessedImageBox.classList.add('hidden');
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
    elems.btnBladeCurve.disabled = !state.lastBladeCurvePts;
  }
}

function detectJuncBin(wSmoothed, bottomEdge, maxBin, tipSide, BINS) {
  const globalMaxW = wSmoothed[maxBin];
  if (globalMaxW === 0) return maxBin;

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

  // Estimate handle bottom Y from the handle-end zone (farthest 20% from blade).
  // Use the minimum maxY in that zone to get the "purest" handle level (avoids bolster).
  let handleY = Infinity, handleN = 0;
  if (tipSide === 'right') {
    for (let i = 0; i < skip; i++) {
      const v = bottomEdge[i];
      if (v !== Infinity && v !== -Infinity) { if (v < handleY) handleY = v; handleN++; }
    }
  } else {
    for (let i = BINS - skip; i < BINS; i++) {
      const v = bottomEdge[i];
      if (v !== Infinity && v !== -Infinity) { if (v < handleY) handleY = v; handleN++; }
    }
  }
  if (handleN === 0) return tipSide === 'right' ? bladeMaxBin : bladeMaxBin;

  // Cutting edge Y at blade heel — the reference depth of the blade cutting edge.
  const heelY = bottomEdge[bladeMaxBin];
  if (heelY === Infinity || heelY === -Infinity) return bladeMaxBin;
  const stepHeight = heelY - handleY;

  // If no significant step exists, fall back to bladeMaxBin.
  if (stepHeight <= 0) return bladeMaxBin;

  // アゴ = first bin (scanning from handle toward blade) where the bottom edge
  // exceeds the handle level by 50% of the total handle→heel step.
  // The step at the アゴ is abrupt, so the 50% crossing coincides with the
  // first bin where the cutting edge appears below the handle bottom line.
  const threshold = handleY + stepHeight * 0.50;

  if (tipSide === 'right') {
    for (let i = skip; i <= bladeMaxBin; i++) {
      const v = bottomEdge[i];
      if (v !== Infinity && v !== -Infinity && v > threshold) return i;
    }
    return bladeMaxBin;
  } else {
    for (let i = BINS - 1 - skip; i >= bladeMaxBin; i--) {
      const v = bottomEdge[i];
      if (v !== Infinity && v !== -Infinity && v > threshold) return i;
    }
    return bladeMaxBin;
  }
}

// =====================================================================
// 手動アゴ・切先指定
// =====================================================================

// Snap click/touch to nearest white (edge) pixel using cached clean edge data.
function snapToEdge(canvas, x, y, radius) {
  const W = canvas.width, H = canvas.height;
  const src = state.edgeCanvasImageData;
  if (!src) return { imgX: x, imgY: y };
  const px = src.data;
  let bestDist = radius + 1, bestX = x, bestY = y;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ix = x + dx, iy = y + dy;
      if (ix < 0 || ix >= W || iy < 0 || iy >= H) continue;
      const i = (iy * W + ix) * 4;
      if (px[i] > 64 || px[i + 1] > 64 || px[i + 2] > 64) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; bestX = ix; bestY = iy; }
      }
    }
  }
  return { imgX: bestX, imgY: bestY };
}

// Trace white edge pixels between ago and kissaki, fit quadratic, return pts[].
function traceEdgeBetween(canvas, ago, kissaki) {
  const ppm = state.calibPixelsPerMm;
  const src = state.edgeCanvasImageData;
  if (!ppm || !src) return null;
  const { width: W, height: H } = canvas;
  const px = src.data;
  const isEdge = (ix, iy) => {
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) return false;
    const i = (iy * W + ix) * 4;
    return px[i] > 64 || px[i + 1] > 64 || px[i + 2] > 64;
  };

  const x0 = ago.imgX, y0 = ago.imgY;
  const x1 = kissaki.imgX, y1 = kissaki.imgY;
  const totalDX = x1 - x0, totalDY = y1 - y0;
  const steps = Math.max(Math.abs(totalDX), Math.abs(totalDY), 1);
  const WINDOW = 50;
  const rawPts = [];

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const ex = Math.round(x0 + totalDX * t);
    const ey = Math.round(y0 + totalDY * t);
    let bestY = ey, bestDist = WINDOW + 1;
    for (let r = 0; r <= WINDOW; r++) {
      if (isEdge(ex, ey - r) && r < bestDist) { bestY = ey - r; bestDist = r; }
      if (r > 0 && isEdge(ex, ey + r) && r < bestDist) { bestY = ey + r; bestDist = r; }
    }
    if (rawPts.length === 0 || ex !== rawPts[rawPts.length - 1].imgX) {
      rawPts.push({ imgX: ex, imgY: bestY });
    }
  }
  if (rawPts.length < 4) return null;

  // Quadratic least squares: imgY ≈ a·t² + b·t + c (t∈[0,1])
  const n = rawPts.length;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), y = rawPts[i].imgY, t2 = t * t;
    s0++; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
    r0 += y; r1 += t * y; r2 += t2 * y;
  }
  const M = [[s0, s1, s2, r0], [s1, s2, s3, r1], [s2, s3, s4, r2]];
  for (let col = 0; col < 3; col++) {
    let mr = col;
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[mr][col])) mr = row;
    if (mr !== col) [M[col], M[mr]] = [M[mr], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return rawPts.map((p, i) => ({ imgX: p.imgX, imgY: p.imgY, xMm: i / (n - 1) * Math.abs(totalDX) / ppm, yMm: (p.imgY - y0) / ppm }));
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j];
    }
  }
  const v = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    v[i] = M[i][3];
    for (let j = i + 1; j < 3; j++) v[i] -= M[i][j] * v[j];
    v[i] /= M[i][i];
  }
  const [c, b, a] = v;
  const signX = totalDX >= 0 ? 1 : -1;
  const xSteps = Math.abs(totalDX);
  const out = [];
  for (let s = 0; s <= xSteps; s++) {
    const t = xSteps === 0 ? 0 : s / xSteps;
    const imgX = x0 + signX * s;
    const imgY = Math.round(a * t * t + b * t + c);
    out.push({ imgX, imgY, xMm: s / ppm, yMm: (imgY - y0) / ppm });
  }
  return out.length >= 2 ? out : null;
}

// Restore clean edge image, draw curve + dots, update measurement display.
function redrawManualBladeOverlay() {
  const canvas = elems.resultProcessedCanvas;
  if (!canvas || !state.edgeCanvasImageData) return;
  canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);

  const mb = state.manualBlade;
  // Draw アゴ-only preview dot when step=2 (kissaki not yet placed)
  if (mb.ago && !mb.kissaki) {
    const ctx = canvas.getContext('2d');
    const r = Math.max(3, Math.round(state.params.dotRadius * canvas.width / 1000));
    ctx.save();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mb.ago.imgX, mb.ago.imgY, r + 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff2222'; ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(mb.ago.imgX, mb.ago.imgY, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (state.edgeCardCalib.step === 4) drawEdgeCardCalibOverlay();
    return;
  }
  if (!mb.ago || !mb.kissaki) return;

  const pts = traceEdgeBetween(canvas, mb.ago, mb.kissaki);
  if (!pts || pts.length < 2) return;
  state.lastBladeCurvePts = pts;
  drawBladeEdgeCurve(pts);

  const lenMm = pts[pts.length - 1].xMm;
  const curveMm = calcCurveLengthMm(pts);
  if (elems.resBladeLength) {
    elems.resBladeLength.textContent = lenMm.toFixed(1);
    elems.unitBladeLength.textContent = 'mm';
  }
  if (elems.resCurveLength) {
    elems.resCurveLength.textContent = curveMm !== null ? curveMm.toFixed(1) : '--';
    elems.unitCurveLength.textContent = 'mm';
  }
  if (elems.bladeCurveStatus) {
    const curveStr = curveMm !== null ? ` / 曲線長 ${curveMm.toFixed(1)} mm` : '';
    elems.bladeCurveStatus.textContent = `✓ 手動指定 (${bladeDotCount(pts)}点) ${lenMm.toFixed(1)} mm${curveStr}`;
    elems.bladeCurveStatus.classList.remove('hidden');
  }
  // カード校正が完了済みなら校正オーバーレイをブレード曲線の上に重ねて表示
  if (state.edgeCardCalib.step === 4) drawEdgeCardCalibOverlay();
}

function updateManualBladeHint(text) {
  if (!elems.manualBladeHint) return;
  if (text) {
    elems.manualBladeHint.textContent = text;
    elems.manualBladeHint.classList.remove('hidden');
  } else {
    elems.manualBladeHint.classList.add('hidden');
  }
}

function startManualBladeSelect() {
  // カード校正が進行中なら中断してUIを戻す
  if (state.edgeCardCalib.step >= 1 && state.edgeCardCalib.step <= 3) {
    state.edgeCardCalib = { step: 0, pts: [], dragging: null };
    elems.btnEdgeCardCalib?.classList.remove('hidden');
    elems.btnEdgeCardCalibReset?.classList.add('hidden');
    updateEdgeCalibHint(null);
  }
  state.manualBlade = { step: 1, ago: null, kissaki: null, dragging: null };
  const canvas = elems.resultProcessedCanvas;
  if (canvas && state.edgeCanvasImageData) {
    canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
  }
  canvas?.classList.add('manual-selecting');
  elems.btnManualBlade?.classList.add('hidden');
  elems.btnManualBladeReset?.classList.remove('hidden');
  updateManualBladeHint('① アゴをタップ →');
}

function edgeCanvasCoords(e) {
  const canvas = elems.resultProcessedCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) * canvas.width / rect.width),
    y: Math.round((e.clientY - rect.top) * canvas.height / rect.height),
  };
}

function onEdgePointerDown(e) {
  // step1-3: 校正点をタップで配置
  if (state.edgeCardCalib.step >= 1 && state.edgeCardCalib.step <= 3) {
    handleEdgeCardCalibClick(e);
    return;
  }
  // step4: 校正点をドラッグ（ヒットしなければブレードモードへ通す）
  if (state.edgeCardCalib.step === 4) {
    const ec = state.edgeCardCalib;
    const canvas = elems.resultProcessedCanvas;
    const { x, y } = edgeCanvasCoords(e);
    const HIT_R = Math.max(30, canvas.width / 25);
    for (let i = 0; i < ec.pts.length; i++) {
      const p = ec.pts[i];
      const dx = x - p.imgX, dy = y - p.imgY;
      if (dx * dx + dy * dy <= HIT_R * HIT_R) {
        ec.dragging = i;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    // ヒットなし → ブレードモードへフォールスルー
  }
  const mb = state.manualBlade;
  if (mb.step === 0) return;
  const canvas = elems.resultProcessedCanvas;
  const { x, y } = edgeCanvasCoords(e);

  if (mb.step === 1) {
    mb.ago = snapToEdge(canvas, x, y, 30);
    mb.step = 2;
    redrawManualBladeOverlay();
    updateManualBladeHint('② 切先をタップ →');
    return;
  }

  if (mb.step === 2) {
    mb.kissaki = snapToEdge(canvas, x, y, 30);
    mb.step = 3;
    canvas.classList.remove('manual-selecting');
    elems.btnManualBlade?.classList.remove('hidden');
    redrawManualBladeOverlay();
    updateManualBladeHint('完了 ✓　赤丸をドラッグして調整できます');
    const _curvePts = state.lastBladeCurvePts;
    const _curveLen = _curvePts ? calcCurveLengthMm(_curvePts) : null;
    log(`手動刃渡り曲線: 水平 ${_curvePts ? _curvePts[_curvePts.length-1].xMm.toFixed(1) : '?'} mm / 曲線長 ${_curveLen !== null ? _curveLen.toFixed(1) : '?'} mm`, 'detect');
    updateBladeCurveBtn();
    return;
  }

  if (mb.step === 3) {
    const HIT_R = Math.max(30, canvas.width / 25);
    const checkDot = (dot, name) => {
      if (!dot) return false;
      const dx = x - dot.imgX, dy = y - dot.imgY;
      if (dx * dx + dy * dy <= HIT_R * HIT_R) {
        mb.dragging = name;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return true;
      }
      return false;
    };
    checkDot(mb.ago, 'ago') || checkDot(mb.kissaki, 'kissaki');
  }
}

function onEdgePointerMove(e) {
  // カード校正点ドラッグ
  if (state.edgeCardCalib.dragging !== null) {
    e.preventDefault();
    const ec = state.edgeCardCalib;
    const canvas = elems.resultProcessedCanvas;
    const { x, y } = edgeCanvasCoords(e);
    ec.pts[ec.dragging] = snapToEdge(canvas, x, y, 40);
    applyEdgeCardCalib(true);
    return;
  }
  // ブレード点ドラッグ
  const mb = state.manualBlade;
  if (!mb.dragging) return;
  e.preventDefault();
  const canvas = elems.resultProcessedCanvas;
  const { x, y } = edgeCanvasCoords(e);
  const snapped = snapToEdge(canvas, x, y, 40);
  if (mb.dragging === 'ago') mb.ago = snapped;
  else mb.kissaki = snapped;
  redrawManualBladeOverlay();
}

function onEdgePointerUp() {
  state.manualBlade.dragging = null;
  // カード校正ドラッグ終了 → 曲線を最終再計算
  if (state.edgeCardCalib.dragging !== null) {
    state.edgeCardCalib.dragging = null;
    applyEdgeCardCalib(false);
  }
}

// =====================================================================
// エッジ画像でのカード短辺3点校正
// =====================================================================

function perpendicularFoot(p1, p2, p3) {
  const dx = p2.imgX - p1.imgX, dy = p2.imgY - p1.imgY;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { x: p1.imgX, y: p1.imgY };
  const t = ((p3.imgX - p1.imgX) * dx + (p3.imgY - p1.imgY) * dy) / len2;
  return { x: p1.imgX + t * dx, y: p1.imgY + t * dy };
}

function updateEdgeCalibHint(text) {
  if (!elems.edgeCalibHint) return;
  if (text) {
    elems.edgeCalibHint.textContent = text;
    elems.edgeCalibHint.classList.remove('hidden');
  } else {
    elems.edgeCalibHint.classList.add('hidden');
  }
}

function drawEdgeCardCalibOverlay() {
  const canvas = elems.resultProcessedCanvas;
  if (!canvas) return;
  const ec = state.edgeCardCalib;
  if (!ec.pts.length) return;
  const ctx = canvas.getContext('2d');
  const scale  = Math.max(canvas.width, canvas.height) / 1000;
  const r      = Math.max(6,  Math.round(8  * scale));
  const lw     = Math.max(2,  Math.round(3  * scale));
  const fs     = Math.max(20, Math.round(26 * scale));
  const dash   = Math.round(8 * scale);
  const gap    = Math.round(5 * scale);
  const ext    = Math.max(canvas.width, canvas.height) * 2; // 延長用

  ctx.save();

  // ─── ①②の直線を延長（破線でキャンバス端まで） ───
  if (ec.pts.length >= 2) {
    const [p1, p2] = ec.pts;
    const dx = p2.imgX - p1.imgX, dy = p2.imgY - p1.imgY;
    const lineLen = Math.hypot(dx, dy);
    if (lineLen > 0) {
      const ux = dx / lineLen, uy = dy / lineLen;
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = lw;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([dash, gap]);
      ctx.shadowColor = '#ffff00';
      ctx.shadowBlur = Math.max(4, Math.round(6 * scale));
      ctx.beginPath();
      ctx.moveTo(p1.imgX - ux * ext, p1.imgY - uy * ext);
      ctx.lineTo(p1.imgX + ux * ext, p1.imgY + uy * ext);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // ─── 点 ①②③ を描画 ───
  const labels    = ['①', '②', '③'];
  const ptColors  = ['#ffff00', '#ffff00', '#ff8800'];
  ec.pts.forEach((p, i) => {
    const col = ptColors[i];
    ctx.shadowColor = col;
    ctx.shadowBlur  = Math.max(8, Math.round(10 * scale));
    ctx.fillStyle   = col;
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = lw;
    ctx.beginPath();
    ctx.arc(p.imgX, p.imgY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    // ラベル
    ctx.font        = `bold ${fs}px sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.lineWidth   = Math.max(3, Math.round(4 * scale));
    ctx.strokeStyle = '#000';
    ctx.strokeText(labels[i], p.imgX + r + 2, p.imgY - 2);
    ctx.fillStyle = col;
    ctx.fillText(labels[i],   p.imgX + r + 2, p.imgY - 2);
  });

  // ─── ③から①②直線への垂線 + 直角マーク + ラベル ───
  if (ec.pts.length >= 3) {
    const [p1, p2, p3] = ec.pts;
    const foot    = perpendicularFoot(p1, p2, p3);
    const distPx  = Math.hypot(p3.imgX - foot.x, p3.imgY - foot.y);
    const ppm     = distPx / CARD_LONG_MM;

    // 垂線本体（③ → 足）
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth   = lw + 1;
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur  = Math.max(6, Math.round(8 * scale));
    ctx.beginPath();
    ctx.moveTo(p3.imgX, p3.imgY);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 垂線の足マーカー
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(foot.x, foot.y, r * 0.65, 0, Math.PI * 2);
    ctx.fill();

    // 直角マーク（足の部分に小さな四角）
    const perpLen = Math.hypot(p3.imgX - foot.x, p3.imgY - foot.y);
    if (perpLen > 1) {
      // ①②方向の単位ベクトル
      const lineLen = Math.hypot(p2.imgX - p1.imgX, p2.imgY - p1.imgY);
      const u1x = (p2.imgX - p1.imgX) / lineLen;
      const u1y = (p2.imgY - p1.imgY) / lineLen;
      // ③方向の単位ベクトル（足→③）
      const u2x = (p3.imgX - foot.x) / perpLen;
      const u2y = (p3.imgY - foot.y) / perpLen;
      const m   = Math.max(8, Math.round(10 * scale));
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth   = lw;
      ctx.beginPath();
      ctx.moveTo(foot.x + u1x * m,             foot.y + u1y * m);
      ctx.lineTo(foot.x + u1x * m + u2x * m,   foot.y + u1y * m + u2y * m);
      ctx.lineTo(foot.x + u2x * m,              foot.y + u2y * m);
      ctx.stroke();
    }

    // 校正値ラベル（垂線の中点、①②方向にオフセット）
    const midX   = (p3.imgX + foot.x) / 2;
    const midY   = (p3.imgY + foot.y) / 2;
    const label  = `${CARD_LONG_MM}mm = ${ppm.toFixed(2)} px/mm`;
    // ①②に平行な方向（垂線に直交）にラベルをずらす
    if (perpLen > 1 && ec.pts.length >= 2) {
      const lineLen2 = Math.hypot(p2.imgX - p1.imgX, p2.imgY - p1.imgY);
      const nx =  (p2.imgX - p1.imgX) / lineLen2;  // ①②方向
      const ny =  (p2.imgY - p1.imgY) / lineLen2;
      const labelOff = fs * 0.9;
      ctx.font        = `bold ${fs}px sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth   = Math.max(3, Math.round(4 * scale));
      ctx.strokeStyle = '#000';
      ctx.strokeText(label, midX + nx * labelOff, midY + ny * labelOff);
      ctx.fillStyle   = '#00ff88';
      ctx.fillText(label,   midX + nx * labelOff, midY + ny * labelOff);
      ctx.textAlign = 'left';
    }
  }

  ctx.restore();
}

function startEdgeCardCalib() {
  // ブレードモードが選択中なら中断
  if (state.manualBlade.step >= 1 && state.manualBlade.step <= 2) {
    state.manualBlade = { step: 0, ago: null, kissaki: null, dragging: null };
    elems.resultProcessedCanvas?.classList.remove('manual-selecting');
    elems.btnManualBlade?.classList.remove('hidden');
    elems.btnManualBladeReset?.classList.add('hidden');
    updateManualBladeHint(null);
  }
  state.edgeCardCalib = { step: 1, pts: [], dragging: null };
  const canvas = elems.resultProcessedCanvas;
  if (canvas && state.edgeCanvasImageData) {
    canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
  }
  elems.btnEdgeCardCalib?.classList.add('hidden');
  elems.btnEdgeCardCalibReset?.classList.remove('hidden');
  updateEdgeCalibHint('① カード短辺の1点目をタップ →');
}

function handleEdgeCardCalibClick(e) {
  const ec = state.edgeCardCalib;
  const canvas = elems.resultProcessedCanvas;
  const { x, y } = edgeCanvasCoords(e);
  const snapped = snapToEdge(canvas, x, y, 30);

  if (ec.step === 1) {
    ec.pts = [snapped];
    ec.step = 2;
    canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
    drawEdgeCardCalibOverlay();
    updateEdgeCalibHint('② 同じ短辺の2点目をタップ →');
    return;
  }

  if (ec.step === 2) {
    ec.pts.push(snapped);
    ec.step = 3;
    canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
    drawEdgeCardCalibOverlay();
    updateEdgeCalibHint('③ 反対側の短辺をタップ →');
    return;
  }

  if (ec.step === 3) {
    ec.pts.push(snapped);
    const [p1, p2, p3] = ec.pts;
    const foot = perpendicularFoot(p1, p2, p3);
    const distPx = Math.hypot(p3.imgX - foot.x, p3.imgY - foot.y);
    if (distPx < 20) {
      log('3点が近すぎます。やり直してください。', 'warn');
      updateEdgeCalibHint('⚠ 点が近すぎます — やり直してください');
      ec.step = 1; ec.pts = [];
      canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
      return;
    }
    ec.step = 4;
    applyEdgeCardCalib(false);
  }
}

// 校正計算・UI更新・再描画の共通処理
// isDragging=true: ドラッグ中（軽量再描画）/ false: 確定（完全再計算）
function applyEdgeCardCalib(isDragging) {
  const ec = state.edgeCardCalib;
  if (ec.pts.length < 3) return;
  const [p1, p2, p3] = ec.pts;
  const foot    = perpendicularFoot(p1, p2, p3);
  const distPx  = Math.hypot(p3.imgX - foot.x, p3.imgY - foot.y);
  if (distPx < 20) return;

  const newPpm = distPx / CARD_LONG_MM;
  state.calibPixelsPerMm = newPpm;
  if (elems.resCalib)    elems.resCalib.textContent    = newPpm.toFixed(2);
  if (elems.calibStatus) elems.calibStatus.textContent = `エッジカード3点校正: ${newPpm.toFixed(2)} px/mm`;
  updateEdgeCalibHint(`完了 ✓  ${newPpm.toFixed(2)} px/mm — 点をドラッグして調整できます`);

  const canvas = elems.resultProcessedCanvas;
  if (state.manualBlade.ago && state.manualBlade.kissaki) {
    if (isDragging) {
      // ドラッグ中: エッジ復元 + 既存曲線を高速再描画（再トレースしない）
      canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
      if (state.lastBladeCurvePts) drawBladeEdgeCurve(state.lastBladeCurvePts);
    } else {
      // 確定時: 新校正値で曲線を完全再計算
      redrawManualBladeOverlay();
    }
  } else {
    canvas.getContext('2d').putImageData(state.edgeCanvasImageData, 0, 0);
  }
  drawEdgeCardCalibOverlay();

  if (!isDragging) {
    log(`エッジカード3点校正完了: ${newPpm.toFixed(2)} px/mm (${distPx.toFixed(0)} px = ${CARD_LONG_MM} mm)`, 'detect');
  }
}


function calcCurveLengthMm(pts) {
  const ppm = state.calibPixelsPerMm;
  if (!pts || pts.length < 2 || !ppm) return null;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].imgX - pts[i - 1].imgX;
    const dy = pts[i].imgY - pts[i - 1].imgY;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total / ppm;
}

function sampleByMm(pts, intervalMm) {
  if (!pts || pts.length === 0) return [];
  const out = [pts[0]];
  let lastMm = pts[0].xMm;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].xMm - lastMm >= intervalMm) {
      out.push(pts[i]);
      lastMm = pts[i].xMm;
    }
  }
  return out;
}

function bladeDotCount(pts) {
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  return sampleByMm(pts, intervalMm).length;
}

function drawBladeEdgeCurve(pts) {
  if (pts.length < 2) return;
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const dotPts = sampleByMm(pts, intervalMm);

  const drawOn = (canvas) => {
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(canvas.width, canvas.height) / 1000;
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
    ctx.fillStyle = '#00ffff';
    ctx.shadowBlur = 0;
    dotPts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, mr, 0, Math.PI * 2);
      ctx.fill();
    });

    // Red dots at アゴ (first point) and 切先 (last point)
    const endR = Math.max(3, Math.round(state.params.dotRadius * scale));
    const fontSize = Math.max(28, Math.round(32 * scale));
    [[pts[0], 'アゴ'], [pts[pts.length - 1], '切先']].forEach(([p, label]) => {
      // White outline ring for contrast against any background
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(3, Math.round(4 * scale));
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = Math.max(6, Math.round(8 * scale));
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, endR + ctx.lineWidth, 0, Math.PI * 2);
      ctx.stroke();
      // Red fill with glow
      ctx.fillStyle = '#ff2222';
      ctx.shadowColor = '#ff0000';
      ctx.shadowBlur = blur;
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, endR, 0, Math.PI * 2);
      ctx.fill();
      // Label with black outline for readability
      ctx.shadowBlur = 0;
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = Math.max(4, Math.round(5 * scale));
      ctx.strokeStyle = '#000000';
      ctx.strokeText(label, p.imgX + endR + 4, p.imgY - 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, p.imgX + endR + 4, p.imgY - 4);
    });

    ctx.restore();
  };

  if (elems.resultProcessedCanvas && elems.resultProcessedCanvas.width > 0) {
    drawOn(elems.resultProcessedCanvas);
  }
}

function exportBladeEdgeCsv(pts) {
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const sampled = sampleByMm(pts, intervalMm);
  const rows = sampled.map(p => `${p.xMm.toFixed(2)},${p.yMm.toFixed(2)}`);
  const csv = ['x_mm,y_mm', ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blade-curve-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  log(`刃渡り曲線CSV出力: ${sampled.length}点 (${intervalMm}mm間隔)`, 'info');
}

// =====================================================================
// 6列CSV（x y z rx ry rz）プレビュー＆出力
// =====================================================================

function computeBlade6ColData(pts, intervalMm, yConst) {
  const sampled = sampleByMm(pts, intervalMm);
  if (sampled.length < 2) return [];
  return sampled.map((p, i) => {
    const x = p.yMm;
    const z = p.xMm;
    let dx, dz;
    if (i === 0) {
      dx = sampled[1].yMm - sampled[0].yMm;
      dz = sampled[1].xMm - sampled[0].xMm;
    } else if (i === sampled.length - 1) {
      dx = sampled[i].yMm - sampled[i - 1].yMm;
      dz = sampled[i].xMm - sampled[i - 1].xMm;
    } else {
      dx = sampled[i + 1].yMm - sampled[i - 1].yMm;
      dz = sampled[i + 1].xMm - sampled[i - 1].xMm;
    }
    const ds = Math.sqrt(dx * dx + dz * dz);
    const rx = ds > 0 ? dx / ds : 0;
    const rz = ds > 0 ? dz / ds : 1;
    return { x, y: yConst, z, rx, ry: 0, rz };
  });
}

function drawBladeCurvePreview(data) {
  const canvas = elems.bladePreviewCanvas;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1b2e';
  ctx.fillRect(0, 0, W, H);
  if (data.length < 2) return;

  const mg = { left: 46, right: 12, top: 14, bottom: 32 };
  const pw = W - mg.left - mg.right;
  const ph = H - mg.top - mg.bottom;

  const zMin = data[0].z, zMax = data[data.length - 1].z;
  const xs = data.map(d => d.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xPad = (xMax - xMin) * 0.15 || 0.5;
  const zRange = zMax - zMin || 1;
  const xRange = (xMax - xMin + xPad * 2) || 1;

  const cx = z => mg.left + (z - zMin) / zRange * pw;
  const cy = x => mg.top + (1 - (x - (xMin - xPad)) / xRange) * ph;

  // Grid lines
  ctx.strokeStyle = '#1e3050';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = mg.top + ph / 4 * i;
    ctx.beginPath(); ctx.moveTo(mg.left, y); ctx.lineTo(mg.left + pw, y); ctx.stroke();
  }

  // Axes
  ctx.strokeStyle = '#3a5070';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mg.left, mg.top); ctx.lineTo(mg.left, mg.top + ph);
  ctx.lineTo(mg.left + pw, mg.top + ph);
  ctx.stroke();

  // Curve
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    i === 0 ? ctx.moveTo(cx(d.z), cy(d.x)) : ctx.lineTo(cx(d.z), cy(d.x));
  });
  ctx.stroke();

  // Dots
  ctx.fillStyle = '#ff4455';
  data.forEach(d => {
    ctx.beginPath();
    ctx.arc(cx(d.z), cy(d.x), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Axis labels
  ctx.fillStyle = '#7090a0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`z ${zMin.toFixed(0)}`, mg.left, H - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${zMax.toFixed(0)} mm`, mg.left + pw, H - 4);
  ctx.save();
  ctx.translate(10, mg.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('x (mm)', 0, 0);
  ctx.restore();

  // x range annotation
  ctx.fillStyle = '#556677';
  ctx.textAlign = 'right';
  ctx.font = '9px sans-serif';
  ctx.fillText(`${xMin.toFixed(2)}`, mg.left - 2, cy(xMin));
  ctx.fillText(`${xMax.toFixed(2)}`, mg.left - 2, cy(xMax));

  if (elems.bladePreviewInfo) {
    elems.bladePreviewInfo.textContent =
      `${data.length}点  z: ${zMin.toFixed(1)}〜${zMax.toFixed(1)} mm  x: ${xMin.toFixed(3)}〜${xMax.toFixed(3)} mm`;
  }
}

function showBladeCurvePreview(pts) {
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const yConst = parseFloat(elems.bladeYConst?.value) || 30;
  const data = computeBlade6ColData(pts, intervalMm, yConst);
  drawBladeCurvePreview(data);
  elems.bladePreviewModal.classList.remove('hidden');
}

function exportBlade6ColCsv(pts) {
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const yConst = parseFloat(elems.bladeYConst?.value) || 30;
  const data = computeBlade6ColData(pts, intervalMm, yConst);
  const rows = data.map(d =>
    [d.x, d.y, d.z, d.rx, d.ry, d.rz].map(v => v.toFixed(5)).join(',')
  );
  const csv = ['x,y,z,rx,ry,rz', ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blade-6col-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  log(`刃渡り曲線CSV出力(6列): ${data.length}点 (${intervalMm}mm間隔, y=${yConst})`, 'info');
}

elems.btnBladePreviewCancel.addEventListener('click', () => {
  elems.bladePreviewModal.classList.add('hidden');
});

elems.btnBladePreviewOk.addEventListener('click', () => {
  elems.bladePreviewModal.classList.add('hidden');
  exportBlade6ColCsv(state.lastBladeCurvePts);
});

elems.bladeYConst?.addEventListener('input', () => {
  const pts = state.lastBladeCurvePts;
  if (!pts || pts.length === 0) return;
  const intervalMm = parseFloat(elems.bladeDotInterval?.value) || 1;
  const yConst = parseFloat(elems.bladeYConst?.value) || 30;
  drawBladeCurvePreview(computeBlade6ColData(pts, intervalMm, yConst));
});

elems.btnBladeCurve.addEventListener('click', () => {
  const pts = state.lastBladeCurvePts;
  if (!pts || pts.length === 0) {
    log('先にエッジ画像でアゴ・切先を手動指定してください', 'warn');
    if (elems.bladeCurveStatus) {
      elems.bladeCurveStatus.textContent = '⚠ 曲線未指定';
      elems.bladeCurveStatus.classList.remove('hidden');
    }
    return;
  }
  showBladeCurvePreview(pts);
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
// 手動アゴ・切先指定 イベント
// =====================================================================
elems.btnManualBlade?.addEventListener('click', startManualBladeSelect);
elems.btnManualBladeReset?.addEventListener('click', startManualBladeSelect); // reset = restart from step 1
elems.btnEdgeCardCalib?.addEventListener('click', startEdgeCardCalib);
elems.btnEdgeCardCalibReset?.addEventListener('click', startEdgeCardCalib); // reset = restart from step 1
elems.resultProcessedCanvas?.addEventListener('pointerdown', onEdgePointerDown);
elems.resultProcessedCanvas?.addEventListener('pointermove', onEdgePointerMove, { passive: false });
elems.resultProcessedCanvas?.addEventListener('pointerup', onEdgePointerUp);
elems.resultProcessedCanvas?.addEventListener('pointercancel', onEdgePointerUp);

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
  state.manualBlade = { step: 0, ago: null, kissaki: null, dragging: null };
  state.edgeCardCalib = { step: 0, pts: [] };
  state.edgeCanvasImageData = null;
  elems.resultProcessedCanvas?.classList.remove('manual-selecting');
  elems.btnManualBlade?.classList.remove('hidden');
  elems.btnManualBladeReset?.classList.add('hidden');
  updateManualBladeHint(null);
  elems.btnEdgeCardCalib?.classList.remove('hidden');
  elems.btnEdgeCardCalibReset?.classList.add('hidden');
  updateEdgeCalibHint(null);
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
  if (elems.resCurveLength) elems.resCurveLength.textContent = '--';
  if (elems.unitCurveLength) elems.unitCurveLength.textContent = 'mm';
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
  if (elems.resultProcessedImageBox) elems.resultProcessedImageBox.classList.add('hidden');
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
