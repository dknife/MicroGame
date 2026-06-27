'use strict';

// 3D 렌더러 — 게임 로직(game.js)은 그대로 두고 화면/입력만 담당한다.
// 각 칸은 뚜껑 달린 박스. 더블클릭(탭 2회)으로 뚜껑이 열리며,
// 보석(고양이)이 있으면 보석이 드러나고, 없으면 독성 연기가 피어오른다.
// 빈 공간 드래그 = 그리드 회전, 박스 위 드래그 = 마킹 (game.js가 처리).

import * as THREE from './vendor/three.module.js';

// 영역 색 / 고양이 얼굴 — game.js와 동일한 값 (렌더러에서 직접 참조)
const REGION_COLORS = [
  '#f9c74f', '#90be6d', '#f8961e', '#43aa8b', '#577590',
  '#f94144', '#c77dff', '#4cc9f0', '#ff99c8', '#a98467',
  '#f72585', '#e0e1dd',
];

// ---- 박스 치수 ----
const CELL = 1.0;        // 칸 간격
const BOX = 0.86;        // 박스 한 변
const BASE_H = 0.55;     // 박스 몸통 높이
const LID_H = 0.13;      // 뚜껑 두께
const WALL_T = 0.08;     // 상자 벽 두께
const SINK = 0.32;       // 오답 박스가 눌려 가라앉는 깊이
const GEM_REST_Y = WALL_T + 0.18;     // 보석이 상자 바닥에 놓인 높이(1.5배 크기 기준)
const GEM_RISE_Y = BASE_H + LID_H;    // 열리면 뚜껑이 있던 높이까지 떠오름

let scene, camera, renderer, raycaster;
let boardGroup;          // 모든 박스를 담는 그룹 (회전/흔들림 적용)
let boxes = [];          // [r][c] -> 박스 정보 객체
let size = 0;
let boardData = null;
let callbacks = {};
let canvas;
let container;

// 카메라 궤도(orbit) 상태
const orbit = { theta: 0, phi: 0.95, radius: 12, target: new THREE.Vector3(0, 0, 0) };

// 입력 상태
// 제스처: 드래그=회전, 길게 눌러 드래그=마킹, 더블탭=상자 열기, 두 손가락=핀치 줌
const pointer = new THREE.Vector2();
const pointers = new Map();  // 활성 포인터 id -> {x, y} (멀티터치/핀치용)
let gesture = null;          // 'pending' | 'orbit' | 'mark' | 'pinch' | null
let pressCell = null;        // 눌린 지점의 칸 {r,c} 또는 null
let lastMarkCell = null;     // 마킹 드래그 중 마지막으로 들어간 칸
let downX = 0, downY = 0;    // 눌린 좌표 (회전 전환/탭 판정)
let lastPx = 0, lastPy = 0;  // 회전 드래그 이전 좌표
let longPressTimer = null;   // 길게 누르기 → 마킹 모드 진입 타이머
let pinchStartDist = 0, pinchStartRadius = 0;
const LONG_PRESS_MS = 400;
const MOVE_THRESH2 = 64;     // 회전으로 전환되는 이동 임계값 (px², 8px)

// 애니메이션 대상
const sinkTweens = new Map();  // boxKey -> 박스 가라앉기 트윈
const riseTweens = new Map();  // boxKey -> 보석 떠오르기 트윈
const emitters = [];           // 오답 박스의 지속 연기 방출기 [{ b, acc }]
const smokes = [];             // 활성 연기 파티클 그룹
let shakeTime = 0;             // 남은 흔들림 시간
const clock = new THREE.Clock();

// ---------- 초기화 ----------

