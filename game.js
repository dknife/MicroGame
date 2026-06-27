'use strict';

import { initRenderer, buildBoard as r3dBuild, syncState, shake as r3dShake } from './render3d.js';

const MIN_SIZE = 5;
const MAX_SIZE = 12;
const SAVE_KEY = 'myMeowDoku.save';
const MAX_MISTAKES = 3;
const DBLCLICK_DELAY = 250; // ms: 싱글클릭 확정 대기 시간

// 영역마다 서로 다른 고양이 — 카드를 뒤집으면 그 영역의 고양이가 나온다 (최대 12)
const CAT_FACES = [
  '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🐱',
  '🐈', '🐈‍⬛',
];

// 색 영역(같은 색 = 연결된 카드 묶음) 뒷면 색상 — 최대 12개
const REGION_COLORS = [
  '#f9c74f', '#90be6d', '#f8961e', '#43aa8b', '#577590',
  '#f94144', '#c77dff', '#4cc9f0', '#ff99c8', '#a98467',
  '#f72585', '#e0e1dd',
];

// 칸 상태 mark: 'none' | 'paw'(사용자/자동 마킹) | 'wrong'(오답 붉은 마킹)
let level = 1;
let size = MIN_SIZE;
let board = null;      // { diamondCols: number[], regions: number[][] }
let cells = [];        // 2D [r][c] -> { revealed, mark }
let mistakes = 0;
let locked = false;    // 애니메이션/오버레이 중 입력 차단
let flashing = null;   // 오답 카드 잠깐 보여주기: {r, c}
let clickTimer = null;
let drag = null;           // { mode:'paw'|'none', startR, startC, moved, visited:Set }
let suppressClick = false; // 드래그 직후 발생하는 click 이벤트 무시

const boardEl = document.getElementById('board');
const levelEl = document.getElementById('level-display');
const livesEl = document.getElementById('lives-display');
const overlayEl = document.getElementById('overlay');
const bannerEl = document.getElementById('banner');
const bannerMsgEl = document.getElementById('banner-msg');
const bannerBtnEl = document.getElementById('banner-btn');
const overlayTitleEl = document.getElementById('overlay-title');
const overlayMsgEl = document.getElementById('overlay-message');
const overlayBtnEl = document.getElementById('overlay-btn');

// ---------- 보드 생성 ----------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 행마다 다이아몬드 1개: 열 중복 금지, 연속 행은 열 차이 2 이상(8방향 인접 금지)
function generateDiamonds(n) {
  const cols = [];
  function place(row) {
    if (row === n) return true;
    for (const c of shuffle([...Array(n).keys()])) {
      if (cols.includes(c)) continue;
      if (row > 0 && Math.abs(c - cols[row - 1]) < 2) continue;
      cols.push(c);
      if (place(row + 1)) return true;
      cols.pop();
    }
    return false;
  }
  place(0);
  return cols;
}

// 각 다이아몬드를 시드로 랜덤 성장 flood-fill → 영역마다 다이아몬드 정확히 1개.
// 난이도 조절: 두 영역은 1~2칸으로 제한해 쉬운 시작점을 제공
function generateRegions(n, diamondCols) {
  for (;;) {
    const region = tryGenerateRegions(n, diamondCols);
    if (region) return region;
  }
}

