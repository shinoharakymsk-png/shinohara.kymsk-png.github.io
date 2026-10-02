/* =========================================================
 * OBSカメラ app.js （A端末=カメラ / B端末=操作 / PC=OBS）
 *
 *   カメラ(A) ──映像(WebRTC)──▶ OBS画面(PC, ハブ) ◀──操作(DataChannel)── 操作(B)
 *
 * - OBS画面が「ハブ」。映像を受け取り、エフェクトを適用して表示する。
 * - 操作端末の指示はハブ経由でカメラ端末にも中継される（カメラ切替など）。
 * - 接続の仲介（シグナリング）には PeerJS の公開サーバーを使う。
 * - ?mode=home|camera|control|obs  &room=ルームコード
 * ========================================================= */
'use strict';

// ---------- 1. 設定 ----------
const FX_KEY = 'obscamera.fx.v2';      // エフェクト設定（OBS画面が保存）
const CAM_KEY = 'obscamera.cam.v2';    // カメラ設定（カメラ端末が保存）
const ROOM_KEY = 'obscamera.room.v2';

const FX_DEFAULTS = {
  mirror: false,
  brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0,
  chromaOn: false, keyColor: '#00ff00',
  similarity: 40,   // 0-100：この距離以内は完全に透明
  smooth: 10        // 0-50 ：その外側でなだらかに不透明へ
};
const CAM_DEFAULTS = { deviceId: '', resolution: '1280x720' };
const CAM_KEYS = Object.keys(CAM_DEFAULTS);

const load = (key, defaults) => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(key)) }; }
  catch { return { ...defaults }; }
};
let fx = load(FX_KEY, FX_DEFAULTS);
let cam = load(CAM_KEY, CAM_DEFAULTS);
let devices = [];          // カメラ一覧 [{id,label}]
let camOnline = false;     // カメラ端末が接続中か（操作画面の表示用）

// ---------- 2. モードとルーム ----------
const params = new URLSearchParams(location.search);
const mode = ['camera', 'control', 'obs'].includes(params.get('mode')) ? params.get('mode') : 'home';
let room = params.get('room') || localStorage.getItem(ROOM_KEY) ||
           Math.random().toString(36).slice(2, 8);
localStorage.setItem(ROOM_KEY, room);
document.body.dataset.mode = mode;

// ---------- 3. DOM ----------
const $ = (s) => document.querySelector(s);
const video = $('#video');
const canvas = $('#chroma');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const setStatus = (t) => { $('#message').textContent = t; };

// ---------- 4. 画面への反映 ----------
function applyFx() {
  const filter = `brightness(${fx.brightness}%) contrast(${fx.contrast}%) saturate(${fx.saturate}%) ` +
                 `hue-rotate(${fx.hue}deg) blur(${fx.blur}px)`;
  for (const el of [video, canvas]) {
    el.style.filter = filter;
    el.style.transform = fx.mirror ? 'scaleX(-1)' : 'none';
  }
  // エフェクトはOBS画面でのみ適用（カメラ端末のプレビューは素の映像）
  const useChroma = mode === 'obs' && fx.chromaOn;
  video.hidden = useChroma;
  canvas.hidden = !useChroma;
}

function updateControls() {
  const all = { ...fx, ...cam };
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = all[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.value !== String(v)) el.value = v;
    if (el.type === 'range') el.parentElement.querySelector('output').textContent = v;
  });
}

function fillDeviceSelects() {
  document.querySelectorAll('select[data-key="deviceId"]').forEach((sel) => {
    sel.innerHTML = '';
    devices.forEach((d) => sel.add(new Option(d.label, d.id)));
    sel.value = cam.deviceId || devices[0]?.id || '';
  });
}

// data-key 付きの入力を一括でバインド
function bindControls() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      if (CAM_KEYS.includes(key)) {
        cam[key] = value;
        if (mode === 'control') send({ t: 'camera', cam });          // 操作端末→ハブ→カメラ
        else { localStorage.setItem(CAM_KEY, JSON.stringify(cam)); startCamera(); }
      } else {
        fx[key] = value;
        send({ t: 'fx', fx });                                        // 操作端末→ハブ
      }
      updateControls();
    });
  });
  $('#resetBtn').addEventListener('click', () => {
    fx = { ...FX_DEFAULTS }; send({ t: 'fx', fx }); updateControls();
  });
}