export function initRenderer(host, cbs) {
  callbacks = cbs || {};
  container = host;

  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // PBR 금속/유리 룩
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);
  canvas = renderer.domElement;
  canvas.style.touchAction = 'none'; // 터치 드래그가 스크롤 대신 입력이 되도록
  canvas.style.display = 'block';

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

  // 조명
  scene.add(new THREE.HemisphereLight(0xffffff, 0x55607a, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(6, 12, 8);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 60;
  const d = 14;
  dir.shadow.camera.left = -d;
  dir.shadow.camera.right = d;
  dir.shadow.camera.top = d;
  dir.shadow.camera.bottom = -d;
  scene.add(dir);

  boardGroup = new THREE.Group();
  scene.add(boardGroup);

  // 바닥 (그림자 받기)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.18 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  ground.receiveShadow = true;
  scene.add(ground);

  buildEnvironment(); // 금속/유리 반사·굴절용 환경맵

  raycaster = new THREE.Raycaster();

  bindPointer();
  // iOS Safari는 초기 레이아웃/주소창 변화/회전 시 크기를 늦게 확정하므로
  // 여러 경로로 리사이즈를 다시 잡아 캔버스 어긋남을 막는다.
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(container);
  onResize();
  requestAnimationFrame(onResize);
  setTimeout(onResize, 300);
  animate();
}

function onResize() {
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, true); // 인라인 스타일까지 갱신해 CSS와 어긋나지 않게
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- 보드 생성 ----------

export function buildBoard(n, board) {
  size = n;
  boardData = board;
  sinkTweens.clear();
  riseTweens.clear();
  emitters.length = 0;
  for (const g of smokes) boardGroup.remove(g.group);
  smokes.length = 0;

  // 기존 박스 제거 + 자원 해제
  for (const row of boxes) {
    for (const b of row) {
      boardGroup.remove(b.group);
      b.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
        }
      });
    }
  }
  boxes = [];

  const off = (n - 1) / 2;
  const lidGeo = new THREE.BoxGeometry(BOX, LID_H, BOX);
  // 속이 빈 상자: 바닥 + 네 벽 (다이아몬드가 안에 보이도록)
  const floorGeo = new THREE.BoxGeometry(BOX, WALL_T, BOX);
  const wallNSGeo = new THREE.BoxGeometry(BOX, BASE_H, WALL_T);
  const wallEWGeo = new THREE.BoxGeometry(WALL_T, BASE_H, BOX - 2 * WALL_T);

  for (let r = 0; r < n; r++) {
    boxes.push([]);
    for (let c = 0; c < n; c++) {
      const reg = board.regions[r][c];
      const color = new THREE.Color(REGION_COLORS[reg % REGION_COLORS.length]);
      const cx = (c - off) * CELL;
      const cz = (r - off) * CELL;

      const group = new THREE.Group();
      group.position.set(cx, 0, cz);

      // 몸통 — 속이 빈 상자 (바닥 + 네 벽), 스크래치 메탈
      const ud = { r, c };
      const scr = scratchTexture();
      const nrm = metalNormalTexture();
      const bodyMat = new THREE.MeshStandardMaterial({
        color, metalness: 0.95, roughness: 0.45,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8),
        envMapIntensity: 1.0,
      });
      const wallMat = new THREE.MeshStandardMaterial({
        color: color.clone().multiplyScalar(0.9), metalness: 0.95, roughness: 0.5,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8),
        envMapIntensity: 1.0,
      });
      const mk = (geo, mat, x, y, z) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData = ud;
        group.add(m);
        return m;
      };
      const floor = mk(floorGeo, bodyMat, 0, WALL_T / 2, 0);
      const wallBack = mk(wallNSGeo, wallMat, 0, BASE_H / 2, BOX / 2 - WALL_T / 2);
      const wallFront = mk(wallNSGeo, wallMat, 0, BASE_H / 2, -BOX / 2 + WALL_T / 2);
      const wallRight = mk(wallEWGeo, wallMat, BOX / 2 - WALL_T / 2, BASE_H / 2, 0);
      const wallLeft = mk(wallEWGeo, wallMat, -BOX / 2 + WALL_T / 2, BASE_H / 2, 0);

      // 뚜껑 (뒤 모서리에서 경첩 회전)
      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, BASE_H, BOX / 2);
      const lidMat = new THREE.MeshStandardMaterial({
        color: color.clone().multiplyScalar(1.05), metalness: 0.95, roughness: 0.45,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8),
        envMapIntensity: 1.0,
      });
      const lid = new THREE.Mesh(lidGeo, lidMat);
      lid.position.set(0, LID_H / 2, -BOX / 2);
      lid.castShadow = true;
      lid.receiveShadow = true;
      lid.userData = { r, c };
      lidPivot.add(lid);

      // 뚜껑 위 마킹 면 (캔버스 텍스처)
      const markCanvas = document.createElement('canvas');
      markCanvas.width = markCanvas.height = 128;
      const markTex = new THREE.CanvasTexture(markCanvas);
      markTex.anisotropy = 4;
      const markMat = new THREE.MeshBasicMaterial({ map: markTex, transparent: true });
      const markPlane = new THREE.Mesh(new THREE.PlaneGeometry(BOX * 0.82, BOX * 0.82), markMat);
      markPlane.rotation.x = -Math.PI / 2;
      markPlane.position.set(0, LID_H + 0.012, -BOX / 2);
      lidPivot.add(markPlane);
      group.add(lidPivot);

      // 다이아몬드 (열리면 상자 안에서 드러남) — 크라운(윗부분) + 파빌리온(아랫부분)
      const gem = new THREE.Group();
      const gemMat = new THREE.MeshPhysicalMaterial({
        color: color.clone().lerp(new THREE.Color(0xffffff), 0.5),
        metalness: 0.0, roughness: 0.0,
        transmission: 1.0, thickness: 0.6, ior: 2.2, // 굴절 유리(다이아몬드급 ior)
        specularIntensity: 1.0, envMapIntensity: 1.3,
        transparent: true,
        emissive: color.clone().multiplyScalar(0.25),
        emissiveIntensity: 0.45,
        flatShading: true,
      });
      const pavilion = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 8), gemMat);
      pavilion.rotation.x = Math.PI; // 뾰족한 끝이 아래로
      gem.add(pavilion);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.16, 0.09, 8), gemMat);
      crown.position.y = 0.12 + 0.045; // 거들 위에 얹기
      gem.add(crown);
      // 보석이 실제로 빛을 내도록 점광원 — 열리면(gem.visible) 함께 켜진다
      const gemLight = new THREE.PointLight(
        color.clone().lerp(new THREE.Color(0xffffff), 0.4), 0, 2.6, 2
      );
      gemLight.position.set(0, 0.2, 0);
      gem.add(gemLight);
      // 반짝이 스파클 (반짝반짝 빛남) — 보석에 붙어 깜빡인다
      const sparkles = [];
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: starTexture(), color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        const ang = (i / 3) * Math.PI * 2 + Math.random();
        const rad = 0.07 + Math.random() * 0.12;
        sp.position.set(Math.cos(ang) * rad, 0.1 + Math.random() * 0.16, Math.sin(ang) * rad);
        sp.scale.set(0.08, 0.08, 0.08);
        gem.add(sp);
        sparkles.push({ sprite: sp, phase: Math.random() * Math.PI * 2, speed: 4 + Math.random() * 4 });
      }
      gem.scale.setScalar(1.5); // 보석 1.5배
      gem.position.set(0, GEM_REST_Y, 0); // 처음엔 상자 바닥에
      gem.visible = false;
      group.add(gem);

      boardGroup.add(group);
      boxes[r].push({
        group, lidPivot, lid, gem, gemMat, gemLight, sparkles, wrong: false,
        lidT: 0, lidOpen: false, // 0=닫힘, 1=완전히 열려 옆에 눕힘
        pickParts: [lid, floor, wallBack, wallFront, wallRight, wallLeft],
        markCanvas, markCtx: markCanvas.getContext('2d'), markTex,
        reg, mark: 'none', revealed: false, flashOpen: false,
      });
      drawMark(boxes[r][c], 'none');
    }
  }

  // 카메라 거리: 보드 크기에 맞춰
  orbit.radius = n * 1.5 + 4;
  orbit.target.set(0, 0, 0);
  updateCamera();
}

