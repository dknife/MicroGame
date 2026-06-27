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
const OPEN_ANGLE = Math.PI / 2; // 뚜껑 열림 각도 — 박스 옆에 수직으로 세움

let scene, camera, renderer, raycaster;
let boardGroup;          // 모든 박스를 담는 그룹 (회전/흔들림 적용)
let boxes = [];          // [r][c] -> 박스 정보 객체
let size = 0;
let boardData = null;
let callbacks = {};
let canvas;

// 카메라 궤도(orbit) 상태
const orbit = { theta: 0, phi: 0.95, radius: 12, target: new THREE.Vector3(0, 0, 0) };

// 입력 상태
const pointer = new THREE.Vector2();
let activePointer = null;   // 'mark' | 'orbit' | null
let markStart = null;       // { r, c }
let lastMarkCell = null;    // 드래그 중 마지막으로 들어간 칸 (중복 방지)
let lastPx = 0, lastPy = 0; // orbit 드래그용 이전 좌표

// 애니메이션 대상
const lidTweens = new Map();   // boxKey -> { from, to, t, dur }
const smokes = [];             // 활성 연기 파티클 그룹
let shakeTime = 0;             // 남은 흔들림 시간
const clock = new THREE.Clock();

// ---------- 초기화 ----------

export function initRenderer(container, cbs) {
  callbacks = cbs || {};

  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  canvas = renderer.domElement;
  canvas.style.touchAction = 'none'; // 터치 드래그가 스크롤 대신 입력이 되도록

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

  raycaster = new THREE.Raycaster();

  bindPointer();
  window.addEventListener('resize', onResize);
  onResize();
  animate();
}

function onResize() {
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- 보드 생성 ----------

export function buildBoard(n, board) {
  size = n;
  boardData = board;
  lidTweens.clear();
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

      // 몸통 — 속이 빈 상자 (바닥 + 네 벽)
      const ud = { r, c };
      const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
      const wallMat = new THREE.MeshStandardMaterial({
        color: color.clone().multiplyScalar(0.92), roughness: 0.6, metalness: 0.05,
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
        color: color.clone().multiplyScalar(1.08), roughness: 0.5, metalness: 0.05,
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
      const gemMat = new THREE.MeshStandardMaterial({
        color: color.clone().lerp(new THREE.Color(0xffffff), 0.45),
        roughness: 0.05, metalness: 0.35,
        emissive: color.clone().multiplyScalar(0.4),
        flatShading: true,
      });
      const pavilion = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 8), gemMat);
      pavilion.rotation.x = Math.PI; // 뾰족한 끝이 아래로
      pavilion.castShadow = true;
      gem.add(pavilion);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.16, 0.09, 8), gemMat);
      crown.position.y = 0.12 + 0.045; // 거들 위에 얹기
      crown.castShadow = true;
      gem.add(crown);
      gem.position.set(0, WALL_T + 0.12, 0); // 파빌리온 끝이 바닥에 닿도록
      gem.visible = false;
      group.add(gem);

      boardGroup.add(group);
      boxes[r].push({
        group, lidPivot, lid, gem,
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

      // 보석 공개 (한 번만)
      if (cell.revealed && !b.revealed) {
        b.revealed = true;
        openLid(b);
        b.gem.visible = true;
        drawMark(b, 'none');
      }

      // 오답 연기: flashing 동안 열고 연기, 끝나면 닫기
      if (isFlash && !b.flashOpen) {
        b.flashOpen = true;
        openLid(b);
        spawnSmoke(b);
      } else if (!isFlash && b.flashOpen && !b.revealed) {
        b.flashOpen = false;
        closeLid(b);
      }

      // 마킹 텍스처 갱신
      const wantMark = cell.revealed ? 'none' : cell.mark;
      if (wantMark !== b.mark) drawMark(b, wantMark);
    }
  }
}

export function shake() {
  shakeTime = 0.6;
}

