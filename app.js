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
  history: [],
  pendingResult: null,
  lastCanvas: null,
  lastRectPts: null,
  lastBladeResult: null,
  lastKnifeMetrics: null,
  lastBladeCurvePts: null,
  bladeEqualScale: true,
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
  historyBody:        $('history-body'),
  btnClearHistory:    $('btn-clear-history'),
  btnExportCsv:       $('btn-export-csv'),
  logOutput:          $('log-output'),
  detectionConfirm:   $('detection-confirm'),
  btnConfirmOk:       $('btn-confirm-ok'),
  btnConfirmRetry:    $('btn-confirm-retry'),
  confirmSummary:     $('confirm-summary'),
  bladePreviewSection:     $('blade-preview-section'),
  bladePreviewCanvas:      $('blade-preview-canvas'),
  bladePreviewInfo:        $('blade-preview-info'),
  bladeXConst:             $('blade-x-const'),
  btnBladePreviewOk:       $('btn-blade-preview-ok'),
  btnScaleEqual:           $('btn-scale-equal'),
  btnScaleAuto:            $('btn-scale-auto'),
  savedImageHint:          $('saved-image-hint'),
  btnReloadLast:           $('btn-reload-last'),
  btnDownloadSaved:        $('btn-download-saved'),
  dragOverlay:             $('drag-overlay'),
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
// 直前画像の保存・復元（IndexedDB）
// =====================================================================
const IDB_NAME  = 'knife-app';
const IDB_STORE = 'images';
const IDB_KEY   = 'last';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

async function saveImageBlob(blob) {
  try {
    const buf  = await blob.arrayBuffer();   // BlobをArrayBufferに変換（全環境で確実に保存可能）
    const db   = await openIDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ data: buf, type: blob.type }, IDB_KEY);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
    log('画像をIndexedDBに保存しました', 'info');
  } catch (e) {
    log(`画像の保存に失敗しました: ${e}`, 'warn');
  }
}

async function loadImageBlob() {
  try {
    const db     = await openIDB();
    const stored = await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = e => resolve(e.target.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
    if (!stored) return null;
    return new Blob([stored.data], { type: stored.type });
  } catch (e) {
    log(`保存済み画像の読み込みに失敗しました: ${e}`, 'warn');
    return null;
  }
}

function saveCanvasToIDB(canvas) {
  canvas.toBlob(blob => {
    if (blob) saveImageBlob(blob);
  }, 'image/jpeg', 0.92);
}

function applyBlobToApp(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    elems.overlayCanvas.width  = img.naturalWidth;
    elems.overlayCanvas.height = img.naturalHeight;
    analyzeImage(canvas);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

// =====================================================================
// OpenCV 準備
// =====================================================================
window.onOpenCvReady = () => {
  // onload 時点では WASM のコンパイルが未完了の場合がある（モバイルで顕著）。
  // cv.Mat が使えるか確認し、未完了なら onRuntimeInitialized を待つ。
  function cvInit() {
    state.opencvReady = true;
    log('OpenCV.js 読み込み完了', 'info');
    elems.opencvStatus.textContent = 'OpenCV 準備完了 ✓';
    elems.opencvStatus.className = 'opencv-status opencv-ready';
    if (state.cameraActive) {
      elems.btnCapture.disabled = false;
    }
    initCameraList();
    loadImageBlob().then(blob => {
      if (!blob) return;
      elems.btnReloadLast.classList.remove('hidden');
      elems.btnDownloadSaved.classList.remove('hidden');
      log('前回の画像を自動読み込みしました', 'info');
      elems.savedImageHint.textContent = '前回の画像を自動読み込みしました';
      elems.savedImageHint.classList.remove('hidden');
      applyBlobToApp(blob);
    });
  }
  if (cv.Mat) {
    cvInit();
  } else {
    cv['onRuntimeInitialized'] = cvInit;
  }
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
  if (state.lastCanvas) detectKnifeOnCanvas(state.lastCanvas, false);
});
elems.dotRadius.addEventListener('input', () => {
  state.params.dotRadius = +elems.dotRadius.value;
  elems.dotRadiusVal.textContent = elems.dotRadius.value;
  if (state.manualBlade.ago && state.manualBlade.kissaki) redrawManualBladeOverlay();
});
elems.showEdges.addEventListener('change', () => {
  state.params.showEdges = elems.showEdges.checked;
});
elems.showContours.addEventListener('change', () => {
  state.params.showContours = elems.showContours.checked;
});


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

  elems.processedCanvas.width  = canvas.width;
  elems.processedCanvas.height = canvas.height;
  elems.processedCanvas.getContext('2d').drawImage(canvas, 0, 0);

  const ac = elems.annotatedCanvas;
  ac.width  = canvas.width;
  ac.height = canvas.height;
  ac.getContext('2d').drawImage(canvas, 0, 0);
  elems.resultImageBox.classList.remove('hidden');
  const resultTabBtn = document.querySelector('.tab-btn[data-tab="result"]');
  if (resultTabBtn && window.getComputedStyle(document.getElementById('tab-nav')).display !== 'none') {
    resultTabBtn.click();
  }

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

  detectKnifeOnCanvas(canvas, true);

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
    const text = `500円硬貨 ✓  ${found.pixelsPerMm.toFixed(2)} px/mm`;
    let lx = found.center.x, ly = found.center.y - found.radiusPx - 6;
    ctx.font = 'bold 14px sans-serif';
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(text).width;
    lx = Math.max(4, Math.min(lx, ctx.canvas.width - tw - 8));
    ly = Math.max(20, ly);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(lx - 3, ly - 17, tw + 6, 19);
    ctx.fillStyle = '#ffff00';
    ctx.fillText(text, lx, ly);
  }
  ctx.restore();
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