// ---------- 상태 동기화 ----------
// game.js의 render()가 호출. 셀 상태와 비교해 변화에 맞춰 애니메이션을 건다.

export function syncState(state) {
  if (!boxes.length) return;
  const { cells, flashing } = state;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const b = boxes[r][c];
      const cell = cells[r][c];
      const isFlash = flashing && flashing.r === r && flashing.c === c;

      // 보석 공개 (한 번만): 뚜껑 열고 보석이 뚜껑 높이까지 떠오른다
      if (cell.revealed && !b.revealed) {
        b.revealed = true;
        openLid(b);
        b.gem.visible = true;
        b.gem.position.y = GEM_REST_Y;
        riseTweens.set(lidKey(b), { obj: b.gem, from: GEM_REST_Y, to: GEM_RISE_Y, t: 0, dur: 1.1, ease: easeOutBackUp });
        drawMark(b, 'none');
      }

      // 오답 직후 잠깐(flashing): 뚜껑 열고 연기 한 번
      if (isFlash && !b.flashOpen) {
        b.flashOpen = true;
        openLid(b);
        spawnSmoke(b);
      } else if (!isFlash && b.flashOpen && !b.revealed && cell.mark !== 'wrong') {
        b.flashOpen = false;
        closeLid(b);
      }

      // 오답 확정: 박스가 눌려 가라앉은 채 뚜껑을 열어두고 연기를 계속 뿜는다
      if (cell.mark === 'wrong' && !b.wrong) {
        b.wrong = true;
        b.flashOpen = false;
        openLid(b);
        sinkBox(b);
        emitters.push({ b, acc: 0 });
      }

      // 마킹 텍스처 갱신 (오답 박스는 연기로 표현하므로 면 마킹 없음)
      const wantMark = (cell.revealed || cell.mark === 'wrong') ? 'none' : cell.mark;
      if (wantMark !== b.mark) drawMark(b, wantMark);
    }
  }
}