function tryGenerateRegions(n, diamondCols) {
  const region = Array.from({ length: n }, () => Array(n).fill(-1));
  const sizes = Array(n).fill(1);
  const caps = Array(n).fill(Infinity);
  for (const k of shuffle([...Array(n).keys()]).slice(0, 2)) {
    caps[k] = 1 + Math.floor(Math.random() * 2);
  }

  const frontier = [];
  for (let r = 0; r < n; r++) {
    region[r][diamondCols[r]] = r;
    frontier.push([r, diamondCols[r]]);
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let remaining = n * n - n;
  while (remaining > 0) {
    // 크기 제한된 영역에 막혀 채울 수 없는 칸이 생기면 재시도
    if (frontier.length === 0) return null;
    const i = Math.floor(Math.random() * frontier.length);
    const [r, c] = frontier[i];
    if (sizes[region[r][c]] >= caps[region[r][c]]) {
      frontier.splice(i, 1);
      continue;
    }
    const open = dirs
      .map(([dr, dc]) => [r + dr, c + dc])
      .filter(([nr, nc]) => nr >= 0 && nr < n && nc >= 0 && nc < n && region[nr][nc] === -1);
    if (open.length === 0) {
      frontier.splice(i, 1);
      continue;
    }
    const [nr, nc] = open[Math.floor(Math.random() * open.length)];
    region[nr][nc] = region[r][c];
    sizes[region[r][c]]++;
    frontier.push([nr, nc]);
    remaining--;
  }
  return region;
}

// 영역 배치가 허용하는 정답들을 찾는다 (limit개 도달 시 조기 중단).
// 제약: 행/열/영역당 다이아몬드 1개, 연속 행의 열 차이 2 이상(8방향 인접 금지)
function findSolutions(n, regions, limit) {
  const usedCols = new Array(n).fill(false);
  const usedRegions = new Array(n).fill(false);
  const current = [];
  const found = [];
  function place(row, prevCol) {
    if (row === n) {
      found.push(current.slice());
      return;
    }
    for (let c = 0; c < n; c++) {
      if (usedCols[c]) continue;
      if (row > 0 && Math.abs(c - prevCol) < 2) continue;
      const k = regions[row][c];
      if (usedRegions[k]) continue;
      usedCols[c] = true;
      usedRegions[k] = true;
      current.push(c);
      place(row + 1, c);
      current.pop();
      usedCols[c] = false;
      usedRegions[k] = false;
      if (found.length >= limit) return;
    }
  }
  place(0, -2);
  return found;
}

// 영역 k에서 (rm, cm)을 떼어내도 k가 연결 상태를 유지하는지 (시드 = k의 다이아몬드 칸)
function connectedWithout(n, regions, k, rm, cm, diamondCols) {
  let total = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (regions[r][c] === k) total++;
  }
  const seen = new Set();
  const start = k * n + diamondCols[k];
  seen.add(start);
  const queue = [start];
  while (queue.length) {
    const v = queue.pop();
    const r = Math.floor(v / n), c = v % n;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
      if (nr === rm && nc === cm) continue;
      const u = nr * n + nc;
      if (regions[nr][nc] === k && !seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    }
  }
  return seen.size === total - 1;
}

// 대체 해를 죽이는 영역 수선: 대체 해가 다이아몬드를 놓는 칸 하나를 이웃 영역으로 넘긴다.
// (그 칸은 절대 정답 다이아몬드 칸이 아니므로 정답 해는 보존된다)
function repairOnce(n, diamondCols, regions, alt) {
  const rows = shuffle([...Array(n).keys()].filter((r) => alt[r] !== diamondCols[r]));
  for (const r of rows) {
    const c = alt[r];
    const k = regions[r][c];
    if (!connectedWithout(n, regions, k, r, c, diamondCols)) continue;
    const neighbors = new Set();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
      if (regions[nr][nc] !== k) neighbors.add(regions[nr][nc]);
    }
    if (neighbors.size === 0) continue;
    const sizes = Array(n).fill(0);
    for (let rr = 0; rr < n; rr++) for (let cc = 0; cc < n; cc++) sizes[regions[rr][cc]]++;
    // 1~2칸 영역(쉬운 시작점)은 키우지 않도록 큰 영역 우선
    const candidates = shuffle([...neighbors]);
    candidates.sort((a, b) => (sizes[b] >= 3 ? 1 : 0) - (sizes[a] >= 3 ? 1 : 0));
    regions[r][c] = candidates[0];
    return true;
  }
  return false;
}

function smallRegionCount(n, regions) {
  const sizes = Array(n).fill(0);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) sizes[regions[r][c]]++;
  return sizes.filter((s) => s <= 2).length;
}