// =====================================================================
// ファイル→Canvas 変換（HEIC対応）
// =====================================================================

function blobToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像の読み込みに失敗しました')); };
    img.src = url;
  });
}

async function fileToCanvas(file) {
  const isHeic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

  // HEIC以外はそのまま読み込む
  if (!isHeic) return blobToCanvas(file);

  // HEICをまず直接読み込む（macOS Safari等ネイティブ対応環境はここで成功）
  try {
    const canvas = await blobToCanvas(file);
    return canvas;
  } catch (_) { /* ネイティブ非対応 → heic2any へ */ }

  // heic2any で変換（90秒タイムアウト付き）
  if (typeof heic2any === 'undefined') {
    throw new Error('HEIC変換ライブラリの読み込み中です。ページを再読み込みしてお試しください');
  }
  log('HEICファイルをJPEGに変換中...（初回は30秒ほどかかる場合があります）', 'info');
  const heicPromise = heic2any({ blob: file, toType: 'image/jpeg', quality: 0.80 })
    .then(r => Array.isArray(r) ? r[0] : r);
  const timeoutPromise = new Promise((_, reject) => setTimeout(() =>
    reject(new Error(
      'HEIC変換がタイムアウトしました。\n' +
      '【解決策】Google Driveでファイルを右クリック→「プレビュー」→「ダウンロード」すると' +
      'JPEGで保存されます。そのJPEGを選択してください。'
    )), 90000));
  const blob = await Promise.race([heicPromise, timeoutPromise]);
  log('HEIC→JPEG変換完了', 'info');
  return blobToCanvas(blob);
}

async function handleFileInput(file) {
  let canvas;
  try {
    canvas = await fileToCanvas(file);
  } catch (e) {
    log(e.message, 'error');
    return;
  }
  saveCanvasToIDB(canvas);
  elems.savedImageHint.textContent = '次回起動時に自動読み込みします';
  elems.savedImageHint.classList.remove('hidden');
  elems.btnReloadLast.classList.remove('hidden');
  elems.btnDownloadSaved.classList.remove('hidden');
  if (!state.opencvReady) {
    log('OpenCV未準備のため解析不可。少し待ってから再試行してください。', 'warn');
    return;
  }
  log(`画像読み込み: ${canvas.width}×${canvas.height}`, 'info');
  elems.overlayCanvas.width  = canvas.width;
  elems.overlayCanvas.height = canvas.height;
  analyzeImage(canvas);
}

elems.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';   // 同じファイルを再選択できるようにリセット
  handleFileInput(file);
});

