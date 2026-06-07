#!/usr/bin/env python3
"""包丁計測アプリ 技術解説 PDF 生成スクリプト"""

from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle,
    PageBreak
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

# ── フォント登録 ──────────────────────────────────────────────────────────────
pdfmetrics.registerFont(TTFont('IPA',    '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'))
pdfmetrics.registerFont(TTFont('IPABold','/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf'))

# ── スタイル定義 ──────────────────────────────────────────────────────────────
BASE = 'IPA'
BOLD = 'IPABold'

styles = getSampleStyleSheet()

def S(name, **kw):
    defaults = dict(fontName=BASE, fontSize=10, leading=16, spaceAfter=4)
    defaults.update(kw)
    return ParagraphStyle(name, **defaults)

sTitle  = S('sTitle',  fontName=BOLD, fontSize=22, leading=28, alignment=TA_CENTER, spaceAfter=6)
sSub    = S('sSub',    fontName=BASE, fontSize=13, leading=20, alignment=TA_CENTER, spaceAfter=20, textColor=colors.HexColor('#444444'))
sH1     = S('sH1',    fontName=BOLD, fontSize=15, leading=22, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor('#1a237e'))
sH2     = S('sH2',    fontName=BOLD, fontSize=12, leading=18, spaceBefore=10, spaceAfter=4, textColor=colors.HexColor('#283593'))
sH3     = S('sH3',    fontName=BOLD, fontSize=10.5, leading=16, spaceBefore=8, spaceAfter=3, textColor=colors.HexColor('#37474f'))
sBody   = S('sBody',  leading=17, spaceAfter=5, alignment=TA_JUSTIFY)
sMath   = S('sMath',  fontName=BOLD, fontSize=10, leading=16, spaceAfter=4,
            leftIndent=18, backColor=colors.HexColor('#f5f5f5'),
            borderPad=6)
sCode   = S('sCode',  fontName=BASE, fontSize=8.5, leading=13, spaceAfter=4,
            leftIndent=14, textColor=colors.HexColor('#1b5e20'))
sNote   = S('sNote',  fontSize=9, leading=14, spaceAfter=4, leftIndent=14,
            textColor=colors.HexColor('#555555'))
sBullet = S('sBullet', fontSize=10, leading=16, spaceAfter=3, leftIndent=18, bulletIndent=6)

def P(text, style=None):
    return Paragraph(text, style or sBody)

def Math(text):
    return Paragraph(text, sMath)

def H1(text): return Paragraph(text, sH1)
def H2(text): return Paragraph(text, sH2)
def H3(text): return Paragraph(text, sH3)
def Note(text): return Paragraph('※ ' + text, sNote)
def Bullet(text): return Paragraph('・ ' + text, sBullet)
def SP(n=6): return Spacer(1, n)
def HR(): return HRFlowable(width='100%', thickness=0.5, color=colors.HexColor('#cccccc'), spaceAfter=4)

# ── ドキュメント作成 ──────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    '/home/user/2026/技術解説.pdf',
    pagesize=(210*mm, 297*mm),
    leftMargin=22*mm, rightMargin=22*mm,
    topMargin=22*mm, bottomMargin=22*mm,
)

story = []