// ---------- 5. 通信（PeerJS） ----------
// ID規則：ハブは固定ID、カメラ/操作は重複を避けるためランダム接尾辞付き
const hubId = () => `obscamera-${room}-hub`;
const rnd = () => Math.random().toString(36).slice(2, 7);
let peer = null;
let hubConn = null;       // カメラ/操作側：ハブへのデータ接続
let mediaCall = null;     // カメラ側：映像の通話
let camConn = null;       // ハブ側：カメラ端末のデータ接続
const ctlConns = new Set(); // ハブ側：操作端末のデータ接続

// カメラ/操作側からハブへ送信
function send(msg) { if (hubConn?.open) hubConn.send(msg); }

// ----- 5a. ハブ（OBS画面） -----
function startHub() {
  peer = new Peer(hubId());
  peer.on('open', () => setStatus('待機中：カメラ端末を接続してください'));
  peer.on('error', (e) => setStatus(e.type === 'unavailable-id'
    ? '同じルームのOBS画面が既に開かれています' : `接続エラー：${e.type}`));

  // 映像を受信（応答は受信専用）
  peer.on('call', (call) => {
    call.answer();
    call.on('stream', (s) => { video.srcObject = s; setStatus(''); });
  });

  // データ接続（カメラ/操作からの指示）
  peer.on('connection', (conn) => {
    conn.on('data', (d) => hubReceive(conn, d));
    conn.on('close', () => {
      ctlConns.delete(conn);
      if (conn === camConn) { camConn = null; camOnline = false; broadcastState(); }
    });
  });
}

function hubReceive(conn, d) {
  if (d.t === 'hello') {
    if (d.role === 'cam') { camConn = conn; camOnline = true; } else ctlConns.add(conn);
    broadcastState();
  } else if (d.t === 'devices') {          // カメラ→ハブ：デバイス一覧と現在設定
    devices = d.devices; cam = d.cam; broadcastState();
  } else if (d.t === 'fx') {               // 操作→ハブ：エフェクト変更
    fx = { ...FX_DEFAULTS, ...d.fx };
    localStorage.setItem(FX_KEY, JSON.stringify(fx));
    applyFx(); broadcastState();
  } else if (d.t === 'camera') {           // 操作→ハブ→カメラ：カメラ切替
    if (camConn?.open) camConn.send(d);
  }
}

function broadcastState() {
  const msg = { t: 'state', fx, cam, devices, camOnline };
  ctlConns.forEach((c) => c.open && c.send(msg));
}

// ----- 5b. カメラ/操作端末：ハブへ接続（切れたら自動で再試行） -----
function startClient(role) {
  peer = new Peer(`obscamera-${room}-${role}-${rnd()}`);
  peer.on('open', () => connectHub(role));
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') {
      setStatus('OBS画面が見つかりません。先にPCでOBS用URLを開いてください');
      setTimeout(() => connectHub(role), 3000);
    } else setStatus(`接続エラー：${e.type}`);
  });
}

function connectHub(role) {
  if (hubConn?.open) return;
  hubConn = peer.connect(hubId(), { reliable: true });
  hubConn.on('open', () => {
    send({ t: 'hello', role: role === 'cam' ? 'cam' : 'ctl' });
    setStatus('OBS画面に接続しました');
    if (role === 'cam') { sendDevices(); publishStream(); }
  });
  hubConn.on('data', (d) => {
    if (d.t === 'camera' && role === 'cam') {            // 操作端末からのカメラ切替
      cam = { ...cam, ...d.cam };
      localStorage.setItem(CAM_KEY, JSON.stringify(cam));
      startCamera();
    } else if (d.t === 'state' && role === 'ctl') {      // ハブの最新状態
      fx = d.fx; cam = d.cam; devices = d.devices; camOnline = d.camOnline;
      setStatus(camOnline ? 'カメラ端末：接続中' : 'カメラ端末が未接続です');
      fillDeviceSelects(); updateControls();
    }
  });
  hubConn.on('close', () => { setStatus('接続が切れました。再接続中…'); setTimeout(() => connectHub(role), 2000); });
}