// =====================================================================
// ドラッグ&ドロップ（PC用・ページ全体が対象）
// =====================================================================
let dragCounter = 0;   // enter/leave のネスト対策

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  elems.dragOverlay.classList.remove('hidden');
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    elems.dragOverlay.classList.add('hidden');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  elems.dragOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const isImage = file.type.startsWith('image/') || /\.hei[cf]$/i.test(file.name);
  if (!isImage) { log('画像ファイルをドロップしてください', 'warn'); return; }
  handleFileInput(file);
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

      updateBladeCurveBtn();
      bestContour.delete();
    } else {
      elems.resStatus.textContent = '包丁未検出';
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

// =====================================================================
// 検出確認ダイアログ
// =====================================================================
function showDetectionConfirm(result) {
  state.pendingResult = result;
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
  elems.resStatus.textContent = '待機中';
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
  elems.btnBladeCurve.disabled = !state.lastBladeCurvePts;
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

function updateHint(elem, text) {
  if (!elem) return;
  elem.textContent = text || '';
  elem.classList.toggle('hidden', !text);
}

function updateManualBladeHint(text) { updateHint(elems.manualBladeHint, text); }

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
    const curvePts = state.lastBladeCurvePts;
    const curveLen = curvePts ? calcCurveLengthMm(curvePts) : null;
    log(`手動刃渡り曲線: 水平 ${curvePts ? curvePts[curvePts.length-1].xMm.toFixed(1) : '?'} mm / 曲線長 ${curveLen !== null ? curveLen.toFixed(1) : '?'} mm`, 'detect');
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

function updateEdgeCalibHint(text) { updateHint(elems.edgeCalibHint, text); }

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

    const endR = Math.max(3, Math.round(state.params.dotRadius * scale));
    const fontSize = Math.max(28, Math.round(32 * scale));
    [[pts[0], 'アゴ'], [pts[pts.length - 1], '切先']].forEach(([p, label]) => {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(3, Math.round(4 * scale));
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = Math.max(6, Math.round(8 * scale));
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, endR + ctx.lineWidth, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ff2222';
      ctx.shadowColor = '#ff0000';
      ctx.shadowBlur = blur;
      ctx.beginPath();
      ctx.arc(p.imgX, p.imgY, endR, 0, Math.PI * 2);
      ctx.fill();
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

// =====================================================================
// 6列CSV（x y z rx ry rz）プレビュー＆出力
// =====================================================================

function getBladeParams() {
  return {
    intervalMm: parseFloat(elems.bladeDotInterval?.value) || 1,
    xConst: parseFloat(elems.bladeXConst?.value) || 0,
  };
}

function computeBlade6ColData(pts, intervalMm, xConst) {
  const sampled = sampleByMm(pts, intervalMm);
  if (sampled.length < 2) return [];
  return sampled.map((p, i) => {
    const y = p.xMm;
    const z = -p.yMm;
    let dy, dz;
    if (i === 0) {
      dy = sampled[1].xMm - sampled[0].xMm;
      dz = -(sampled[1].yMm - sampled[0].yMm);
    } else if (i === sampled.length - 1) {
      dy = sampled[i].xMm - sampled[i - 1].xMm;
      dz = -(sampled[i].yMm - sampled[i - 1].yMm);
    } else {
      dy = sampled[i + 1].xMm - sampled[i - 1].xMm;
      dz = -(sampled[i + 1].yMm - sampled[i - 1].yMm);
    }
    const ds = Math.sqrt(dy * dy + dz * dz);
    const ry = ds > 0 ? dy / ds : 1;
    const rz = ds > 0 ? dz / ds : 0;
    return { x: xConst, y, z, rx: 0, ry, rz };
  });
}

function drawBladeCurvePreview(data) {
  const canvas = elems.bladePreviewCanvas;
  // 表示幅に合わせてcanvasの解像度を設定（CSS width:100% に追従）
  const W = canvas.offsetWidth || 300;
  const H = Math.round(W * 190 / 300);
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1b2e';
  ctx.fillRect(0, 0, W, H);
  if (data.length < 2) return;

  const mg = { left: 46, right: 12, top: 14, bottom: 32 };
  const pw = W - mg.left - mg.right;
  const ph = H - mg.top - mg.bottom;

  const yMin = data[0].y, yMax = data[data.length - 1].y;
  const zVals = data.map(d => d.z);
  const zMin = Math.min(...zVals), zMax = Math.max(...zVals);
  const zPad = (zMax - zMin) * 0.15 || 0.5;
  const yRange = yMax - yMin || 1;
  const zRangePadded = (zMax - zMin + zPad * 2) || 1;

  let cx, cy;
  if (state.bladeEqualScale) {
    const pxPerMm = Math.min(pw / yRange, ph / zRangePadded);
    const offY = (pw - yRange * pxPerMm) / 2;
    const offZ = (ph - zRangePadded * pxPerMm) / 2;
    cx = y => mg.left + offY + (y - yMin) * pxPerMm;
    cy = z => mg.top + offZ + (z - (zMin - zPad)) * pxPerMm;
  } else {
    cx = y => mg.left + (y - yMin) / yRange * pw;
    cy = z => mg.top + (z - (zMin - zPad)) / zRangePadded * ph;
  }

  ctx.strokeStyle = '#1e3050';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gridY = mg.top + ph / 4 * i;
    ctx.beginPath(); ctx.moveTo(mg.left, gridY); ctx.lineTo(mg.left + pw, gridY); ctx.stroke();
  }

  ctx.strokeStyle = '#3a5070';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mg.left, mg.top); ctx.lineTo(mg.left, mg.top + ph);
  ctx.lineTo(mg.left + pw, mg.top + ph);
  ctx.stroke();

  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    i === 0 ? ctx.moveTo(cx(d.y), cy(d.z)) : ctx.lineTo(cx(d.y), cy(d.z));
  });
  ctx.stroke();

  ctx.fillStyle = '#ff4455';
  data.forEach(d => {
    ctx.beginPath();
    ctx.arc(cx(d.y), cy(d.z), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#7090a0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`y ${yMin.toFixed(0)}`, mg.left, H - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${yMax.toFixed(0)} mm`, mg.left + pw, H - 4);
  ctx.save();
  ctx.translate(10, mg.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('z (mm)', 0, 0);
  ctx.restore();

  ctx.fillStyle = '#556677';
  ctx.textAlign = 'right';
  ctx.font = '9px sans-serif';
  ctx.fillText(`${zMin.toFixed(1)}`, mg.left - 2, cy(zMin));
  ctx.fillText(`${zMax.toFixed(1)}`, mg.left - 2, cy(zMax));

  if (elems.bladePreviewInfo) {
    elems.bladePreviewInfo.textContent =
      `${data.length}点  y: ${yMin.toFixed(1)}〜${yMax.toFixed(1)} mm  z: ${zMin.toFixed(3)}〜${zMax.toFixed(3)} mm`;
  }
}

function showBladeCurvePreview(pts) {
  const { intervalMm, xConst } = getBladeParams();
  drawBladeCurvePreview(computeBlade6ColData(pts, intervalMm, xConst));
  elems.bladePreviewSection.classList.remove('hidden');
  elems.bladePreviewSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function exportBlade6ColCsv(pts) {
  const { intervalMm, xConst } = getBladeParams();
  const data = computeBlade6ColData(pts, intervalMm, xConst);
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
  log(`刃渡り曲線CSV出力(6列): ${data.length}点 (${intervalMm}mm間隔, x=${xConst})`, 'info');
}

elems.btnBladePreviewOk.addEventListener('click', () => {
  exportBlade6ColCsv(state.lastBladeCurvePts);
});

function setBladeScale(equal) {
  state.bladeEqualScale = equal;
  elems.btnScaleEqual?.classList.toggle('scale-btn-active', equal);
  elems.btnScaleAuto?.classList.toggle('scale-btn-active', !equal);
  const pts = state.lastBladeCurvePts;
  if (!pts || pts.length === 0) return;
  const { intervalMm, xConst } = getBladeParams();
  drawBladeCurvePreview(computeBlade6ColData(pts, intervalMm, xConst));
}

elems.btnScaleEqual?.addEventListener('click', () => setBladeScale(true));
elems.btnScaleAuto?.addEventListener('click', () => setBladeScale(false));

elems.bladeXConst?.addEventListener('input', () => {
  const pts = state.lastBladeCurvePts;
  if (!pts || pts.length === 0) return;
  const { intervalMm, xConst } = getBladeParams();
  drawBladeCurvePreview(computeBlade6ColData(pts, intervalMm, xConst));
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
  if (!elems.bladePreviewSection.classList.contains('hidden')) {
    const { intervalMm, xConst } = getBladeParams();
    drawBladeCurvePreview(computeBlade6ColData(state.lastBladeCurvePts, intervalMm, xConst));
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
function resetApp() {
  state.manualBlade       = { step: 0, ago: null, kissaki: null, dragging: null };
  state.edgeCardCalib     = { step: 0, pts: [], dragging: null };
  state.edgeCanvasImageData = null;
  state.calibPixelsPerMm  = null;
  state.lastCanvas        = null;
  state.lastRectPts       = null;
  state.lastBladeResult   = null;
  state.lastKnifeMetrics  = null;
  state.lastBladeCurvePts = null;
  state.history           = [];

  elems.resultProcessedCanvas.classList.remove('manual-selecting');
  elems.btnManualBlade.classList.remove('hidden');
  elems.btnManualBladeReset.classList.add('hidden');
  updateManualBladeHint(null);
  elems.btnEdgeCardCalib.classList.remove('hidden');
  elems.btnEdgeCardCalibReset.classList.add('hidden');
  updateEdgeCalibHint(null);
  clearOverlay();

  elems.historyBody.innerHTML = '';
  elems.calibStatus.textContent = '';
  elems.resCalib.textContent = '未設定';
  elems.resBladeLength.textContent = '--';
  elems.unitBladeLength.textContent = 'mm';
  elems.resCurveLength.textContent = '--';
  elems.unitCurveLength.textContent = 'mm';
  elems.resTotalLength.textContent = '--';
  elems.unitTotalLength.textContent = 'mm';
  elems.resBladeWidth.textContent = '--';
  elems.unitBladeWidth.textContent = 'mm';
  elems.resBbox.textContent = '--';
  elems.unitBbox.textContent = 'mm';
  elems.resAngle.textContent = '--';
  elems.resStatus.textContent = '待機中';
  elems.processedCanvas.getContext('2d').clearRect(0, 0, elems.processedCanvas.width, elems.processedCanvas.height);
  elems.resultImageBox.classList.add('hidden');
  elems.resultProcessedImageBox.classList.add('hidden');
  elems.bladeCurveStatus.classList.add('hidden');
  elems.bladePreviewSection.classList.add('hidden');
  updateBladeCurveBtn();
}

elems.btnReset.addEventListener('click', () => {
  resetApp();
  log('全設定をリセット', 'warn');
});

elems.btnReloadLast.addEventListener('click', () => {
  if (!state.opencvReady) {
    log('OpenCV未準備のため解析不可。少し待ってから再試行してください。', 'warn');
    return;
  }
  loadImageBlob().then(blob => {
    if (!blob) { log('保存済み画像がありません', 'warn'); return; }
    log('前回の画像を再読み込みしました', 'info');
    applyBlobToApp(blob);
  });
});

elems.btnDownloadSaved.addEventListener('click', () => {
  loadImageBlob().then(blob => {
    if (!blob) { log('保存済み画像がありません', 'warn'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'knife-saved.jpg';
    a.click();
    URL.revokeObjectURL(url);
    log('保存済み画像をダウンロードしました', 'info');
  });
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

// =====================================================================
// 3D CSV ビューア（Three.js 動的ロード）
// =====================================================================
;(function () {
  // ---- スロット別カラー定義（slot 0: シアン系 / slot 1: オレンジ系）----
  const COLORS = [
    { line: 0x00e5ff, dot: 0xff4455, arrow: 0x44ff88 },
    { line: 0xff8822, dot: 0xffdd00, arrow: 0xff66cc },
  ];
  const slots = [
    { data: null, name: '', visible: true },
    { data: null, name: '', visible: true },
  ];
  let viewer = null;
  const arrowsChk = document.getElementById('csv3d-show-arrows');

  function loadThree(cb) {
    if (typeof THREE !== 'undefined') { cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = cb;
    s.onerror = () => log('Three.js の読み込みに失敗しました', 'warn');
    document.head.appendChild(s);
  }

  function initViewer() {
    if (viewer) return;
    const wrap   = document.getElementById('csv3d-wrap');
    const canvas = document.getElementById('csv3d-canvas');
    if (!wrap || !canvas) return;

    const W = Math.max(wrap.clientWidth,  10);
    const H = Math.max(wrap.clientHeight, 10);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x0d1b2e);

    const scene = new THREE.Scene();
    scene.add(new THREE.GridHelper(80, 40, 0x1e3050, 0x162440));

    // ---- XYZ 軸（ArrowHelper + HTMLラベル）----
    const axDefs = [
      { dir: new THREE.Vector3(1,0,0), color: 0xff4444, css: '#ff6666', label: 'X' },
      { dir: new THREE.Vector3(0,1,0), color: 0x44cc44, css: '#66ee66', label: 'Y' },
      { dir: new THREE.Vector3(0,0,1), color: 0x4499ff, css: '#66aaff', label: 'Z' },
    ];
    let axLen = 5;
    const axisGroup = new THREE.Group();
    scene.add(axisGroup);
    const axArrows = axDefs.map(({ dir, color }) => {
      const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), axLen, color, axLen*0.2, axLen*0.12);
      axisGroup.add(a);
      return a;
    });
    // HTMLラベルオーバーレイ
    const labelDiv = document.createElement('div');
    labelDiv.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    wrap.appendChild(labelDiv);
    const axisLabels = axDefs.map(({ css, label }) => {
      const el = document.createElement('div');
      el.textContent = label;
      el.style.cssText = `position:absolute;font:700 14px/1 sans-serif;color:${css};` +
        `text-shadow:0 1px 4px #000,0 0 8px #000;transform:translate(-50%,-50%);display:none`;
      labelDiv.appendChild(el);
      return el;
    });
    const _tmp = new THREE.Vector3();

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.001, 2000);
    const o = { theta: 0.4, phi: 1.0, r: 30, tx: 0, ty: 0, tz: 0 };

    function place() {
      camera.position.set(
        o.tx + o.r * Math.sin(o.phi) * Math.sin(o.theta),
        o.ty + o.r * Math.cos(o.phi),
        o.tz + o.r * Math.sin(o.phi) * Math.cos(o.theta)
      );
      camera.lookAt(o.tx, o.ty, o.tz);
    }
    place();

    // ---- マウス操作（回転・パン・ズーム）----
    let md = null;
    canvas.addEventListener('mousedown', e => {
      md = { x: e.clientX, y: e.clientY, b: e.button };
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!md) return;
      const dx = e.clientX - md.x, dy = e.clientY - md.y;
      md.x = e.clientX; md.y = e.clientY;
      if (md.b === 0) {
        // 左ドラッグ: 回転
        o.theta -= dx * 0.008;
        o.phi = Math.max(0.05, Math.min(Math.PI - 0.05, o.phi + dy * 0.008));
      } else {
        // 右ドラッグ: パン
        const s = o.r * 0.002;
        o.tx += dx * s * Math.cos(o.theta);
        o.tz -= dx * s * Math.sin(o.theta);
        o.ty -= dy * s;
      }
      place();
    });
    document.addEventListener('mouseup', () => { md = null; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      o.r = Math.max(0.2, o.r * (1 + e.deltaY * 0.001));
      place();
    }, { passive: false });

    // ---- タッチ操作（回転・ピンチズーム）----
    let td = null, p0 = null;
    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 1) {
        td = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        p0 = null;
      } else if (e.touches.length === 2) {
        td = null;
        p0 = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && td) {
        const dx = e.touches[0].clientX - td.x, dy = e.touches[0].clientY - td.y;
        td = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        o.theta -= dx * 0.01;
        o.phi = Math.max(0.05, Math.min(Math.PI - 0.05, o.phi + dy * 0.01));
        place();
      } else if (e.touches.length === 2 && p0 != null) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        o.r = Math.max(0.2, o.r * p0 / d);
        p0 = d;
        place();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => { td = null; p0 = null; });

    // ---- スロット別データグループ（2つ）----
    const slotGroups = [new THREE.Group(), new THREE.Group()];
    slotGroups.forEach(g => scene.add(g));

    (function render() {
      requestAnimationFrame(render);
      // 軸グループをカメラ注視点に追従
      axisGroup.position.set(o.tx, o.ty, o.tz);
      // 3D→2D投影でHTMLラベル位置を更新
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      axDefs.forEach(({ dir }, i) => {
        _tmp.copy(dir).multiplyScalar(axLen).add(axisGroup.position);
        _tmp.project(camera);
        if (_tmp.z > 1) { axisLabels[i].style.display = 'none'; return; }
        axisLabels[i].style.display = '';
        axisLabels[i].style.left = ((_tmp.x * 0.5 + 0.5) * cw) + 'px';
        axisLabels[i].style.top  = ((-_tmp.y * 0.5 + 0.5) * ch) + 'px';
      });
      renderer.render(scene, camera);
    })();

    new ResizeObserver(() => {
      const W2 = wrap.clientWidth, H2 = wrap.clientHeight;
      if (!W2 || !H2) return;
      renderer.setSize(W2, H2);
      camera.aspect = W2 / H2;
      camera.updateProjectionMatrix();
    }).observe(wrap);

    viewer = { camera, o, place, slotGroups,
      setAxisLen(len) {
        axLen = len;
        axArrows.forEach(a => a.setLength(len, len * 0.2, len * 0.12));
      },
    };
  }

  function fitView(data) {
    if (!viewer || !data || !data.length) return;
    const xs = data.map(d => d.x), ys = data.map(d => d.y), zs = data.map(d => d.z);
    const { o, place } = viewer;
    o.tx = (Math.min(...xs) + Math.max(...xs)) / 2;
    o.ty = (Math.min(...ys) + Math.max(...ys)) / 2;
    o.tz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
      Math.max(...zs) - Math.min(...zs),
      0.5
    );
    o.r = span * 2.5;
    place();
    viewer.setAxisLen(span * 0.18);
  }

  function fitAllData() {
    const all = slots.flatMap(s => s.data || []);
    if (all.length) fitView(all);
  }

  function buildSlot(i, showArrows) {
    if (!viewer) return;
    const group = viewer.slotGroups[i];
    const slot  = slots[i];
    const col   = COLORS[i];

    // グループをクリア
    while (group.children.length) {
      const c = group.children[0];
      c.geometry && c.geometry.dispose();
      c.material  && c.material.dispose();
      group.remove(c);
    }

    group.visible = slot.visible;
    if (!slot.data || slot.data.length < 2) return;
    const data = slot.data;

    // パスライン
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(data.map(d => new THREE.Vector3(d.x, d.y, d.z))),
      new THREE.LineBasicMaterial({ color: col.line })
    ));

    // 頂点ドット
    const pa = new Float32Array(data.length * 3);
    data.forEach((d, j) => { pa[j*3]=d.x; pa[j*3+1]=d.y; pa[j*3+2]=d.z; });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pa, 3));
    group.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: col.dot, size: 0.3 })));

    // 向き矢印
    if (showArrows && data.length > 1) {
      let totalLen = 0;
      for (let k = 1; k < data.length; k++) {
        totalLen += Math.hypot(data[k].x-data[k-1].x, data[k].y-data[k-1].y, data[k].z-data[k-1].z);
      }
      const al = (totalLen / (data.length - 1)) * 0.65;
      const aa = new Float32Array(data.length * 6);
      data.forEach((d, j) => {
        aa[j*6]=d.x;          aa[j*6+1]=d.y;          aa[j*6+2]=d.z;
        aa[j*6+3]=d.x+d.rx*al; aa[j*6+4]=d.y+d.ry*al; aa[j*6+5]=d.z+d.rz*al;
      });
      const ag = new THREE.BufferGeometry();
      ag.setAttribute('position', new THREE.BufferAttribute(aa, 3));
      group.add(new THREE.LineSegments(ag, new THREE.LineBasicMaterial({ color: col.arrow })));
    }
  }

  function rebuildAll() {
    const sa = arrowsChk ? arrowsChk.checked : true;
    buildSlot(0, sa);
    buildSlot(1, sa);
  }

  function parseCsv(text) {
    const rows = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const cols = t.split(/[\s,;]+/);
      if (cols.length < 6) continue;
      const n = cols.slice(0, 6).map(Number);
      if (n.some(isNaN)) continue;
      rows.push({ x: n[0], y: n[1], z: n[2], rx: n[3], ry: n[4], rz: n[5] });
    }
    return rows;
  }

  function updateSlotUI(i) {
    const el = document.getElementById(`csv3d-slot-${i}`);
    if (!el) return;
    const slot    = slots[i];
    const loadLbl = el.querySelector('.csv3d-load-lbl');
    const fname   = el.querySelector('.csv3d-fname');
    const visLbl  = el.querySelector('.csv3d-vis-lbl');
    const visChk  = el.querySelector('.csv3d-vis');
    const rmBtn   = el.querySelector('.csv3d-rm');
    if (slot.data) {
      loadLbl.classList.add('hidden');
      fname.textContent = slot.name;
      fname.classList.remove('hidden');
      visLbl.classList.remove('hidden');
      if (visChk) visChk.checked = slot.visible;
      rmBtn.classList.remove('hidden');
    } else {
      loadLbl.classList.remove('hidden');
      fname.classList.add('hidden');
      visLbl.classList.add('hidden');
      rmBtn.classList.add('hidden');
    }
  }

  function updateInfo() {
    const info  = document.getElementById('csv3d-info');
    const empty = document.getElementById('csv3d-empty');
    const hasAny = slots.some(s => s.data);
    if (empty) empty.style.display = hasAny ? 'none' : '';
    if (!info) return;
    const parts = slots.map((s, i) => s.data ? `CSV${i+1}: ${s.data.length}点` : null).filter(Boolean);
    if (parts.length) { info.textContent = parts.join('　'); info.classList.remove('hidden'); }
    else              { info.classList.add('hidden'); }
  }

  function openViewer(cb) {
    loadThree(() => { initViewer(); cb && cb(); });
  }

  // ---- ファイル入力（2スロット共通）----
  document.querySelectorAll('#tab-csv3d input[type=file]').forEach(inp => {
    inp.addEventListener('change', e => {
      const i = +e.target.dataset.slot;
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const data = parseCsv(ev.target.result);
        if (!data.length) { log('CSVを解析できません（x y z rx ry rz の6列が必要）', 'warn'); return; }
        slots[i].data = data;
        slots[i].name = file.name;
        slots[i].visible = true;
        updateSlotUI(i);
        updateInfo();
        const sa = arrowsChk ? arrowsChk.checked : true;
        openViewer(() => { buildSlot(i, sa); fitAllData(); });
        log(`CSV${i+1}: ${data.length}点 読み込み完了`, 'info');
      };
      reader.readAsText(file);
    });
  });

  // ---- 表示/非表示トグル ----
  document.querySelectorAll('#tab-csv3d .csv3d-vis').forEach(chk => {
    chk.addEventListener('change', () => {
      const i = +chk.dataset.slot;
      slots[i].visible = chk.checked;
      if (viewer) viewer.slotGroups[i].visible = chk.checked;
    });
  });

  // ---- 取り消し（データ削除）----
  document.querySelectorAll('#tab-csv3d .csv3d-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.slot;
      slots[i].data = null;
      slots[i].name = '';
      slots[i].visible = true;
      const fi = document.querySelector(`#csv3d-slot-${i} input[type=file]`);
      if (fi) fi.value = '';
      updateSlotUI(i);
      updateInfo();
      if (viewer) { buildSlot(i, false); fitAllData(); }
      log(`CSV${i+1} を削除しました`, 'info');
    });
  });

  // ---- 向き矢印トグル ----
  arrowsChk?.addEventListener('change', () => {
    if (viewer) rebuildAll();
  });

  // ---- 視点リセット ----
  document.getElementById('csv3d-reset-view')?.addEventListener('click', () => {
    fitAllData();
  });

  // ---- モバイル: タブクリックで遅延初期化 ----
  document.querySelector('.tab-btn[data-tab="csv3d"]')?.addEventListener('click', () => {
    openViewer(() => {
      if (slots.some(s => s.data)) setTimeout(() => { rebuildAll(); fitAllData(); }, 40);
    });
  });

  // ---- デスクトップ: トグルボタン ----
  document.getElementById('btn-show-3d')?.addEventListener('click', () => {
    const panel = document.getElementById('tab-csv3d');
    if (!panel) return;
    const isNowHidden = panel.classList.toggle('hidden');
    if (!isNowHidden) {
      openViewer(() => {
        if (slots.some(s => s.data)) setTimeout(() => { rebuildAll(); fitAllData(); }, 40);
      });
    }
  });

  // ---- 外部からデータを slot に差し込む公開インターフェース ----
  window.csv3dLoadData = function (slotIndex, data, name) {
    slots[slotIndex].data = data;
    slots[slotIndex].name = name;
    slots[slotIndex].visible = true;
    updateSlotUI(slotIndex);
    updateInfo();
    const sa = arrowsChk ? arrowsChk.checked : true;
    openViewer(() => { buildSlot(slotIndex, sa); fitAllData(); });
  };
})();