# ─────────────────────────────────────────────────────────────────────────────
# 表紙
# ─────────────────────────────────────────────────────────────────────────────
story += [
    SP(30),
    P('包丁検出・刃渡り計測アプリ', sTitle),
    P('技術解説 — 計算原理と数式', sSub),
    SP(8),
    HR(),
    SP(6),
    P('本書は、ブラウザ上で動作する包丁計測アプリの主要アルゴリズムを、'
      '数式・図解を交えて説明する技術ドキュメントです。'
      '扱うトピックは「画像処理による包丁検出」「刃渡り推定」「刃渡り曲線抽出」'
      '「V字断面生成」「3D合成・アライメント」「CSV出力」の6つです。', sBody),
    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 1. 画像処理・包丁検出
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('1. 画像処理・包丁検出（OpenCV.js）'),
    HR(),
    SP(4),

    H2('1-1. 前処理パイプライン'),
    P('カメラ画像に対して以下の順でOpenCV.jsの処理を適用します。'),
    SP(4),

    H3('① グレースケール変換'),
    P('RGBカラー画像をグレースケールに変換し、処理量を削減します。'),
    Math('I_gray(x,y) = 0.299·R + 0.587·G + 0.114·B'),
    SP(4),

    H3('② ガウシアンブラー（ノイズ除去）'),
    P('カーネルサイズ (2k+1)×(2k+1) のガウシアンフィルタで高周波ノイズを除去します。'),
    Math('G(x,y) = (1 / 2πσ²) · exp(-(x²+y²) / 2σ²)'),
    Note('アプリのデフォルト: カーネルサイズ 5×5、σ自動（OpenCV標準）'),
    SP(4),

    H3('③ Cannyエッジ検出'),
    P('ガウシアン平滑化後の画像に Canny アルゴリズムを適用し、'
      '包丁の輪郭エッジを抽出します。Canny は以下の4ステップで構成されます。'),
    Bullet('Sobelフィルタで勾配強度 |∇I| と方向 θ を計算'),
    Bullet('Non-maximum suppression（エッジ方向の極大のみ残す）'),
    Bullet('ヒステリシス閾値処理：強エッジ（threshold2以上）から弱エッジ（threshold1以上）を追跡'),
    SP(4),

    H2('1-2. 輪郭検出とスコアリング'),
    P('Cannyエッジ画像から `findContours` で輪郭を抽出し、'
      '以下のスコアで包丁候補を選びます。'),
    Math('score = area × min(aspect, 15)'),
    P('ここで aspect = w/h（最小外接矩形の長辺/短辺）です。'
      'aspect が 2.5 〜 25 の範囲外の輪郭は除外します（極端に丸い・細すぎる形状を排除）。'
      '最大スコアの輪郭が包丁候補として採用されます。'),
    SP(4),

    H2('1-3. 最小外接矩形（minAreaRect）'),
    P('採用された輪郭に対し、面積最小の回転外接矩形を求めます。'
      'OpenCV の minAreaRect はモーメント行列の固有値分解を使い、'
      '以下を返します。'),
    Bullet('center: 矩形の重心 (cx, cy)'),
    Bullet('size: (width, height)'),
    Bullet('angle: X軸から width ベクトルへの角度 (−90°, 0°]'),
    P('幅と高さのうち長い方が包丁の全長方向、短い方が幅方向です。'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 2. 刃渡り推定
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('2. 刃渡り推定（幅プロファイル解析）'),
    HR(),
    SP(4),

    H2('2-1. 座標回転'),
    P('最小外接矩形の角度 α だけ輪郭点群を回転させ、長軸が水平（x軸平行）になるよう揃えます。'),
    Math('x\' =  cos α · (px − cx) + sin α · (py − cy)'),
    Math('y\' = −sin α · (px − cx) + cos α · (py − cy)'),
    P('ただし OpenCV の angle 定義では height > width のとき +90° 補正が必要です。'),
    SP(4),

    H2('2-2. 幅プロファイルの構築'),
    P('回転後の点群を x 軸方向に 50 ビン（等間隔）で分割し、'
      '各ビン b における幅 W(b) を求めます。'),
    Math('binSize = (x_max − x_min) / 50'),
    Math('b = floor((x\' − x_min) / binSize),  b ∈ [0, 49]'),
    Math('W(b) = maxY(b) − minY(b)'),
    P('maxY(b), minY(b) はビン b に属する全点の回転後 y\' の最大・最小値です。'),
    SP(4),

    H2('2-3. 移動平均スムージング'),
    P('幅プロファイルに窓幅 3 の移動平均を適用してノイズを除去します。'),
    Math('W_smooth(b) = (1/|N_b|) · Σ_{j∈N_b} W(j),   N_b = {b−1, b, b+1}'),
    Note('W(j)=0 のビンは平均計算から除外します。'),
    SP(4),

    H2('2-4. 刃先側の判定'),
    P('幅プロファイルの最大値位置 b_max を求め、刃先の方向を判定します。'
      '包丁は「刃先（細）→ 刃元（最大幅）→ 柄」の順に幅が変化するため、'
      '最大幅位置が中央より左にあれば刃先は右、右にあれば刃先は左です。'),
    Math('tipSide = "left"  if  b_max ≥ 25  else  "right"'),
    SP(4),

    H2('2-5. アゴ位置の検出（50%閾値法）'),
    P('アゴとは刃部分と柄部分の境界点です。以下の手順で検出します。'),
    Bullet('柄端ゾーン（刃先から遠い20%の範囲）の最小 y\' を柄基準線 Y_handle とする'),
    Bullet('刃元ビン b_max の底面 y\' を刃基準線 Y_heel とする'),
    Bullet('段差 ΔY = Y_heel − Y_handle を計算'),
    Math('threshold = Y_handle + 0.50 × ΔY'),
    P('柄端側から刃先方向にスキャンし、底面 y\' が threshold を初めて超えたビンを'
      'アゴ位置 b_junc とします。'),
    SP(4),

    H2('2-6. 刃渡り（px → mm 変換）'),
    Math('L_px = |b_junc − b_tip| × binSize'),
    Math('L_mm = L_px / PPM'),
    P('PPM（pixels per mm）は後述のカード校正で求めます。'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 3. カード校正
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('3. カード校正（px/mm 変換係数の算出）'),
    HR(),
    SP(4),

    P('クレジットカード（ISO/IEC 7810 ID-1）の短辺 53.98 mm、'
      'またはA4用紙の短辺 210 mm を基準として、1mm あたりのピクセル数（PPM）を算出します。'),
    SP(4),

    H2('3-1. 3点からの垂線距離'),
    P('エッジ画像上で短辺の2端点 P1, P2 と反対側短辺の任意点 P3 を指定します。'
      'P3 から直線 P1P2 への垂足 F を求め、距離 d を校正基準とします。'),
    Math('d = P1P2 × P1P3 方向ベクトルに対する P3 の垂線距離'),
    P('具体的には以下の垂足公式を使います。'),
    Math('t = ((P3 − P1) · (P2 − P1)) / |P2 − P1|²'),
    Math('F = P1 + t · (P2 − P1)'),
    Math('d = |P3 − F|   [px]'),
    SP(4),

    H2('3-2. PPM の算出'),
    Math('PPM = d_px / d_mm'),
    P('ここで d_mm はカード短辺の実寸法です。以降の全ての mm 換算にこの PPM を使います。'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 4. 刃渡り曲線抽出
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('4. 刃渡り曲線抽出'),
    HR(),
    SP(4),

    H2('4-1. アゴ・切先の指定とスナップ'),
    P('ユーザーがエッジ画像上でアゴと切先をタップすると、'
      '半径 r 内で最も明るいエッジピクセルに自動スナップします。'),
    Math('snap(x,y) = argmin_{(ix,iy) : dist≤r, brightness>64} dist(x,y, ix,iy)'),
    SP(4),

    H2('4-2. エッジピクセルのトレース'),
    P('アゴ (x₀,y₀) から切先 (x₁,y₁) まで直線を等分し、'
      '各ステップ s で垂直方向にウィンドウ W=50px をスキャンして最近傍エッジ点を取得します。'),
    Math('t_s = s / steps,   s = 0, 1, …, steps'),
    Math('ex_s = round(x₀ + (x₁−x₀)·t_s)'),
    Math('ey_s = argmin_{r∈[−W,W]} { r : isEdge(ex_s, ey_s + r) }'),
    Note('isEdge: ピクセル輝度が64超かどうかで判定します。'),
    SP(4),

    H2('4-3. 曲線長の計算（弧長積分の離散近似）'),
    P('取得した全トレース点 {(imgX_i, imgY_i)} から弧長を計算します。'),
    Math('L = (1/PPM) × Σ_{i=1}^{N−1} √((imgX_i − imgX_{i−1})² + (imgY_i − imgY_{i−1})²)'),
    SP(4),

    H2('4-4. 等間隔サンプリング（ドット間隔）'),
    P('曲線を指定間隔（デフォルト 10mm）でサンプリングします。'
      'トレース点は xMm 属性（アゴからの累積距離）を持ち、'
      'xMm が前回サンプル点から intervalMm 以上離れた点を採用します。'),
    Math('S = { P_i :  xMm(P_i) − xMm(P_{last}) ≥ intervalMm }'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 5. V字断面生成（刃先形状）
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('5. V字断面生成（刃先形状タブ）'),
    HR(),
    SP(4),

    P('包丁の刃は断面がV字形をしています。ユーザーが左右のθ角（刃角）を指定すると、'
      '断面の3D形状を生成します。'),
    SP(4),

    H2('5-1. セグメント方式'),
    P('V字断面を n セグメントに分割し、各セグメントで独立したθ角を設定できます。'
      'Z方向（深さ）を n 等分したとき、セグメント k の刃角を θ_k とすると、'
      'セグメント境界点の x 座標（側面の広がり）は以下で計算されます。'),
    Math('dz = Z_total / n'),
    Math('x_k = Σ_{j=0}^{k−1} dz · tan(θ_j)   (k = 1, …, n)'),
    P('これは刃先（x=0）から外側へ向かう累積展開量です。左右で独立に計算します。'),
    SP(4),

    H2('5-2. 断面の全幅'),
    Math('W_total = x_L(n) + x_R(n)'),
    P('ここで x_L(n), x_R(n) は左右のn番目の境界点のx座標です。'),
    SP(4),

    H2('5-3. 断面の繰り返し配置'),
    P('刃渡り曲線上のサンプル点ごとに上記断面をY方向（刃渡り方向）に配置します。'
      '各断面の z の原点は刃先（V字の谷）、y は刃渡り方向の位置です。'),
    Note('Y方向の間隔 yStep はドット間隔 intervalMm と自動同期します。'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 6. 3D合成・アライメント
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('6. 3D合成・アライメント（刃先形状 × 刃渡り曲線）'),
    HR(),
    SP(4),

    P('「刃先形状をエッジ曲線に合わせる」ボタンを押すと、'
      '刃先断面データをエッジ曲線に沿って配置し直します。'),
    SP(4),

    H2('6-1. Yリマッピング（線形補間）'),
    P('刃先形状データのY範囲 [y_blade_min, y_blade_max] を'
      'エッジ曲線のY範囲 [y_edge_min, y_edge_max] に線形変換します。'),
    Math('y_new = y_edge_min + (y − y_blade_min) / (y_blade_max − y_blade_min) × (y_edge_max − y_edge_min)'),
    SP(4),

    H2('6-2. エッジ曲線のZ値補間'),
    P('y_new に対応するエッジ曲線のZ値を線形補間で求めます。'),
    Math('t = (y_new − y_{i−1}) / (y_i − y_{i−1})'),
    Math('z_edge = z_{i−1} + t · (z_i − z_{i−1})'),
    P('ここで y_{i−1} ≤ y_new < y_i となるエッジ曲線の区間を使います。'),
    SP(4),

    H2('6-3. 接線ベクトルの計算（中央差分）'),
    P('各Y位置におけるエッジ曲線の接線ベクトルを中央差分で求め、正規化します。'),
    Math('Δv = (e_{i+1}.y − e_{i−1}.y,  e_{i+1}.z − e_{i−1}.z)   [端点は前進/後退差分]'),
    Math('t̂ = Δv / |Δv|    （単位接線ベクトル）'),
    Note('Three.js の Vector3 として (x=0, y=Δy, z=Δz) の正規化ベクトルを使います。'),
    SP(4),

    H2('6-4. クォータニオン回転'),
    P('断面の「上向きベクトル」(0,1,0) を接線ベクトル t̂ へ回転させるクォータニオン q を求め、'
      '断面の各点に適用します。'),
    Math('q = Quaternion.setFromUnitVectors( (0,1,0),  t̂ )'),
    P('各断面点 P = (p.x, 0, p.z)（Y成分=0の平面内オフセット）を回転させます。'),
    Math('P\' = q · P   （クォータニオンによる3D回転）'),
    P('最終的な3D座標は、アンカー点（刃先位置）に回転済みオフセットを加算した値です。'),
    Math('result = (P\'.x,   y_new + P\'.y,   z_edge + P\'.z)'),
    SP(4),

    H2('6-5. クォータニオンの計算方法'),
    P('2つの単位ベクトル a, b から回転クォータニオンを構築する公式：'),
    Math('half = (a + b) / |a + b|'),
    Math('q.w = a · half    （内積）'),
    Math('q.xyz = a × half  （外積）'),
    Note('a と b が平行（同方向）なら q = 恒等クォータニオン、'
         '逆向きなら任意の垂直軸まわり 180° 回転を使います。'),

    PageBreak(),
]

# ─────────────────────────────────────────────────────────────────────────────
# 7. CSV 出力形式
# ─────────────────────────────────────────────────────────────────────────────
story += [
    H1('7. CSV 出力形式'),
    HR(),
    SP(4),

    H2('7-1. 刃渡り曲線 CSV（エッジ曲線用・6列）'),
    P('刃渡り曲線をサンプリングした各点を6列CSVで出力します。'),
    SP(4),

    # テーブル
    Table(
        [['列', '値', '説明'],
         ['x', '0（固定）', '断面内の横方向位置（刃先は x=0）'],
         ['y', 'xMm [mm]', 'アゴからの曲線長（刃渡り方向）'],
         ['z', '−yMm [mm]', '画像のY軸を反転した高さ方向'],
         ['rx', '0（固定）', '接線方向の x 成分'],
         ['ry', 'dy/ds', '接線方向の y 成分（正規化）'],
         ['rz', 'dz/ds', '接線方向の z 成分（正規化）']],
        colWidths=[18*mm, 40*mm, 95*mm],
        style=TableStyle([
            ('FONTNAME', (0,0), (-1,-1), BASE),
            ('FONTNAME', (0,0), (-1,0), BOLD),
            ('FONTSIZE', (0,0), (-1,-1), 9),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#e8eaf6')),
            ('BACKGROUND', (0,1), (-1,-1), colors.HexColor('#fafafa')),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#aaaaaa')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f5f5f5')]),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ('LEFTPADDING', (0,0), (-1,-1), 6),
        ])
    ),
    SP(6),

    P('接線成分 (ry, rz) は前進・後退・中央差分で計算します。'),
    Math('ds = √(dy² + dz²),   ry = dy/ds,   rz = dz/ds'),
    SP(8),

    H2('7-2. 合成結果 CSV（3D合成後・6列）'),
    P('アライメント後の刃先形状全点を同じ6列形式で出力します。'),

    Table(
        [['列', '値', '説明'],
         ['x', '断面横方向 [mm]', 'V字断面の左右展開量（刃先=0）'],
         ['y', '刃渡り方向 [mm]', '回転・補間後のY位置'],
         ['z', '高さ方向 [mm]', '刃渡り曲線Z + 断面Z回転分'],
         ['rx', '0', '（現在未使用）'],
         ['ry', '1', '（現在未使用）'],
         ['rz', '0', '（現在未使用）']],
        colWidths=[18*mm, 45*mm, 90*mm],
        style=TableStyle([
            ('FONTNAME', (0,0), (-1,-1), BASE),
            ('FONTNAME', (0,0), (-1,0), BOLD),
            ('FONTSIZE', (0,0), (-1,-1), 9),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#e8eaf6')),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#aaaaaa')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f5f5f5')]),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ('LEFTPADDING', (0,0), (-1,-1), 6),
        ])
    ),
    SP(10),

    H2('7-3. 計測履歴 CSV'),
    P('計測ごとの刃渡り・刃幅・角度・時刻を CSV 出力します（1計測 = 1行）。'),
    Table(
        [['列', '内容'],
         ['#', '計測番号'],
         ['刃渡り(mm)', 'bladeLength（mm 換算済み、未校正時は px）'],
         ['刃幅(mm)', '包丁幅（最小外接矩形の短辺）'],
         ['角度(°)', 'minAreaRect の傾き angle'],
         ['時刻', '計測時のローカル時刻']],
        colWidths=[35*mm, 118*mm],
        style=TableStyle([
            ('FONTNAME', (0,0), (-1,-1), BASE),
            ('FONTNAME', (0,0), (-1,0), BOLD),
            ('FONTSIZE', (0,0), (-1,-1), 9),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#e8eaf6')),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#aaaaaa')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f5f5f5')]),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ('LEFTPADDING', (0,0), (-1,-1), 6),
        ])
    ),
    SP(16),

    HR(),
    SP(6),
    P('以上が本アプリの主要な計算原理です。'
      '各ステップは連携しており、カード校正で得たPPMが刃渡りと断面の全計算の基準となります。',
      sNote),
]

# ── ビルド ────────────────────────────────────────────────────────────────────
doc.build(story)
print("PDF 生成完了: 技術解説.pdf")