export function shake() {
  shakeTime = 0.6;
}

// ---------- 뚜껑 애니메이션 ----------

function lidKey(b) { return b.lid.userData.r + ',' + b.lid.userData.c; }

function openLid(b) { b.lidOpen = true; }
function closeLid(b) { b.lidOpen = false; }

// 뚜껑 진행값 lidT(0~1)을 회전/높이로 변환.
// 1단계: 90도(수직)까지 들어올림. 2단계: 뒤로 넘기며 바닥으로 내려 상자 옆에 눕힘.
function applyLid(b) {
  const t = b.lidT;
  const P = 0.5; // 1단계(열기) 비중
  let rot, y;
  if (t <= P) {
    rot = (Math.PI / 2) * easeOut(t / P); // 0 → 90도
    y = BASE_H;
  } else {
    const e = easeInOutCubic((t - P) / (1 - P));
    rot = Math.PI / 2 + (Math.PI / 2) * e;     // 90도 → 180도(눕힘)
    y = BASE_H + (LID_H - BASE_H) * e;          // 경첩을 바닥까지 내림
  }
  b.lidPivot.rotation.x = rot;
  b.lidPivot.position.y = y;
}

// 오답 박스를 눌러 가라앉힌다
function sinkBox(b) {
  sinkTweens.set(lidKey(b), { obj: b.group, from: b.group.position.y, to: -SINK, t: 0, dur: 0.4, ease: easeOut });
}

function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
// 끝에서 살짝 튀어오르는 느낌 (보석이 떠오를 때)
function easeOutBackUp(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// ---------- 마킹 그리기 ----------

function drawMark(b, mark) {
  b.mark = mark;
  const ctx = b.markCtx;
  const S = b.markCanvas.width;
  ctx.clearRect(0, 0, S, S);
  if (mark === 'paw') {
    // 검은 페인트를 붓으로 칠한 듯한 굵은 X
    const m = S * 0.24, n = S * 0.76;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0d0d0d';
    ctx.lineWidth = S * 0.17;
    ctx.beginPath();
    ctx.moveTo(m, m); ctx.lineTo(n, n);
    ctx.moveTo(n, m); ctx.lineTo(m, n);
    ctx.stroke();
    // 살짝 어긋나게 덧칠해 페인트 질감
    ctx.strokeStyle = 'rgba(20,20,20,0.5)';
    ctx.lineWidth = S * 0.08;
    ctx.beginPath();
    ctx.moveTo(m + 4, m - 3); ctx.lineTo(n - 3, n + 4);
    ctx.moveTo(n - 4, m + 3); ctx.lineTo(m + 3, n - 4);
    ctx.stroke();
  }
  b.markTex.needsUpdate = true;
}

// ---------- 독성 연기 파티클 ----------

function spawnSmoke(b, opts) {
  const count = (opts && opts.count) || 14;
  const life = (opts && opts.life) || 1.1;
  const group = new THREE.Group();
  group.position.copy(b.group.position);
  group.position.y = b.group.position.y + BASE_H; // 가라앉은 박스의 입구에서 피어오르게
  const parts = [];
  const tex = smokeTexture();
  const smokeColor = REGION_COLORS[b.reg % REGION_COLORS.length]; // 박스 색과 같은 연기
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex, color: smokeColor, transparent: true, opacity: 0.0, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const a = Math.random() * Math.PI * 2;
    const rad = Math.random() * 0.22;
    s.position.set(Math.cos(a) * rad, Math.random() * 0.1, Math.sin(a) * rad);
    const sc = 0.25 + Math.random() * 0.25;
    s.scale.set(sc, sc, sc);
    group.add(s);
    parts.push({
      s,
      vy: 0.6 + Math.random() * 0.7,
      vx: (Math.random() - 0.5) * 0.5,
      vz: (Math.random() - 0.5) * 0.5,
      grow: 1.5 + Math.random(),
      delay: Math.random() * 0.15,
    });
  }
  boardGroup.add(group);
  smokes.push({ group, parts, t: 0, life });
}