// =====================================================================
// 刃先形状タブ
// =====================================================================
(function () {
  const elBsCurveLen   = document.getElementById('bs-curve-length');
  const elBsLayerCnt   = document.getElementById('bs-layer-count');
  const elBsZ          = document.getElementById('bs-z');
  const elBsXDist      = document.getElementById('bs-x-dist');
  const elBsYStep      = document.getElementById('bs-y-step');
  const elBsLoad3d     = document.getElementById('bs-load-3d');
  const elBsPreview    = document.getElementById('bs-preview');
  const elBsCsvInput   = document.getElementById('bs-csv-input');
  const elBsCsvFname   = document.getElementById('bs-csv-fname');
  const elBsCsvRm      = document.getElementById('bs-csv-rm');
  const elBsXzCanvas   = document.getElementById('bs-xz-canvas');

  let bsCsvLengthMm = null; // CSVから計算した刃渡り

  function parseBsCsv(text) {
    const rows = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const cols = t.split(/[\s,;]+/);
      if (cols.length < 6) continue;
      const n = cols.slice(0, 6).map(Number);
      if (n.some(isNaN)) continue;
      rows.push({ x: n[0], y: n[1], z: n[2] });
    }
    return rows;
  }

  function calcLengthFromCsvRows(rows) {
    if (!rows || rows.length < 2) return null;
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const dx = rows[i].x - rows[i-1].x;
      const dy = rows[i].y - rows[i-1].y;
      const dz = rows[i].z - rows[i-1].z;
      total += Math.sqrt(dx*dx + dy*dy + dz*dz);
    }
    return total;
  }

  function getBladeLengthMm() {
    if (bsCsvLengthMm !== null) return bsCsvLengthMm;
    return calcCurveLengthMm(state.lastBladeCurvePts);
  }

  function refreshDisplay() {
    const bladeMm = getBladeLengthMm();
    const yStep   = Math.max(1, parseFloat(elBsYStep.value) || 10);

    if (bladeMm === null) {
      elBsCurveLen.textContent = '--';
      elBsLayerCnt.textContent = '--';
      elBsLoad3d.disabled = true;
      elBsPreview.textContent = '刃渡り曲線CSVを読み込むか、刃渡りを計測してください。';
      drawXZGraph();
      return;
    }

    const yMax   = Math.floor(bladeMm / yStep) * yStep;
    const layers = Math.floor(bladeMm / yStep) + 1;
    const pts    = layers * 2;

    elBsCurveLen.textContent = bladeMm.toFixed(1);
    elBsLayerCnt.textContent = layers;
    elBsLoad3d.disabled = false;

    const zVal  = parseFloat(elBsZ.value)     || 20;
    const xDist = parseFloat(elBsXDist.value) || 5;
    elBsPreview.textContent =
      `y=0〜${yMax}mm（${layers}段） ×2点 → 合計${pts}行` +
      `  /  z=${zVal}mm  x=±${(xDist / 2).toFixed(2)}mm`;
    drawXZGraph();
  }

  function drawXZGraph() {
    const canvas = elBsXzCanvas;
    if (!canvas) return;

    const W = Math.max(canvas.offsetWidth, 100);
    const H = Math.round(W * 0.5);
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0d1b2e';
    ctx.fillRect(0, 0, W, H);

    const zVal  = parseFloat(elBsZ.value)     || 20;
    const xDist = parseFloat(elBsXDist.value) || 5;

    const xHalf = xDist / 2;
    const xPad  = Math.max(xHalf * 0.4, 1);
    const zPad  = Math.max(zVal  * 0.15, 1);
    const xMin  = -xHalf - xPad;
    const xMax  =  xHalf + xPad;
    const zMin  = -zPad;
    const zMax  = zVal + zPad;

    const mg = { left: 46, right: 14, top: 14, bottom: 30 };
    const pw = W - mg.left - mg.right;
    const ph = H - mg.top  - mg.bottom;

    const cx = x => mg.left + (x - xMin) / (xMax - xMin) * pw;
    const cz = z => mg.top  + (1 - (z - zMin) / (zMax - zMin)) * ph;

    // 水平グリッド
    ctx.strokeStyle = '#1e3050';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = mg.top + ph / 4 * i;
      ctx.beginPath(); ctx.moveTo(mg.left, gy); ctx.lineTo(mg.left + pw, gy); ctx.stroke();
    }

    // z=0 ライン
    ctx.strokeStyle = '#3a5070';
    ctx.lineWidth = 1;
    const z0y = cz(0);
    ctx.beginPath(); ctx.moveTo(mg.left, z0y); ctx.lineTo(mg.left + pw, z0y); ctx.stroke();

    // x=0 ライン
    const x0x = cx(0);
    ctx.beginPath(); ctx.moveTo(x0x, mg.top); ctx.lineTo(x0x, mg.top + ph); ctx.stroke();

    // 軸フレーム（L字）
    ctx.strokeStyle = '#3a5070';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mg.left, mg.top);
    ctx.lineTo(mg.left, mg.top + ph);
    ctx.lineTo(mg.left + pw, mg.top + ph);
    ctx.stroke();

    // 三角形（左点 → 原点 → 右点 → 閉じる）
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx(-xHalf), cz(zVal));
    ctx.lineTo(cx(0),       cz(0));
    ctx.lineTo(cx( xHalf), cz(zVal));
    ctx.closePath();
    ctx.stroke();

    // 点（3つ）
    ctx.fillStyle = '#ff4455';
    for (const [px, pz] of [[-xHalf, zVal], [0, 0], [xHalf, zVal]]) {
      ctx.beginPath();
      ctx.arc(cx(px), cz(pz), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // x 軸ラベル
    ctx.fillStyle = '#7090a0';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`x ${xMin.toFixed(1)}`, mg.left, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${xMax.toFixed(1)} mm`, mg.left + pw, H - 4);

    // z 軸ラベル（縦書き）
    ctx.save();
    ctx.translate(10, mg.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('z (mm)', 0, 0);
    ctx.restore();

    // z 軸目盛り
    ctx.fillStyle = '#556677';
    ctx.textAlign = 'right';
    ctx.font = '9px sans-serif';
    ctx.fillText('0', mg.left - 3, cz(0) + 4);
    ctx.fillText(zVal.toFixed(0), mg.left - 3, cz(zVal) + 4);
  }

  function computeBladeShapePoints() {
    const bladeMm = getBladeLengthMm();
    if (bladeMm === null) return null;

    const zVal  = parseFloat(elBsZ.value)     || 20;
    const xDist = parseFloat(elBsXDist.value) || 5;
    const yStep = Math.max(1, parseFloat(elBsYStep.value) || 10);
    const yMax  = Math.floor(bladeMm / yStep) * yStep;

    const rows = [];
    for (let y = 0; y <= yMax; y += yStep) {
      rows.push({ x: -(xDist / 2), y, z: zVal, rx: 1, ry: 0, rz: 0 });
      rows.push({ x:   xDist / 2,  y, z: zVal, rx: 1, ry: 0, rz: 0 });
    }
    return rows;
  }

  // ---- CSVファイル読み込み ----
  elBsCsvInput?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const rows = parseBsCsv(ev.target.result);
      const len  = calcLengthFromCsvRows(rows);
      if (len === null) {
        log('刃渡り曲線CSVを解析できません（x y z rx ry rz の6列が必要）', 'warn');
        return;
      }
      bsCsvLengthMm = len;
      elBsCsvFname.textContent = file.name;
      elBsCsvFname.classList.remove('hidden');
      elBsCsvRm.classList.remove('hidden');
      refreshDisplay();
    };
    reader.readAsText(file);
  });

  // ---- CSV クリア ----
  elBsCsvRm?.addEventListener('click', () => {
    bsCsvLengthMm = null;
    if (elBsCsvInput) elBsCsvInput.value = '';
    elBsCsvFname.classList.add('hidden');
    elBsCsvRm.classList.add('hidden');
    refreshDisplay();
  });

  [elBsZ, elBsXDist, elBsYStep].forEach(el =>
    el?.addEventListener('input', refreshDisplay)
  );

  elBsLoad3d?.addEventListener('click', () => {
    const data = computeBladeShapePoints();
    if (!data) return;
    if (typeof window.csv3dLoadData === 'function') {
      window.csv3dLoadData(0, data, '刃先形状');
    }
    document.querySelector('.tab-btn[data-tab="csv3d"]')?.click();
  });

  document.querySelector('.tab-btn[data-tab="blade-shape"]')
    ?.addEventListener('click', refreshDisplay);
})();