// ---------- 뚜껑 애니메이션 ----------

function lidKey(b) { return b.lid.userData.r + ',' + b.lid.userData.c; }

function openLid(b) {
  // 천천히 열린다
  lidTweens.set(lidKey(b), { obj: b.lidPivot, from: b.lidPivot.rotation.x, to: OPEN_ANGLE, t: 0, dur: 1.3, ease: easeInOutCubic });
}
function closeLid(b) {
  lidTweens.set(lidKey(b), { obj: b.lidPivot, from: b.lidPivot.rotation.x, to: 0, t: 0, dur: 0.5, ease: easeInOutCubic });
}

function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// ---------- 마킹 그리기 ----------

function drawMark(b, mark) {
  b.mark = mark;
  const ctx = b.markCtx;
  const S = b.markCanvas.width;
  ctx.clearRect(0, 0, S, S);
  if (mark === 'paw' || mark === 'wrong') {
    ctx.font = `${S * 0.68}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (mark === 'wrong') {
      ctx.fillStyle = '#d11';
      ctx.font = `bold ${S * 0.7}px sans-serif`;
      ctx.fillText('✕', S / 2, S / 2 + S * 0.04);
    } else {
      ctx.fillText('🐾', S / 2, S / 2 + S * 0.04);
    }
  }
  b.markTex.needsUpdate = true;
}

// ---------- 독성 연기 파티클 ----------

function spawnSmoke(b) {
  const group = new THREE.Group();
  group.position.copy(b.group.position);
  group.position.y = BASE_H;
  const parts = [];
  const tex = smokeTexture();
  for (let i = 0; i < 14; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex, color: 0x7bdc5a, transparent: true, opacity: 0.0, depthWrite: false,
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
  smokes.push({ group, parts, t: 0, life: 1.1 });
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
    setPointerNDC(e);
    lastPx = e.clientX; lastPy = e.clientY;
    const cell = e.button === 2 ? null : pickCell(); // 우클릭은 항상 회전
    if (cell) {
      activePointer = 'mark';
      markStart = cell;
      lastMarkCell = cell;
      callbacks.onDown && callbacks.onDown(cell.r, cell.c, e.button);
    } else {
      activePointer = 'orbit';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointer) return;
    if (activePointer === 'orbit') {
      const dx = e.clientX - lastPx, dy = e.clientY - lastPy;
      lastPx = e.clientX; lastPy = e.clientY;
      orbit.theta -= dx * 0.008;
      orbit.phi = Math.max(0.15, Math.min(1.45, orbit.phi - dy * 0.008));
      updateCamera();
    } else if (activePointer === 'mark') {
      setPointerNDC(e);
      const cell = pickCell();
      if (cell && (cell.r !== lastMarkCell.r || cell.c !== lastMarkCell.c)) {
        lastMarkCell = cell;
        callbacks.onEnter && callbacks.onEnter(cell.r, cell.c);
      }
    }
  });

  const endPointer = (e) => {
    if (!activePointer) return;
    const mode = activePointer;
    activePointer = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (mode === 'mark') {
      // game.js: onUp이 드래그 여부에 따라 suppressClick 설정 → 그 뒤 tap 호출
      callbacks.onUp && callbacks.onUp();
      callbacks.onTap && callbacks.onTap(markStart.r, markStart.c);
      markStart = null;
      lastMarkCell = null;
    }
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

  // 뚜껑 트윈
  for (const [key, tw] of lidTweens) {
    tw.t += dt / tw.dur;
    if (tw.t >= 1) {
      tw.obj.rotation.x = tw.to;
      lidTweens.delete(key);
    } else {
      const e = (tw.ease || easeOut)(tw.t);
      tw.obj.rotation.x = tw.from + (tw.to - tw.from) * e;
    }
  }

  // 보석 반짝 회전
  for (const row of boxes) for (const b of row) {
    if (b.gem.visible) b.gem.rotation.y += dt * 1.6;
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