let _starTex = null;
function starTexture() {
  if (_starTex) return _starTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 10);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 10, 0, Math.PI * 2); ctx.fill();
  // 4방향으로 뻗는 빛줄기
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(32, 2); ctx.lineTo(32, 62);
  ctx.moveTo(2, 32); ctx.lineTo(62, 32);
  ctx.stroke();
  _starTex = new THREE.CanvasTexture(cv);
  return _starTex;
}

// ---------- 환경맵 (금속/유리 반사·굴절) ----------

function buildEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const ctx = cv.getContext('2d');
  // 위는 밝은 하늘빛, 가운데 밝은 띠(주광), 아래는 어두운 바닥 — 반사에 명암을 준다
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#cdd6ea');
  g.addColorStop(0.35, '#9aa7c4');
  g.addColorStop(0.5, '#ffffff');
  g.addColorStop(0.65, '#6b7590');
  g.addColorStop(1.0, '#20242f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
}

// ---------- 스크래치 메탈 텍스처 (절차 생성) ----------

let _scratchTex = null;
function scratchTexture() {
  if (_scratchTex) return _scratchTex;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#8a8a8a'; // 중간 거칠기 베이스
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const ang = Math.random() * Math.PI * 2;
    const len = 8 + Math.random() * 90;
    const v = Math.random();
    // 밝은 스크래치(매끈=낮은 거칠기) / 어두운 스크래치(거침) 혼합
    ctx.strokeStyle = v > 0.5
      ? `rgba(235,235,235,${0.15 + Math.random() * 0.5})`
      : `rgba(35,35,35,${0.15 + Math.random() * 0.5})`;
    ctx.lineWidth = Math.random() < 0.85 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  _scratchTex = new THREE.CanvasTexture(cv);
  _scratchTex.wrapS = _scratchTex.wrapT = THREE.RepeatWrapping;
  return _scratchTex;
}