// 보드 생성 작업을 단계(슬라이스) 단위로 수행하는 잡 생성기.
// step()을 반복 호출하면 완성 시 보드를, 진행 중이면 null을 반환한다.
// 큰 판은 단순 재시도로 유일해가 사실상 안 나오므로, 해가 여럿이면
// 대체 해를 죽이는 수선을 반복해 유일해로 수렴시킨다.
function createBoardJob(n) {
  const MAX_REPAIRS = 300;
  let diamondCols = null;
  let regions = null;
  let repairs = 0;
  return function step() {
    if (!regions) {
      diamondCols = generateDiamonds(n);
      regions = generateRegions(n, diamondCols);
      repairs = 0;
    }
    const sols = findSolutions(n, regions, 2);
    if (sols.length === 1) {
      if (smallRegionCount(n, regions) >= 2) {
        const board = { diamondCols, regions };
        regions = null;
        return board;
      }
      regions = null; // 쉬운 시작점(1~2칸 영역 2개) 조건 깨짐 → 새로 생성
      return null;
    }
    const alt = sols.find((s) => s.some((c, r) => c !== diamondCols[r]));
    if (!repairOnce(n, diamondCols, regions, alt) || ++repairs > MAX_REPAIRS) {
      regions = null; // 수선 불가 → 새로 생성
    }
    return null;
  };
}

// 해가 유일한 판만 내보낸다 → 논리만으로 항상 풀 수 있음을 보장
function makeBoard(n) {
  const step = createBoardJob(n);
  for (;;) {
    const board = step();
    if (board) return board;
  }
}

// 큰 판은 유일해 수렴에 수백 ms가 걸릴 수 있어,
// 현재 레벨을 푸는 동안 다음 레벨 보드를 잘게 나눠 미리 생성해 둔다
let nextBoard = null; // { size, diamondCols, regions }
let prepareToken = 0;

function prepareNextBoard() {
  const token = ++prepareToken;
  const nextSize = Math.min(MIN_SIZE + level, MAX_SIZE);
  nextBoard = null;
  const job = createBoardJob(nextSize);
  const slice = () => {
    if (token !== prepareToken) return;
    const board = job();
    if (board) {
      nextBoard = { size: nextSize, ...board };
      return;
    }
    setTimeout(slice, 30);
  };
  setTimeout(slice, 100);
}

function newBoard() {
  if (nextBoard && nextBoard.size === size) {
    board = { diamondCols: nextBoard.diamondCols, regions: nextBoard.regions };
  } else {
    board = makeBoard(size); // 미리 만든 보드가 없으면 동기 생성
  }
  saveProgress();
  prepareNextBoard();
  resetRound();
}

function resetRound() {
  cells = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ revealed: false, mark: 'none' }))
  );
  mistakes = 0;
  locked = false;
  flashing = null;
  hideOverlay();
  bannerEl.classList.add('hidden');
  buildBoard();
  render();
}

// ---------- 효과음 (Web Audio 합성 — 외부 파일 불필요) ----------

let audioCtx = null;

function getAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// iOS 등은 사용자 제스처 안에서만 오디오를 시작할 수 있다.
// 클릭 처리(setTimeout)는 제스처 컨텍스트가 아니므로 첫 입력에서 미리 풀어둔다.
document.addEventListener('mousedown', getAudio, { once: true });
document.addEventListener('touchstart', getAudio, { once: true });
document.addEventListener('pointerdown', getAudio, { once: true });

