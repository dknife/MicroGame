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
const GEM_REST_Y = WALL_T + 0.31;     // 보석이 상자 바닥에 놓인 높이(2.6배 크기 기준)
const GEM_RISE_Y = BASE_H + 0.45;     // 열리면 떠오르는 높이

let scene, camera, renderer, raycaster;
let dirLight; // 공전하며 금속 표면에 반짝임을 만드는 기본 방향광
let hemiLight, ambLight; // 반구광 / 환경광 (축하 시 보석·caustic만 남기고 끈다)
let diamondMap = null, diamondEnv = null; // 보석용 색상 텍스처 / 환경맵 (skybox/diamond.jpg)
let skyMesh = null;       // 회전하는 배경 구체
let celebrating = false;  // 레벨 클리어 후 카메라 자동 선회
// 레벨 클리어 후: 열린 보석들이 판 위로 떠올라 원형 고리를 이루고, 고리째 함께 회전한다.
let ringActive = false, ringT = 0, ringAngle = 0, ringR = 0, ringY = 0;
let ringGems = [];        // [{ b, base, from(Vector3), cx, cz, spot? }]
let MAX_CAUSTICS = 6;     // 동시에 투영하는 굴절광 스포트라이트 상한. initRenderer에서 GPU의
                          // varying 용량을 조회해 안전 범위 내 최댓값(최대 MAX_SIZE)으로 올린다.
let celebDark = 0;        // 축하 암전 정도(0=평소, 1=보석/caustic만). 분석광·박스 반사를 끈다.
let dimMats = [];         // [{ mat, base }] 암전 시 envMapIntensity를 낮출 박스 머티리얼들
let paused = false;       // 포커스/가시성 상실 시 렌더 루프 정지
// 관성 회전: 손을 떼면 마지막 축/속도(rad/s)로 계속 돈다 (다음 터치까지)
let spinning = false, spinTheta = 0, spinPhi = 0, lastMoveT = 0;
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
const hints = [];              // 힌트 강조 효과 [{ sprite, group, t, dur }]
let shakeTime = 0;             // 남은 흔들림 시간
const clock = new THREE.Clock();

// ---------- 초기화 ----------

export function initRenderer(host, cbs) {
  callbacks = cbs || {};
  container = host;

  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = false; // 바닥 그림자 없음
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // PBR 금속/유리 룩
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);
  canvas = renderer.domElement;
  canvas.style.touchAction = 'none'; // 터치 드래그가 스크롤 대신 입력이 되도록
  canvas.style.display = 'block';

  // 굴절광 스포트라이트는 쿠키 맵당 셰이더 varying(vSpotLightCoord)을 1개씩 쓴다.
  // GPU varying 용량을 조회해 베이스 varying(~10) 여유를 두고 최대 12개(=MAX_SIZE)까지 허용.
  try {
    const gl = renderer.getContext();
    let vv = gl.getParameter(gl.MAX_VARYING_VECTORS);
    if (!vv) { // 일부 WebGL2는 MAX_VARYING_COMPONENTS(=벡터×4)만 보고
      const vc = gl.getParameter(gl.MAX_VARYING_COMPONENTS);
      vv = vc ? Math.floor(vc / 4) : 16;
    }
    MAX_CAUSTICS = Math.max(4, Math.min(12, vv - 10));
  } catch (e) { MAX_CAUSTICS = 6; }

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);

  // 조명 — 박스 색이 잘 보이도록 보조광을 넉넉히
  hemiLight = new THREE.HemisphereLight(0xdce4f5, 0x2a2233, 0.78);
  scene.add(hemiLight);
  ambLight = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(ambLight);
  dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(6, 12, 8);
  scene.add(dirLight);

  boardGroup = new THREE.Group();
  scene.add(boardGroup);

  buildProceduralSky(); // 신비로운 구름·섬광·연무를 절차적으로 생성 → 배경 + 환경맵
  loadDiamond();        // skybox/diamond.jpg → 보석 색상 텍스처 + 환경맵

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

  // 포커스/가시성을 잃으면 렌더 루프를 멈춰 CPU·GPU를 아끼고, 돌아오면 재개
  const setPaused = (p) => {
    if (p === paused) return;
    paused = p;
    if (!paused) { clock.getDelta(); animate(); } // 재개: 누적 delta 버리고 루프 재시작
  };
  document.addEventListener('visibilitychange', () => setPaused(document.hidden));
  window.addEventListener('blur', () => setPaused(true));
  window.addEventListener('focus', () => setPaused(false));

  paused = document.hidden;
  if (!paused) animate();

  // 굴절광 쿠키 텍스처를 게임 진행 중(시작 직후 유휴 시간)에 미리 생성·GPU 업로드해 두어
  // 레벨 클리어 순간 처음 만들 때 생기는 지연을 없앤다. 시작 자체는 막지 않도록 유휴 콜백 사용.
  const warmCaustic = () => {
    const tex = causticTexture();           // 캔버스 그리기(blur·프리즘 패스) 미리 수행
    try { renderer.initTexture(tex); } catch (e) { /* GPU 업로드 미리; 실패해도 무시 */ }
  };
  if (window.requestIdleCallback) requestIdleCallback(warmCaustic, { timeout: 2500 });
  else setTimeout(warmCaustic, 800);
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