// 울퉁불퉁한 금속 표면 노멀맵 — 범프(돌기/패임) + 스크래치 높이장에서 유도
let _metalNrm = null;
function metalNormalTexture() {
  if (_metalNrm) return _metalNrm;
  const S = 256;
  // 1) 높이장(height field) 그리기
  const hc = document.createElement('canvas');
  hc.width = hc.height = S;
  const hx = hc.getContext('2d');
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) { // 울퉁불퉁 돌기/패임
    const x = Math.random() * S, y = Math.random() * S, r = 6 + Math.random() * 38;
    const c = Math.random() > 0.5 ? '255,255,255' : '0,0,0';
    const g = hx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${c},${0.2 + Math.random() * 0.4})`);
    g.addColorStop(1, `rgba(${c},0)`);
    hx.fillStyle = g;
    hx.beginPath(); hx.arc(x, y, r, 0, Math.PI * 2); hx.fill();
  }
  hx.lineCap = 'round';
  for (let i = 0; i < 500; i++) { // 스크래치 홈
    const x = Math.random() * S, y = Math.random() * S, a = Math.random() * Math.PI * 2, len = 6 + Math.random() * 55;
    hx.strokeStyle = Math.random() > 0.5
      ? `rgba(255,255,255,${0.2 + Math.random() * 0.4})`
      : `rgba(0,0,0,${0.2 + Math.random() * 0.4})`;
    hx.lineWidth = Math.random() < 0.85 ? 1 : 2;
    hx.beginPath(); hx.moveTo(x, y); hx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); hx.stroke();
  }
  // 2) 높이장 → 노멀맵 (이웃 밝기 기울기로 법선 계산)
  const hd = hx.getImageData(0, 0, S, S).data;
  const at = (x, y) => hd[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
  const nc = document.createElement('canvas');
  nc.width = nc.height = S;
  const nx = nc.getContext('2d');
  const nimg = nx.createImageData(S, S);
  const nd = nimg.data;
  const strength = 2.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      let dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      let dz = 1.0;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      const o = (y * S + x) * 4;
      nd[o] = (dx * 0.5 + 0.5) * 255;
      nd[o + 1] = (dy * 0.5 + 0.5) * 255;
      nd[o + 2] = (dz * 0.5 + 0.5) * 255;
      nd[o + 3] = 255;
    }
  }
  nx.putImageData(nimg, 0, 0);
  _metalNrm = new THREE.CanvasTexture(nc);
  _metalNrm.wrapS = _metalNrm.wrapT = THREE.RepeatWrapping;
  return _metalNrm;
}

let _smokeTex = null;
function smokeTexture() {
  if (_smokeTex) return _smokeTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _smokeTex = new THREE.CanvasTexture(cv);
  return _smokeTex;
}

// ---------- 카메라 / 입력 ----------

function updateCamera() {
  const { theta, phi, radius, target } = orbit;
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(target);
}

function setPointerNDC(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

// 레이캐스트로 포인터 아래 칸 찾기
function pickCell() {
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  for (const row of boxes) for (const b of row) { for (const m of b.pickParts) meshes.push(m); }
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const ud = hits[0].object.userData;
  return { r: ud.r, c: ud.c };
}

function bindPointer() {
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 두 번째 손가락 → 핀치 줌. 진행 중이던 단일 제스처는 정리
    if (pointers.size >= 2) {
      clearTimeout(longPressTimer);
      if (gesture === 'mark') callbacks.onUp && callbacks.onUp();
      gesture = 'pinch';
      const p = [...pointers.values()];
      pinchStartDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
      pinchStartRadius = orbit.radius;
      return;
    }

    // 단일 포인터: 기본은 회전 대기. 길게 누르면 마킹 모드.
    setPointerNDC(e);
    downX = lastPx = e.clientX; downY = lastPy = e.clientY;
    pressCell = pickCell();
    lastMarkCell = null;
    gesture = 'pending';
    clearTimeout(longPressTimer);
    if (e.button === 2) { gesture = 'orbit'; return; } // 우클릭은 항상 회전
    if (pressCell) {
      const cell = pressCell;
      longPressTimer = setTimeout(() => {
        gesture = 'mark'; // 길게 누름 → 마킹 시작, 시작 칸부터 적용
        lastMarkCell = cell;
        callbacks.onDown && callbacks.onDown(cell.r, cell.c, 0);
        callbacks.onEnter && callbacks.onEnter(cell.r, cell.c);
      }, LONG_PRESS_MS);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture === 'pinch') {
      if (pointers.size < 2) return;
      const p = [...pointers.values()];
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
      orbit.radius = Math.max(4, Math.min(40, pinchStartRadius * (pinchStartDist / dist)));
      updateCamera();
      return;
    }
    if (gesture === 'pending') {
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (dx * dx + dy * dy > MOVE_THRESH2) {
        gesture = 'orbit'; // 움직이면 회전 (길게 누르기 취소)
        clearTimeout(longPressTimer);
        lastPx = e.clientX; lastPy = e.clientY;
      }
      return;
    }
    if (gesture === 'orbit') {
      const dx = e.clientX - lastPx, dy = e.clientY - lastPy;
      lastPx = e.clientX; lastPy = e.clientY;
      orbit.theta -= dx * 0.008;
      orbit.phi = Math.max(0.15, Math.min(1.45, orbit.phi - dy * 0.008));
      updateCamera();
    } else if (gesture === 'mark') {
      setPointerNDC(e);
      const cell = pickCell();
      if (cell && (cell.r !== lastMarkCell.r || cell.c !== lastMarkCell.c)) {
        lastMarkCell = cell;
        callbacks.onEnter && callbacks.onEnter(cell.r, cell.c);
      }
    }
  });

  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (gesture === 'pinch') {
      // 손가락 하나가 떨어지면 핀치 종료 (남은 손가락 점프 방지)
      gesture = null;
      pressCell = null; lastMarkCell = null;
      return;
    }
    const g = gesture;
    gesture = null;
    if (g === 'mark') {
      callbacks.onUp && callbacks.onUp();
    } else if (g === 'pending' && pressCell) {
      // 움직임/길게누름 없이 뗌 = 탭 → 더블탭 감지(상자 열기)로 전달
      callbacks.onTap && callbacks.onTap(pressCell.r, pressCell.c);
    }
    pressCell = null; lastMarkCell = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 휠 줌
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.radius = Math.max(4, Math.min(40, orbit.radius + Math.sign(e.deltaY) * 0.8));
    updateCamera();
  }, { passive: false });

  // 우클릭 메뉴 차단 (회전에 사용)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- 루프 ----------

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // 뚜껑: 90도까지 열고 → 뒤로 눕혀 바닥에 놓기 (열기 1.5s / 닫기 0.8s)
  for (const row of boxes) for (const b of row) {
    const target = b.lidOpen ? 1 : 0;
    if (b.lidT === target) continue;
    if (target > b.lidT) b.lidT = Math.min(1, b.lidT + dt / 1.5);
    else b.lidT = Math.max(0, b.lidT - dt / 0.8);
    applyLid(b);
  }

  // 박스 가라앉기(오답) / 보석 떠오르기 트윈 — 둘 다 position.y
  for (const tweens of [sinkTweens, riseTweens]) {
    for (const [key, tw] of tweens) {
      tw.t += dt / tw.dur;
      if (tw.t >= 1) {
        tw.obj.position.y = tw.to;
        tweens.delete(key);
      } else {
        const e = (tw.ease || easeOut)(tw.t);
        tw.obj.position.y = tw.from + (tw.to - tw.from) * e;
      }
    }
  }

  // 보석: 천천히 회전 + 글로우 맥동 + 스파클 반짝임
  const time = clock.elapsedTime;
  for (const row of boxes) for (const b of row) {
    if (!b.gem.visible) continue;
    b.gem.rotation.y += dt * 1.4;
    const pulse = 0.5 + 0.5 * Math.sin(time * 3 + b.reg); // 0~1
    b.gemMat.emissiveIntensity = 0.5 + 0.6 * pulse;
    b.gemLight.intensity = 1.4 + 1.0 * pulse; // 실제 발광
    for (const sp of b.sparkles) {
      const tw = Math.sin(time * sp.speed + sp.phase);
      const o = Math.max(0, tw);
      sp.sprite.material.opacity = o * o;
      const sc = 0.05 + 0.13 * o;
      sp.sprite.scale.set(sc, sc, sc);
    }
  }

  // 오답 박스: 연기를 주기적으로 계속 뿜는다
  for (const em of emitters) {
    em.acc += dt;
    if (em.acc >= 0.45) {
      em.acc = 0;
      spawnSmoke(em.b, { count: 6, life: 1.6 });
    }
  }

  // 연기
  for (let i = smokes.length - 1; i >= 0; i--) {
    const sm = smokes[i];
    sm.t += dt;
    for (const p of sm.parts) {
      if (sm.t < p.delay) continue;
      const lt = sm.t - p.delay;
      p.s.position.x += p.vx * dt;
      p.s.position.y += p.vy * dt;
      p.s.position.z += p.vz * dt;
      const sc = p.s.scale.x + p.grow * dt * 0.4;
      p.s.scale.set(sc, sc, sc);
      const k = Math.min(1, lt / (sm.life - p.delay));
      p.s.material.opacity = Math.sin(k * Math.PI) * 0.7;
    }
    if (sm.t >= sm.life) {
      boardGroup.remove(sm.group);
      sm.group.traverse((o) => { if (o.material) o.material.dispose(); });
      smokes.splice(i, 1);
    }
  }

  // 보드 흔들림
  if (shakeTime > 0) {
    shakeTime = Math.max(0, shakeTime - dt);
    const a = shakeTime * 0.12;
    boardGroup.position.x = (Math.random() - 0.5) * a * 6;
    boardGroup.position.z = (Math.random() - 0.5) * a * 6;
    boardGroup.rotation.z = (Math.random() - 0.5) * a;
  } else {
    boardGroup.position.x = boardGroup.position.z = 0;
    boardGroup.rotation.z = 0;
  }

  renderer.render(scene, camera);
}