// 뽁 — 물방울 터지는 소리 (마킹: 높은 음, 해제: 낮은 음, 피치 약간 랜덤)
function playPop(erase) {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const base = (erase ? 280 : 480) * (0.9 + Math.random() * 0.2);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.exponentialRampToValueAtTime(base * 2.3, t + 0.06);
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

// 딩동 — 종소리처럼 감쇠하는 2음 차임 (E5 → C5)
function playChime() {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const notes = [
    { freq: 659.25, start: t, dur: 0.7 },        // 딩 (E5)
    { freq: 523.25, start: t + 0.28, dur: 0.9 }, // 동 (C5)
  ];
  for (const { freq, start, dur } of notes) {
    for (const [mult, vol] of [[1, 0.25], [2, 0.08], [3, 0.03]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(vol, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    }
  }
}

// 팡파레 — 상승 아르페지오 후 화음 (레벨 클리어).
// 마지막 고양이의 딩동 소리와 겹치지 않게 살짝 늦게 시작한다
function playFanfare() {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime + 0.3;
  const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;
  const note = (freq, start, dur, vol) => {
    for (const [mult, v, type] of [[1, vol, 'triangle'], [1, vol * 0.4, 'sawtooth']]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(v, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    }
  };
  note(C5, t, 0.25, 0.18);
  note(E5, t + 0.13, 0.25, 0.18);
  note(G5, t + 0.26, 0.25, 0.18);
  // 마무리 화음
  for (const f of [C5, E5, G5, C6]) note(f, t + 0.42, 1.0, 0.12);
}

// 경고 — 낮은 사각파 두 번
function playWarning() {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  for (let i = 0; i < 2; i++) {
    const start = t + i * 0.17;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, start);
    osc.frequency.linearRampToValueAtTime(150, start + 0.13);
    gain.gain.setValueAtTime(0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.16);
  }
}

// ---------- 입력 ----------

function isDiamond(r, c) {
  return board.diamondCols[r] === c;
}

let pendingR = -1, pendingC = -1; // 보류 중인 싱글클릭의 위치

function onCellClick(r, c) {
  if (suppressClick) return;
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    if (pendingR === r && pendingC === c) {
      // 같은 칸 연속 클릭 → 더블클릭으로 처리 (dblclick 이벤트가 없는 iOS 등 대비)
      doubleClick(r, c);
      return;
    }
    singleClick(pendingR, pendingC); // 다른 칸의 보류된 클릭은 즉시 확정
  }
  pendingR = r;
  pendingC = c;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    singleClick(r, c);
  }, DBLCLICK_DELAY);
}

// ----- 드래그 마킹: 시작 카드의 토글 결과를 지나가는 카드 전체에 적용 -----

function startDrag(r, c) {
  if (locked) return;
  const cell = cells[r][c];
  if (cell.revealed || cell.mark === 'wrong') return;
  drag = {
    mode: cell.mark === 'paw' ? 'none' : 'paw',
    startR: r,
    startC: c,
    moved: false,
    visited: new Set(),
  };
}

function onCellEnter(r, c) {
  if (!drag || locked) return;
  if (!drag.moved) {
    drag.moved = true;
    applyDragMark(drag.startR, drag.startC);
  }
  applyDragMark(r, c);
}

function applyDragMark(r, c) {
  const key = r + ',' + c;
  if (drag.visited.has(key)) return;
  drag.visited.add(key);
  const cell = cells[r][c];
  if (cell.revealed || cell.mark === 'wrong') return; // 예외: 공개된 다이아몬드, 오답 마킹
  if (cell.mark !== drag.mode) {
    cell.mark = drag.mode;
    playPop(drag.mode === 'none');
    render();
  }
}

// 포인터를 뗄 때: 드래그로 처리됐다면 곧이어 오는 tap(click)을 무시한다.
// (렌더러가 onUp 직후 onTap을 호출하므로 suppressClick 동기 설정이 유효)
function handlePointerUp() {
  if (drag && drag.moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  drag = null;
}

function singleClick(r, c) {
  if (locked) return;
  const cell = cells[r][c];
  if (cell.revealed || cell.mark === 'wrong') return;
  cell.mark = cell.mark === 'paw' ? 'none' : 'paw';
  playPop(cell.mark === 'none');
  render();
}

// 길게 누르기: 붉은 물음표(확신 없음) 토글
function longPress(r, c) {
  if (locked) return;
  const cell = cells[r][c];
  if (cell.revealed || cell.mark === 'wrong') return;
  cell.mark = cell.mark === 'question' ? 'none' : 'question';
  playPop(cell.mark === 'none');
  render();
}

function doubleClick(r, c) {
  if (locked) return;
  const cell = cells[r][c];
  if (cell.revealed || cell.mark === 'wrong') return;

  if (isDiamond(r, c)) {
    cell.revealed = true;
    cell.mark = 'none';
    playChime();
    autoMarkAround(r, c);
    render();
    if (board.diamondCols.every((col, row) => cells[row][col].revealed)) {
      onLevelClear();
    }
  } else {
    onMistake(r, c);
  }
}

// 다이아몬드 공개 시: 8방향 이웃 + 해당 행/열 전체 자동 마킹
function autoMarkAround(r, c) {
  const mark = (rr, cc) => {
    if (rr < 0 || rr >= size || cc < 0 || cc >= size) return;
    const cell = cells[rr][cc];
    if (!cell.revealed && cell.mark === 'none') cell.mark = 'paw';
  };
  for (let i = 0; i < size; i++) {
    mark(r, i);
    mark(i, c);
  }
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr || dc) mark(r + dr, c + dc);
    }
  }
}