// 라운드 브릴리언트 컷 보석 지오메트리 — 테이블(윗면) + 크라운 facet + 스캘럽 거들 +
// 컬렛으로 수렴하는 파빌리온 facet. flatShading과 함께 쓰면 삼각형마다 독립 면으로 반짝인다.
// R = 거들 반지름, MAIN = 주 facet 수(8 = 고전적 라운드 브릴리언트).
function brilliantCutGeometry(R, MAIN = 8) {
  const rt = 0.56 * R;   // 테이블 코너 반지름
  const rv = 0.92 * R;   // 거들 골(밸리)이 안으로 들어가는 반지름 (스캘럽)
  const hc = 0.34 * R;   // 크라운 높이 (거들 위)
  const pd = 0.86 * R;   // 파빌리온 깊이 (거들 아래 → 컬렛)
  const gh = 0.025 * R;  // 거들 절반 두께 (피크↑/골↓)

  const T = [], H = [], L = []; // 테이블 코너 / 거들 피크 / 거들 골
  for (let i = 0; i < MAIN; i++) {
    const a = (i / MAIN) * Math.PI * 2;          // 코너·피크 각도
    const va = ((i + 0.5) / MAIN) * Math.PI * 2; // 골 각도(코너 사이)
    T.push([Math.cos(a) * rt, hc, Math.sin(a) * rt]);
    H.push([Math.cos(a) * R, gh, Math.sin(a) * R]);
    L.push([Math.cos(va) * rv, -gh, Math.sin(va) * rv]);
  }
  const C = [0, -pd, 0]; // 컬렛 (뾰족점)
  const tableC = [0, hc, 0];

  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let i = 0; i < MAIN; i++) {
    const j = (i + 1) % MAIN;
    tri(tableC, T[i], T[j]);   // 테이블 (윗면 부채꼴)
    tri(T[i], H[i], L[i]);     // 크라운: 베젤 오른쪽 반 (코너→피크→골)
    tri(T[i], L[i], T[j]);     // 크라운: 스타 (테이블 모서리→골)
    tri(T[j], L[i], H[j]);     // 크라운: 베젤 왼쪽 반 (다음 코너→골→피크)
    tri(H[i], C, L[i]);        // 파빌리온: 피크→컬렛→골
    tri(L[i], C, H[j]);        // 파빌리온: 골→컬렛→다음 피크
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------- 보드 생성 ----------

export function buildBoard(n, board) {
  size = n;
  boardData = board;
  celebrating = false; // 새 판이 만들어지면 선회 종료
  clearCaustics();     // 굴절광 스포트라이트 해제
  ringActive = false; ringGems = []; ringT = 0; ringAngle = 0; // 보석 고리도 해제
  celebDark = 0; dimMats = []; // 암전 해제 (새 박스는 처음부터 밝게)
  if (hemiLight) hemiLight.intensity = 0.78;
  if (ambLight) ambLight.intensity = 0.18;
  sinkTweens.clear();
  riseTweens.clear();
  emitters.length = 0;
  hints.length = 0; // 힌트 스프라이트는 박스 그룹과 함께 아래에서 dispose됨
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
          for (const m of mats) { if (m.map && m.map !== diamondMap) m.map.dispose(); m.dispose(); }
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
      // 마킹용 보색 (색상환 반대편, 채도·명도는 가독성 위해 보정)
      const _hsl = {}; color.getHSL(_hsl);
      const markColor = '#' + new THREE.Color()
        .setHSL((_hsl.h + 0.5) % 1, Math.min(1, _hsl.s + 0.25), 0.55).getHexString();
      const cx = (c - off) * CELL;
      const cz = (r - off) * CELL;

      const group = new THREE.Group();
      group.position.set(cx, 0, cz);

      // 몸통 — 속이 빈 상자 (바닥 + 네 벽), 스크래치 메탈.
      // 공유 텍스처를 박스마다 복제해 랜덤 회전 + s/t 스케일(0.95~1.05)을 주어
      // 박스마다 다른 스크래치 패턴이 보이게 한다 (이미지는 source 공유 → 메모리 추가 없음).
      const ud = { r, c };
      const variedClone = (t) => {
        const cl = t.clone();
        cl.center.set(0.5, 0.5);
        cl.rotation = Math.random() * Math.PI * 2;
        cl.repeat.set(0.95 + Math.random() * 0.1, 0.95 + Math.random() * 0.1);
        cl.needsUpdate = true;
        return cl;
      };
      const scr = variedClone(scratchTexture());
      const nrm = variedClone(metalNormalTexture());
      // 스펙큘러 약하게 + 난반사 강하게 → 색이 잘 보이게 (금속감↓, 거칠기↑)
      const bodyMat = new THREE.MeshPhysicalMaterial({
        color, metalness: 0.15, roughness: 0.72,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.7, 0.7),
        envMapIntensity: 0.45, clearcoat: 0.1, clearcoatRoughness: 0.6,
      });
      const wallMat = new THREE.MeshPhysicalMaterial({
        color: color.clone().multiplyScalar(0.9), metalness: 0.15, roughness: 0.75,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.7, 0.7),
        envMapIntensity: 0.45, clearcoat: 0.1, clearcoatRoughness: 0.6,
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
      const lidMat = new THREE.MeshPhysicalMaterial({
        color: color.clone().multiplyScalar(1.05), metalness: 0.15, roughness: 0.7,
        roughnessMap: scr, normalMap: nrm, normalScale: new THREE.Vector2(0.7, 0.7),
        envMapIntensity: 0.5, clearcoat: 0.12, clearcoatRoughness: 0.55,
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
        color: color.clone().lerp(new THREE.Color(0xffffff), 0.58), // 더 옅은 색 → 맑음
        map: diamondMap || null,        // 다이아 이미지를 색상 텍스처로
        envMap: diamondEnv || null,     // 다이아 이미지를 환경맵으로 (반사)
        metalness: 0.0, roughness: 0.02,
        transmission: 1.0, thickness: 0.3, ior: 2.4, // 거의 완전 투명 굴절
        attenuationColor: color.clone().lerp(new THREE.Color(0xffffff), 0.55),
        attenuationDistance: 4.0,
        envMapIntensity: 2.0,
        specularIntensity: 1.0,
        clearcoat: 1.0, clearcoatRoughness: 0.03,     // 광택 더 높임
        transparent: true,
        side: THREE.DoubleSide, // 안쪽 facet도 비쳐 굴절되도록
        emissive: color.clone().multiplyScalar(0.1),
        emissiveIntensity: 0.3,
        flatShading: true,
      });
      // 라운드 브릴리언트 컷 — 테이블·크라운·파빌리온 facet을 한 메시로 (컬렛으로 수렴)
      const gemGeo = brilliantCutGeometry(0.16);
      gem.add(new THREE.Mesh(gemGeo, gemMat));
      // 흰색 에지 — 모든 facet 모서리를 또렷하게 (지오메트리 공유 → traverse가 함께 dispose)
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false,
      });
      gem.add(new THREE.LineSegments(new THREE.EdgesGeometry(gemGeo, 1), edgeMat));
      // 보석이 실제로 빛을 내도록 점광원 — 열리면(gem.visible) 함께 켜진다
      const gemLight = new THREE.PointLight(
        color.clone().lerp(new THREE.Color(0xffffff), 0.4), 0, 2.6, 2
      );
      gemLight.position.set(0, 0.2, 0);
      gem.add(gemLight);
      // 반짝이 스파클 — 보석 표면 가까이 모으고 작고 날카롭게 깜빡인다
      const sparkles = [];
      const SPARKLE_N = 8;
      for (let i = 0; i < SPARKLE_N; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: starTexture(), color: color.clone(), transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        const ang = (i / SPARKLE_N) * Math.PI * 2 + Math.random();
        const rad = 0.04 + Math.random() * 0.09; // 보석에 바싹 붙임
        sp.position.set(Math.cos(ang) * rad, 0.0 + Math.random() * 0.18, Math.sin(ang) * rad);
        sp.scale.setScalar(0.07); // 작게 → 날카로운 점
        gem.add(sp);
        sparkles.push({ sprite: sp, phase: Math.random() * Math.PI * 2, speed: 7 + Math.random() * 6 });
      }
      gem.scale.setScalar(3.0); // 보석 크게 (브릴리언트 컷은 얕아서 살짝 키움)
      gem.position.set(0, GEM_REST_Y, 0); // 처음엔 상자 바닥에
      gem.visible = false;
      group.add(gem);

      boardGroup.add(group);
      boxes[r].push({
        group, lidPivot, lid, gem, gemMat, gemLight, sparkles, wrong: false,
        markColor,
        gemSpin: { // Y축 회전 속도 + 살짝 기울임용 위상 (보석마다 약간 다름)
          y: 1.1 + Math.random() * 0.5,
          phase: Math.random() * Math.PI * 2,
        },
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

// 힌트: 해당 박스 위에 빛나는 별이 잠깐 맥동하며 "여기를 봐" 표시 (열어주진 않음)
export function highlight(r, c) {
  if (!boxes.length || !boxes[r] || !boxes[r][c]) return;
  const b = boxes[r][c];
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: starTexture(), color: 0xfff2a8, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sprite.position.set(0, BASE_H + 0.7, 0);
  sprite.scale.setScalar(0.6);
  b.group.add(sprite);
  hints.push({ sprite, group: b.group, t: 0, dur: 2.4 });
}

// 레벨 클리어 후 카메라가 퍼즐을 천천히 선회하며 보석을 감상한다.
// (사용자가 화면을 만지거나 새 판이 만들어지면 자동 해제)
export function celebrate() {
  celebrating = true;
  spinning = false;
  startGemRing();
}

// 열린 보석들을 판 중앙 위쪽의 원형 고리로 모은다. 보드-로컬 좌표로 목표를 잡아
// (보드가 흔들리거나 회전해도 함께 따라가도록) 각 보석의 박스 그룹 오프셋만큼 보정한다.
function startGemRing() {
  clearCaustics();
  ringGems = [];
  const gems = [];
  for (const row of boxes) for (const b of row) if (b.gem.visible && !b.wrong) gems.push(b);
  if (!gems.length) return;
  ringR = Math.max(1.3, (size - 1) * 0.42); // 판 크기에 비례한 고리 반지름
  ringY = GEM_RISE_Y + 0.7;                  // 판 위로 조금 더 떠오름
  const N = gems.length;
  // 굴절광 스포트라이트는 셰이더 varying 한계(큰 판에서 검은 화면 위험)를 피하려 수를 제한하고
  // 고리에 고르게 분포시킨다. 모든 보석은 고리를 이루되, 일부만 caustic을 투영한다.
  const M = Math.min(N, MAX_CAUSTICS);
  const causticIdx = new Set();
  for (let k = 0; k < M; k++) causticIdx.add(Math.round((k * N) / M) % N);
  gems.forEach((b, i) => {
    riseTweens.delete(lidKey(b)); // 떠오르기 트윈과 위치 충돌 방지
    const entry = {
      b,
      base: (i / N) * Math.PI * 2,   // 고리에서의 시작 각도
      from: b.gem.position.clone(),  // 현재(상자 안) 위치에서 부드럽게 모임
      cx: b.group.position.x,
      cz: b.group.position.z,
      cSpin: 0.3 + Math.random() * 0.5,     // 광무늬 회전 속도
      cPhase: Math.random() * Math.PI * 2,  // 일렁임 위상
    };
    if (causticIdx.has(i)) {
      // 굴절광(caustic): 보석 위에서 아래로 비추는 스포트라이트가 caustic 텍스처를
      // 쿠키(gobo)로 투영 → 빛이 박스 표면에 드리워지듯 떨어진다. 그림자는 끄고
      // 콘 감쇠가 원형 마스크 역할을 한다. 무늬 회전은 shadow 카메라 up으로 준다.
      // 거의 흰빛(보석 색 힌트만) → 쿠키의 무지갯빛(iridescent)이 묻히지 않고 박스에 그대로 얹힘
      const col = new THREE.Color(REGION_COLORS[b.reg % REGION_COLORS.length])
        .lerp(new THREE.Color(0xffffff), 0.85);
      const spot = new THREE.SpotLight(col, 0, 0, 0.62, 0.55, 0); // 강도는 매 프레임 갱신
      spot.map = causticTexture(); // 공유 쿠키 텍스처 (회전은 라이트별 shadow.camera.up)
      spot.castShadow = false;
      spot.position.set(b.group.position.x, ringY, b.group.position.z);
      spot.target.position.set(b.group.position.x, BASE_H, b.group.position.z);
      boardGroup.add(spot);
      boardGroup.add(spot.target);
      entry.spot = spot;
    }
    ringGems.push(entry);
  });
  // 암전 대상: 박스 표면 머티리얼(몸통·벽·뚜껑)의 환경 반사를 끌 수 있게 수집.
  // 보석 머티리얼(b.gemMat)은 자체 envMap이라 제외 → 보석은 계속 빛난다.
  dimMats = [];
  for (const row of boxes) for (const b of row) {
    b.group.traverse((o) => {
      const m = o.material;
      if (m && m.isMeshStandardMaterial && m !== b.gemMat) {
        dimMats.push({ mat: m, base: m.envMapIntensity });
      }
    });
  }
  ringT = 0;
  ringActive = true;
}

// 굴절광 스포트라이트 + 타깃 제거 (쿠키 텍스처는 공유 싱글톤이라 유지)
function clearCaustics() {
  for (const rg of ringGems) {
    if (!rg.spot) continue;
    boardGroup.remove(rg.spot.target);
    boardGroup.remove(rg.spot);
  }
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
    rot = Math.PI / 2;            // 90도 자세 유지
    y = BASE_H * (1 - e);         // 그대로 수직으로 바닥까지 내려옴
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
    // 상자색의 보색으로 그린 굵은 X (가독성 위해 어두운 외곽선)
    const m = S * 0.24, n = S * 0.76;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';   // 외곽선
    ctx.lineWidth = S * 0.22;
    ctx.beginPath();
    ctx.moveTo(m, m); ctx.lineTo(n, n);
    ctx.moveTo(n, m); ctx.lineTo(m, n);
    ctx.stroke();
    ctx.strokeStyle = b.markColor || '#ffffff'; // 보색 X
    ctx.lineWidth = S * 0.15;
    ctx.beginPath();
    ctx.moveTo(m, m); ctx.lineTo(n, n);
    ctx.moveTo(n, m); ctx.lineTo(m, n);
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

// ---------- 절차적 스카이맵 (신비로운 구름 · 섬광 · 연무) ----------
// 가로로 끊김 없는(주기적) 에퀴렉탱귤러 2:1 텍스처를 만들어
// 배경(scene.background)과 반사/굴절 환경맵(PMREM)으로 사용한다.
function buildProceduralSky() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // --- 주기적(가로 wrap) 값 노이즈 + fBm ---
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177 | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const vnoise = (u, v, freq, seed) => {
    const fx = u * freq, fy = v * freq;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = sm(fx - x0), ty = sm(fy - y0);
    const xa = ((x0 % freq) + freq) % freq, xb = ((x0 + 1) % freq + freq) % freq; // x wrap
    const c00 = hash(xa + seed, y0), c10 = hash(xb + seed, y0);
    const c01 = hash(xa + seed, y0 + 1), c11 = hash(xb + seed, y0 + 1);
    return lerp(lerp(c00, c10, tx), lerp(c01, c11, tx), ty);
  };
  const fbm = (u, v, seed, f0, oct) => {
    let a = 0.5, sum = 0, norm = 0, f = f0;
    for (let o = 0; o < oct; o++) { sum += a * vnoise(u, v, f, seed + o * 131); norm += a; a *= 0.5; f *= 2; }
    return sum / norm;
  };
  const sstep = (e0, e1, t) => { t = Math.min(1, Math.max(0, (t - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const ridge = (n) => { const r = 1 - Math.abs(n * 2 - 1); return r * r; }; // 능선(필라멘트)

  // --- 픽셀별: 깊은 어둠 위에 빛나는 성운(가산) + 능선형 필라멘트 구름 ---
  const top = [3, 2, 10], horizon = [10, 6, 24], bottom = [1, 1, 6]; // 더 깊은 어둠 (신비)
  const nebMag = [190, 40, 150], nebViolet = [110, 45, 210], nebCyan = [25, 150, 165]; // 성운 색
  const wisp = [150, 160, 220]; // 필라멘트(연무) 색
  const data = ctx.createImageData(W, H);
  const px = data.data;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    let br, bg, bb;
    if (v < 0.5) { const t = sm(v / 0.5); br = lerp(top[0], horizon[0], t); bg = lerp(top[1], horizon[1], t); bb = lerp(top[2], horizon[2], t); }
    else { const t = sm((v - 0.5) / 0.5); br = lerp(horizon[0], bottom[0], t); bg = lerp(horizon[1], bottom[1], t); bb = lerp(horizon[2], bottom[2], t); }
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let R = br, G = bg, B = bb;

      // 성운 1층: 넓은 색안개 (마젠타↔보라↔청록), 가산 글로우
      const n1 = fbm(u, v, 53, 2, 4);
      const a1 = sstep(0.4, 0.92, n1);
      const hue = fbm(u, v, 701, 2, 3);
      let nr, ng, nb;
      if (hue < 0.5) { const t = hue * 2; nr = lerp(nebMag[0], nebViolet[0], t); ng = lerp(nebMag[1], nebViolet[1], t); nb = lerp(nebMag[2], nebViolet[2], t); }
      else { const t = (hue - 0.5) * 2; nr = lerp(nebViolet[0], nebCyan[0], t); ng = lerp(nebViolet[1], nebCyan[1], t); nb = lerp(nebViolet[2], nebCyan[2], t); }
      R += nr * a1; G += ng * a1; B += nb * a1;

      // 성운 2층: 능선형 청록 필라멘트 (가는 빛줄기)
      const a2 = Math.pow(ridge(fbm(u, v, 331, 3, 4)), 1.5) * sstep(0.3, 0.8, n1) * 0.9;
      R += nebCyan[0] * a2; G += nebCyan[1] * a2; B += nebCyan[2] * a2;

      // 구름/연무: 능선형 고주파 필라멘트 (가산, 은은하게)
      const a3 = Math.pow(ridge(fbm(u, v, 17, 5, 4)), 2) * 0.7;
      R += wisp[0] * a3; G += wisp[1] * a3; B += wisp[2] * a3;

      const i = (y * W + x) * 4;
      px[i] = Math.min(255, R); px[i + 1] = Math.min(255, G); px[i + 2] = Math.min(255, B); px[i + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);

  // --- 성운 코어: 큰 부드러운 발광 덩어리 몇 개 (초점/신비감) ---
  ctx.globalCompositeOperation = 'lighter';
  const coreCols = ['rgba(200,60,180,', 'rgba(90,70,230,', 'rgba(40,180,190,'];
  for (let i = 0; i < 4; i++) {
    const cx = Math.random() * W, cy = H * (0.15 + Math.random() * 0.6);
    const rad = 120 + Math.random() * 220;
    const base = coreCols[i % coreCols.length];
    for (const ox of [-W, 0, W]) {
      const g = ctx.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, rad);
      g.addColorStop(0, base + '0.33)');
      g.addColorStop(0.5, base + '0.12)');
      g.addColorStop(1, base + '0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx + ox, cy, rad, 0, Math.PI * 2); ctx.fill();
    }
  }

  // --- 별: 작은 점광 (가산), 일부는 글로우/색 있음 ---
  ctx.globalCompositeOperation = 'lighter';
  const starCount = 700;
  for (let i = 0; i < starCount; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const b = Math.random();
    const sz = b > 0.92 ? 1.6 + Math.random() * 1.4 : 0.6 + Math.random() * 0.9;
    const tint = Math.random();
    const col = tint < 0.7 ? '255,255,255' : (tint < 0.85 ? '180,210,255' : '255,225,200');
    ctx.fillStyle = `rgba(${col},${0.3 + b * 0.7})`;
    ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
    if (sz > 2) { // 밝은 별엔 부드러운 헤일로
      const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 4);
      g.addColorStop(0, `rgba(${col},0.5)`); g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, sz * 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // --- 연무: 지평선 부근 가로 글로우 띠 ---
  ctx.globalCompositeOperation = 'lighter';
  const haze = ctx.createLinearGradient(0, H * 0.32, 0, H * 0.7);
  haze.addColorStop(0, 'rgba(40,70,92,0)');
  haze.addColorStop(0.5, 'rgba(70,120,140,0.35)');
  haze.addColorStop(1, 'rgba(40,70,92,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, H * 0.32, W, H * 0.38);

  // --- 섬광: 은은한 빛 폭발 (가장자리는 wrap 복제) — 과하게 밝지 않게 ---
  const flash = (cx, cy, rad, col) => {
    for (const ox of [-W, 0, W]) {
      const g = ctx.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, rad);
      g.addColorStop(0, col);
      g.addColorStop(0.3, 'rgba(180,210,235,0.16)');
      g.addColorStop(1, 'rgba(120,170,210,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx + ox, cy, rad, 0, Math.PI * 2); ctx.fill();
    }
  };
  const nFlash = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < nFlash; i++) {
    const cx = Math.random() * W;
    const cy = H * (0.12 + Math.random() * 0.5);
    const rad = 40 + Math.random() * 110;
    flash(cx, cy, rad, 'rgba(235,245,255,0.35)'); // 코어 밝기↓
    // 큰 섬광엔 가느다란 광선 (희미하게)
    if (rad > 95) {
      ctx.save();
      ctx.translate(cx, cy);
      const lg = ctx.createLinearGradient(-rad * 2.0, 0, rad * 2.0, 0);
      lg.addColorStop(0, 'rgba(180,220,255,0)');
      lg.addColorStop(0.5, 'rgba(220,238,255,0.18)');
      lg.addColorStop(1, 'rgba(180,220,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(-rad * 2.0, -1, rad * 4.0, 2);
      ctx.fillRect(-1, -rad * 1.1, 2, rad * 2.2);
      ctx.restore();
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 회전 가능한 배경: 큰 안쪽 향(BackSide) 구체 메시 (scene.background 대신)
  const skyMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 32), skyMat);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
  // 반사/굴절 환경맵 (정적)
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
}

// skybox/diamond.jpg를 보석의 색상 텍스처(map) + 환경맵(envMap)으로 로드.
// 비동기 로드라, 끝나면 이미 생성된 보석 재질에도 적용한다.
function loadDiamond() {
  new THREE.TextureLoader().load('./skybox/diamond.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    diamondMap = tex;
    const pmrem = new THREE.PMREMGenerator(renderer);
    diamondEnv = pmrem.fromEquirectangular(tex).texture; // 다이아 이미지를 보석 전용 환경맵으로
    pmrem.dispose();
    for (const row of boxes) for (const b of row) {
      if (b.gemMat) {
        b.gemMat.map = diamondMap;
        b.gemMat.envMap = diamondEnv;
        b.gemMat.needsUpdate = true;
      }
    }
  });
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

// 굴절광(caustic) 무늬 — 휘어진 빛줄기 그물망 + 교차 노드를 blur로 부드럽게 번지게 한다.
// 같은 무늬를 무지개 스펙트럼 색으로 한 축을 따라 점점 어긋나게(프리즘 분산) 여러 번 가산 합성 →
// 코어는 흰빛, 둘레는 매끄러운 무지갯빛(iridescent) 헤일로가 되는 부드러운 광무늬.
let _causticTex = null;
function causticTexture() {
  if (_causticTex) return _causticTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S); // 검정 = 가산에서 투명

  // 무늬(곡선/노드)를 먼저 한 번 정해 세 채널이 같은 형상을 공유하게 한다
  const curves = [];
  for (let i = 0; i < 70; i++) {
    curves.push({
      a: Math.random() * Math.PI * 2,
      cx: Math.random() * S, cy: Math.random() * S,
      len: 40 + Math.random() * 130, bend: (Math.random() - 0.5) * 130,
    });
  }
  const nodes = [];
  for (let i = 0; i < 36; i++) {
    nodes.push({ x: Math.random() * S, y: Math.random() * S, r: 2.5 + Math.random() * 4 });
  }

  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(5px)';   // 선이 아닌 부드럽게 번진 빛으로
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  // 프리즘 분산: 같은 무늬를 무지개 색으로 한 축을 따라 점점 어긋나게 여러 번 그린다.
  // 가산 합성 + blur로 코어는 흰빛, 둘레는 매끄러운 무지갯빛(iridescent) 헤일로가 된다.
  const STEPS = 8;
  const spread = 15;          // 색 분산 폭(px) — 클수록 무지갯빛 강함
  const dirA = 0.6, cosD = Math.cos(dirA), sinD = Math.sin(dirA); // 분산 방향
  for (let s = 0; s < STEPS; s++) {
    const f = s / (STEPS - 1);
    const hue = 285 * (1 - f);          // 285(보라) → 0(빨강) 스펙트럼
    const off = (f - 0.5) * 2 * spread; // -spread..+spread
    const dx = off * cosD, dy = off * sinD;
    const col = `hsla(${hue}, 100%, 62%, 0.4)`;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    for (const cu of curves) {
      const nx = Math.cos(cu.a), ny = Math.sin(cu.a), px = -ny, py = nx;
      ctx.beginPath();
      ctx.moveTo(cu.cx - nx * cu.len + dx, cu.cy - ny * cu.len + dy);
      ctx.quadraticCurveTo(
        cu.cx + px * cu.bend + dx, cu.cy + py * cu.bend + dy,
        cu.cx + nx * cu.len + dx, cu.cy + ny * cu.len + dy,
      );
      ctx.stroke();
    }
    for (const nd of nodes) {
      ctx.beginPath(); ctx.arc(nd.x + dx, nd.y + dy, nd.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.filter = 'none';
  _causticTex = new THREE.CanvasTexture(cv);
  _causticTex.colorSpace = THREE.SRGBColorSpace;
  return _causticTex;
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
  // 드래그 시 페이지 텍스트/요소 선택·콜아웃 방지
  canvas.addEventListener('selectstart', (e) => e.preventDefault());
  canvas.addEventListener('dragstart', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault(); // 텍스트/요소 선택 시작 방지
    celebrating = false; // 사용자가 만지면 자동 선회 중단
    spinning = false;    // 손을 대면 관성 회전 정지
    lastMoveT = performance.now();
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
      const dTheta = -dx * 0.008, dPhi = -dy * 0.008;
      orbit.theta += dTheta;
      orbit.phi = Math.max(0.15, Math.min(1.45, orbit.phi + dPhi));
      // 마지막 회전 속도(rad/s) 기록 → 놓을 때 관성으로 사용
      const now = performance.now();
      const dtv = Math.min(0.1, Math.max(0.001, (now - lastMoveT) / 1000));
      spinTheta = dTheta / dtv;
      spinPhi = dPhi / dtv;
      lastMoveT = now;
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
    if (g === 'orbit') {
      // 최근(120ms 내)에 충분히 빠르게 움직였다면 관성 회전 시작
      const recent = (performance.now() - lastMoveT) < 120;
      spinning = recent && Math.hypot(spinTheta, spinPhi) > 0.25;
    } else if (g === 'mark') {
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
  if (paused) return; // 멈춤: 다음 프레임을 예약하지 않아 렌더링/계산이 완전히 정지
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // 축하 암전: 고리가 활성화되면 분석광(반구·환경·방향)과 박스의 환경 반사를 서서히 꺼
  // 박스를 어둡게 만들고, 보석 자체광(gemLight)과 caustic 스포트라이트만 남긴다.
  celebDark += ((ringActive ? 1 : 0) - celebDark) * Math.min(1, dt * 2.2);
  const lit = 1 - celebDark;
  if (hemiLight) hemiLight.intensity = 0.78 * lit;
  if (ambLight) ambLight.intensity = 0.18 * lit;
  for (const dm of dimMats) dm.mat.envMapIntensity = dm.base * lit;

  // 기본 조명을 공전 + 미세 맥동 → 금속 표면 하이라이트가 움직이며 반짝인다 (암전 시 lit로 감쇠)
  if (dirLight) {
    const a = clock.elapsedTime * 0.55;
    dirLight.position.set(Math.cos(a) * 9, 12, Math.sin(a) * 9);
    dirLight.intensity = (1.05 + 0.3 * Math.sin(clock.elapsedTime * 1.7)) * lit;
  }

  // 배경 하늘이 천천히 자연스럽게 회전
  if (skyMesh) skyMesh.rotation.y += dt * 0.012;

  // 관성 회전: 손을 뗀 마지막 축/속도로 계속 (감속 없이, 다음 터치까지)
  if (spinning && !gesture) {
    orbit.theta += spinTheta * dt;
    const np = orbit.phi + spinPhi * dt;
    if (np <= 0.15 || np >= 1.45) spinPhi = 0; // 상하 한계에 닿으면 세로 회전만 멈춤
    orbit.phi = Math.max(0.15, Math.min(1.45, np));
    updateCamera();
  }

  // 레벨 클리어 후: 카메라가 퍼즐을 선회하며 보석 감상 (phi를 살짝 낮춰 정면에서 본다)
  if (celebrating) {
    orbit.theta += dt * 0.3;
    orbit.phi += (0.78 - orbit.phi) * Math.min(1, dt * 1.2);
    updateCamera();
  }

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

  // 레벨 클리어 후: 보석들이 판 위 원형 고리로 모여 고리째 함께 회전한다.
  // (각 보석의 자유 회전·반짝임은 아래 루프에서 그대로 유지)
  if (ringActive && ringGems.length) {
    ringT = Math.min(1, ringT + dt / 1.4); // ~1.4초에 걸쳐 원형으로 모임
    ringAngle += dt * 0.45;                // 고리 전체가 천천히 함께 회전
    const e = easeOut(ringT);
    const ct = clock.elapsedTime;
    for (const rg of ringGems) {
      const a = rg.base + ringAngle;
      // 보드-로컬 목표(고리 위 점)에서 박스 그룹 오프셋을 빼 보석의 로컬 위치로
      const tx = Math.cos(a) * ringR - rg.cx;
      const tz = Math.sin(a) * ringR - rg.cz;
      rg.b.gem.position.set(
        rg.from.x + (tx - rg.from.x) * e,
        rg.from.y + (ringY - rg.from.y) * e,
        rg.from.z + (tz - rg.from.z) * e,
      );
      // 굴절광: 보석 바로 아래를 따라 박스에 투영. 보석을 따라 이동하고,
      // 강도는 페이드인 + 일렁임, 쿠키 무늬는 shadow 카메라 up 회전으로 돈다.
      if (rg.spot) {
        const wx = rg.cx + rg.b.gem.position.x;
        const wz = rg.cz + rg.b.gem.position.z;
        rg.spot.position.set(wx, ringY, wz);
        rg.spot.target.position.set(wx, BASE_H, wz);
        const flick = 0.6 + 0.4 * Math.sin(ct * 4 + rg.cPhase);
        rg.spot.intensity = 8 * e * flick; // 박스에 얹히는 굴절광 (기준 20의 0.4배)
        // 쿠키 회전을 보석 자전과 동기화 → 보석과 같이 빠르게 돈다
        const roll = rg.b.gem.rotation.y + rg.cPhase;
        rg.spot.shadow.camera.up.set(Math.cos(roll), 0, Math.sin(roll)); // 쿠키 회전
      }
    }
  }

  // 보석: 천천히 회전 + 글로우 맥동 + 스파클 반짝임
  const time = clock.elapsedTime;
  for (const row of boxes) for (const b of row) {
    if (!b.gem.visible) continue;
    b.gem.rotation.y += b.gemSpin.y * dt;                          // Y축 회전
    b.gem.rotation.x = Math.sin(time * 0.9 + b.gemSpin.phase) * 0.13; // 약간씩 기울임
    b.gem.rotation.z = Math.sin(time * 0.7 + b.gemSpin.phase * 1.7) * 0.1;
    const pulse = 0.5 + 0.5 * Math.sin(time * 3 + b.reg); // 0~1
    b.gemMat.emissiveIntensity = 0.5 + 0.6 * pulse;
    b.gemLight.intensity = 1.4 + 1.0 * pulse; // 실제 발광
    for (const sp of b.sparkles) {
      const tw = Math.sin(time * sp.speed + sp.phase);
      const o = Math.pow(Math.max(0, tw), 2.2); // 가파른 피크 → 날카로운 섬광
      sp.sprite.material.opacity = o;
      const sc = 0.035 + 0.13 * o; // 작고 또렷한 점
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

  // 힌트 강조: 별이 위아래로 떠다니며 3번 정도 맥동하다 사라진다
  for (let i = hints.length - 1; i >= 0; i--) {
    const h = hints[i];
    h.t += dt;
    const k = h.t / h.dur;
    const pulse = Math.max(0, Math.sin(h.t * 7));
    h.sprite.material.opacity = pulse * (1 - k) * 0.95;
    const sc = 0.45 + 0.35 * pulse;
    h.sprite.scale.set(sc, sc, sc);
    h.sprite.position.y = BASE_H + 0.7 + Math.sin(h.t * 3) * 0.12;
    if (h.t >= h.dur) {
      h.group.remove(h.sprite);
      h.sprite.material.dispose();
      hints.splice(i, 1);
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