// ---------- 6. カメラ（カメラ端末のみ） ----------
let stream = null;

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const [w, h] = cam.resolution.split('x').map(Number);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: w }, height: { ideal: h },
               ...(cam.deviceId ? { deviceId: { exact: cam.deviceId } } : {}) }
    });
    video.srcObject = stream;
    await refreshDevices();   // 権限取得後でないとデバイス名が取れない
    sendDevices(); publishStream();
  } catch (err) {
    if (err.name === 'OverconstrainedError' && cam.deviceId) { cam.deviceId = ''; return startCamera(); }
    setStatus(`カメラを起動できません：${err.name}（許可設定とHTTPSを確認してください）`);
  }
}

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  devices = all.filter((d) => d.kind === 'videoinput')
               .map((d, i) => ({ id: d.deviceId, label: d.label || `カメラ ${i + 1}` }));
  if (!cam.deviceId) cam.deviceId = stream?.getVideoTracks()[0]?.getSettings().deviceId || '';
  fillDeviceSelects(); updateControls();
}

const sendDevices = () => send({ t: 'devices', devices, cam });

// 映像をハブへ送る（カメラ切替時は通話をやり直す）
function publishStream() {
  if (!stream || !hubConn?.open) return;
  mediaCall?.close();
  mediaCall = peer.call(hubId(), stream);
}

// ---------- 7. クロマキー（OBS画面のみ・毎フレーム） ----------
function chromaLoop() {
  if (mode === 'obs' && fx.chromaOn && video.videoWidth) {
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const kr = parseInt(fx.keyColor.slice(1, 3), 16);
    const kg = parseInt(fx.keyColor.slice(3, 5), 16);
    const kb = parseInt(fx.keyColor.slice(5, 7), 16);
    const sim = fx.similarity / 100, smooth = Math.max(fx.smooth / 100, 0.001);
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.hypot(d[i] - kr, d[i + 1] - kg, d[i + 2] - kb) / 441.67; // 0〜1に正規化
      if (dist < sim) d[i + 3] = 0;
      else if (dist < sim + smooth) d[i + 3] = ((dist - sim) / smooth) * 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  requestAnimationFrame(chromaLoop);
}

// ---------- 8. ホーム画面（URL生成） ----------
function renderHome() {
  const input = $('#roomInput');
  input.value = room;
  const draw = () => {
    const base = location.origin + location.pathname;
    const items = [['PC（OBSに貼るURL）', 'obs'], ['A端末（カメラ）', 'camera'], ['B端末（操作）', 'control']];
    $('#links').innerHTML = '';
    for (const [label, m] of items) {
      const url = `${base}?mode=${m}&room=${encodeURIComponent(room)}`;
      const row = document.createElement('div');
      row.className = 'link';
      row.innerHTML = `<span>${label}</span><input type="text" readonly><button class="copy" type="button">コピー</button>`;
      row.querySelector('input').value = url;
      row.querySelector('button').onclick = async () => {
        try { await navigator.clipboard.writeText(url); setStatus(`${label}のURLをコピーしました`); }
        catch { row.querySelector('input').select(); }
      };
      $('#links').append(row);
    }
  };
  input.addEventListener('input', () => {
    room = input.value.trim().replace(/[^\w-]/g, '') || room;
    localStorage.setItem(ROOM_KEY, room); draw();
  });
  draw();
}

// ---------- 9. 起動 ----------
bindControls();
applyFx();
updateControls();
if (mode === 'home') renderHome();
if (mode === 'obs') { startHub(); chromaLoop(); }
if (mode === 'camera') { startClient('cam'); startCamera(); }
if (mode === 'control') startClient('ctl');