function onMistake(r, c) {
  mistakes++;
  locked = true;
  flashing = { r, c };
  playWarning();
  render();
  r3dShake();
  setTimeout(() => {
    flashing = null;
    cells[r][c].mark = 'wrong';
    locked = false;
    render();
    if (mistakes >= MAX_MISTAKES) {
      locked = true;
      showOverlay('💔 Game Over', '빈 상자를 세 번 열었어요.', 'Restart', resetRound);
    }
  }, 800);
}

// 클리어 축하는 보드를 가리지 않도록 상단 배너로 표시한다
function onLevelClear() {
  locked = true;
  playFanfare();
  bannerMsgEl.textContent = `🎉 보석 ${size}개를 모두 찾았어요!`;
  bannerEl.classList.remove('hidden');
}

bannerBtnEl.addEventListener('click', () => {
  level++;
  size = Math.min(MIN_SIZE + level - 1, MAX_SIZE);
  newBoard(); // newBoard가 새 레벨 + 새 판을 저장한다
});

// ---------- 렌더링 ----------

// 렌더링은 3D 렌더러(render3d.js)에 위임한다.
// buildBoard는 판이 바뀔 때 박스 씬을 새로 만들고, render는 HUD 갱신 후
// 셀 상태를 렌더러에 넘겨 제자리로 동기화한다.
function buildBoard() {
  r3dBuild(size, board);
}

function render() {
  levelEl.textContent = `Level ${level} (${size}×${size})`;
  livesEl.textContent =
    '❤️'.repeat(MAX_MISTAKES - mistakes) + '🖤'.repeat(mistakes);
  syncState({ size, board, cells, flashing });
}

function showOverlay(title, message, btnLabel, onClick) {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = message;
  overlayBtnEl.textContent = btnLabel;
  overlayBtnEl.onclick = onClick;
  overlayEl.classList.remove('hidden');
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

document.getElementById('restart-btn').addEventListener('click', () => {
  if (!overlayEl.classList.contains('hidden')) return;
  resetRound();
});

// 레벨 1부터 새로 시작 (진행 저장도 새 판으로 덮어쓴다)
document.getElementById('reset-btn').addEventListener('click', () => {
  level = 1;
  size = MIN_SIZE;
  newBoard();
});

// ---------- 진행 저장: 항상 마지막 도달 레벨에서 시작 ----------
// 큰 판은 생성에 수 초가 걸릴 수 있어 레벨과 함께 판 자체를 저장한다
// → 페이지를 다시 열면 생성 없이 즉시 복원

function saveProgress() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      level,
      diamondCols: board.diamondCols,
      regions: board.regions,
    }));
  } catch (e) { /* 저장 불가 환경(시크릿 모드 등)이면 무시 */ }
}

function loadProgress() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!data || !(data.level >= 1)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function startGame() {
  const saved = loadProgress();
  if (saved) {
    level = saved.level;
    size = Math.min(MIN_SIZE + level - 1, MAX_SIZE);
    const validBoard =
      Array.isArray(saved.diamondCols) && saved.diamondCols.length === size &&
      Array.isArray(saved.regions) && saved.regions.length === size &&
      saved.regions.every((row) => Array.isArray(row) && row.length === size);
    if (validBoard) {
      board = { diamondCols: saved.diamondCols, regions: saved.regions };
      prepareNextBoard();
      resetRound();
      return;
    }
  }
  newBoard();
}

// ---------- 3D 렌더러 초기화 + 입력 연결 ----------
// 박스 위 드래그 = 마킹, 빈 공간/우클릭 드래그 = 그리드 회전.
// 렌더러는 포인터 제스처를 (r,c)로 변환해 기존 핸들러를 그대로 호출한다.
initRenderer(boardEl, {
  onDown: (r, c) => startDrag(r, c),
  onEnter: (r, c) => onCellEnter(r, c),
  onUp: handlePointerUp,
  onTap: (r, c) => onCellClick(r, c),
  onLongPress: (r, c) => longPress(r, c),
});

startGame();
