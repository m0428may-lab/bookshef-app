const bookInput = document.getElementById("bookInput");
const addBtn = document.getElementById("addBtn");
const scanBtn = document.getElementById("scanBtn");

const seriesShelf = document.getElementById("seriesShelf");

const seriesModal = document.getElementById("seriesModal");
const seriesBody = document.getElementById("seriesBody");
const closeSeries = document.getElementById("closeSeries");

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const closeModal = document.getElementById("closeModal");

const scanModal = document.getElementById("scanModal");
const closeScan = document.getElementById("closeScan");
const video = document.getElementById("video");
const scanStatus = document.getElementById("scanStatus");

const STORAGE_BOOKS = "books_v3";
const STORAGE_SERIESMAX = "seriesMax_v1";

let books = [];      // {title, series, volume, cover, date, isbn}
let seriesMax = {};  // { [series]: maxVolume }

let currentSeries = "";
let currentEntries = []; // {volume, bookIndex|null}
let currentPos = 0;

// swipe
let touchStartX = null;
let touchStartY = null;

// scan
let mediaStream = null;
let scanTimer = null;
let barcodeDetector = null;

init();

function init() {
  loadAll();
  migrateOld();
  saveAll();
  renderSeriesShelf();
}

/* =========================
   登録
========================= */
addBtn.addEventListener("click", async () => {
  const raw = bookInput.value.trim();
  if (!raw) return;

  // ISBN入力ならISBNで登録
  const isbn = normalizeISBN(raw);
  if (isbn) {
    const meta = await fetchBookByISBN(isbn);
    if (!meta) {
      alert("ISBNから本が見つかりませんでした。数字が正しいか確認してください。");
      return;
    }
    await addOrUpdateBook({
      title: meta.title,
      series: meta.series,
      volume: meta.volume,
      cover: meta.cover,
      isbn
    });
    bookInput.value = "";
    return;
  }

  // 普通の入力（作品名 + 巻数）
  const parsed = parseSeriesAndVolume(raw);
  const cover = await fetchCoverFromGoogleBooks(parsed.series, parsed.volume);

  await addOrUpdateBook({
    title: raw,
    series: parsed.series,
    volume: parsed.volume,
    cover: cover || "",
    isbn: ""
  });

  bookInput.value = "";
});

bookInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.click();
});

async function addOrUpdateBook({ title, series, volume, cover, isbn }) {
  const today = new Date();
  const date = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

  const volKey = volume ?? -1;
  const dupIndex = books.findIndex(b => b.series === series && (b.volume ?? -1) === volKey);

  const label = volume ? `${series} ${volume}巻` : series;
  if (dupIndex !== -1) {
    const ok = confirm(`すでに「${label}」が登録されています。上書きしますか？`);
    if (!ok) return;
  }

  const book = { title, series, volume: volume ?? null, cover: cover || "", date, isbn: isbn || "" };

  if (dupIndex !== -1) books[dupIndex] = book;
  else books.push(book);

  // 所持最大は正確なので自動更新
  if (book.volume) {
    seriesMax[book.series] = Math.max(seriesMax[book.series] || 0, book.volume);
  }

  saveAll();
  renderSeriesShelf();

  // シリーズ内を開いてたら更新
  if (!seriesModal.classList.contains("hidden") && currentSeries === series) {
    openSeries(series);
  }
}

/* =========================
   本棚：シリーズだけ
========================= */
function renderSeriesShelf() {
  seriesShelf.innerHTML = "";

  const bySeries = groupBySeries(books);
  const seriesList = Object.keys(bySeries).sort((a, b) => a.localeCompare(b, "ja"));

  seriesList.forEach(series => {
    const list = bySeries[series];

    const ownedVolumes = list.filter(b => b.volume).map(b => b.volume);
    const ownedCount = new Set(ownedVolumes).size;

    const maxOwned = ownedVolumes.length ? Math.max(...ownedVolumes) : 0;
    const max = Math.max(seriesMax[series] || 0, maxOwned);

    const card = document.createElement("div");
    card.className = "seriesCard";
    card.style.background = calmColor(series);

    const titleDiv = document.createElement("div");
    titleDiv.className = "seriesTitle";
    titleDiv.textContent = series;

    const badge = document.createElement("div");
    badge.className = "seriesBadge";
    badge.textContent = max ? `${ownedCount}/${max}` : `${list.length}冊`;

    card.appendChild(titleDiv);
    card.appendChild(badge);

    card.addEventListener("click", () => openSeries(series));

    seriesShelf.appendChild(card);
  });
}

/* =========================
   シリーズ内：巻一覧（サムネ付き）
========================= */
function openSeries(series) {
  currentSeries = series;

  const list = books
    .map((b, i) => ({ b, i }))
    .filter(x => x.b.series === series);

  const ownedMap = new Map(); // volume -> bookIndex
  list.forEach(x => { if (x.b.volume) ownedMap.set(x.b.volume, x.i); });

  const ownedVolumes = [...ownedMap.keys()];
  const maxOwned = ownedVolumes.length ? Math.max(...ownedVolumes) : 0;
  const max = Math.max(seriesMax[series] || 0, maxOwned);

  // 1..max を作り、未所持は null
  currentEntries = [];
  if (max) {
    for (let v = 1; v <= max; v++) {
      currentEntries.push({ volume: v, bookIndex: ownedMap.has(v) ? ownedMap.get(v) : null });
    }
  } else {
    // 巻なし本だけ
    list.forEach(x => currentEntries.push({ volume: null, bookIndex: x.i }));
  }

  const ownedCount = ownedMap.size;

  seriesBody.innerHTML = `
    <div class="seriesHeaderRow">
      <div class="seriesNameBig">${escapeHtml(series)}</div>
      <div class="seriesMetaSmall">${max ? `所持 ${ownedCount}/${max}` : `巻数なし`}</div>
    </div>

    <div class="modalActions">
      <button class="btn" id="setMaxBtn" type="button">最大巻を設定</button>
      <button class="btn" id="autoMaxBtn" type="button">最大巻を自動推定</button>
    </div>

    <div class="volGrid" id="volGrid"></div>
  `;

  // 最大巻 手動
  document.getElementById("setMaxBtn").addEventListener("click", () => {
    const now = seriesMax[series] || max || 1;
    const input = prompt(`${series} の最大巻数を入力（例：113）`, String(now));
    const n = Number(String(input || "").replace(/[^\d]/g, ""));
    if (!n || n < 1) return;
    seriesMax[series] = n;
    saveAll();
    openSeries(series);
    renderSeriesShelf();
  });

  // 最大巻 推定（精度は保証できない）
  document.getElementById("autoMaxBtn").addEventListener("click", async () => {
    const guess = await estimateMaxVolumeFromGoogleBooks(series);
    if (!guess) {
      alert("推定できませんでした。手動で最大巻を設定してください。");
      return;
    }
    seriesMax[series] = Math.max(seriesMax[series] || 0, guess);
    saveAll();
    openSeries(series);
    renderSeriesShelf();
    alert(`最大巻を「${seriesMax[series]}」に設定しました（推定）`);
  });

  const grid = document.getElementById("volGrid");

  currentEntries.forEach((e, idx) => {
    const tile = document.createElement("div");
    tile.className = "volTile " + (e.bookIndex !== null ? "owned" : "missing");

    const img = document.createElement("img");
    img.className = "volThumb";

    if (e.bookIndex !== null && books[e.bookIndex].cover) {
      img.src = books[e.bookIndex].cover;
      img.alt = `${series} ${e.volume}巻`;
    } else {
      img.alt = "missing";
      img.src = placeholderCoverDataUrl();
    }

    const label = document.createElement("div");
    label.className = "volLabel";
    label.textContent = e.volume ? `${e.volume}巻` : "本";

    tile.appendChild(img);
    tile.appendChild(label);

    tile.addEventListener("click", () => {
      currentPos = idx;

      // 未所持
      if (e.bookIndex === null) {
        if (!e.volume) return;
        const ok = confirm(`${series} ${e.volume}巻 は未所持です。登録しますか？`);
        if (!ok) return;

        (async () => {
          const cover = await fetchCoverFromGoogleBooks(series, e.volume);
          await addOrUpdateBook({
            title: `${series} ${e.volume}巻`,
            series,
            volume: e.volume,
            cover: cover || "",
            isbn: ""
          });

          const newIndex = books.findIndex(b => b.series === series && b.volume === e.volume);
          if (newIndex >= 0) openVolumeDetail(newIndex);
        })();
        return;
      }

      // 所持
      openVolumeDetail(e.bookIndex);
    });

    grid.appendChild(tile);
  });

  showSeriesModal();
}

/* =========================
   巻の詳細（表紙）
   + 左右スワイプで巻移動
========================= */
function openVolumeDetail(bookIndex) {
  renderVolumeDetail(bookIndex);
  showModal();
}

function goPrev() {
  if (!currentEntries.length) return;
  if (currentPos <= 0) return;
  animateToPos(currentPos - 1, "right");
}
function goNext() {
  if (!currentEntries.length) return;
  if (currentPos >= currentEntries.length - 1) return;
  animateToPos(currentPos + 1, "left");
}

function animateToPos(newPos, dir) {
  const outClass = dir === "left" ? "slideOutLeft" : "slideOutRight";
  const inClass  = dir === "left" ? "slideInRight" : "slideInLeft";

  modalBody.classList.remove("slideOutLeft","slideOutRight","slideInLeft","slideInRight");
  modalBody.classList.add(outClass);

  setTimeout(() => {
    currentPos = newPos;
    const entry = currentEntries[currentPos];

    if (entry.bookIndex === null && entry.volume) {
      renderMissingDetail(entry.volume);
    } else if (entry.bookIndex !== null) {
      renderVolumeDetail(entry.bookIndex);
    } else {
      renderMissingDetail(null);
    }

    modalBody.classList.remove(outClass);
    modalBody.classList.add(inClass);
    setTimeout(() => modalBody.classList.remove(inClass), 220);
  }, 160);
}

function renderMissingDetail(volume) {
  const series = currentSeries;
  modalBody.innerHTML = `
    <div class="coverImg" style="display:flex;align-items:center;justify-content:center;">未所持</div>
    <div class="modalTitle">${escapeHtml(series)} ${volume ? `（${volume}巻）` : ""}</div>
    <div class="modalMeta">${currentPos + 1} / ${currentEntries.length}</div>
    <div class="modalActions">
      ${volume ? `<button class="btn" id="addBtnMissing" type="button">この巻を登録</button>` : ""}
    </div>
  `;

  if (volume) {
    document.getElementById("addBtnMissing").addEventListener("click", async () => {
      const cover = await fetchCoverFromGoogleBooks(series, volume);
      await addOrUpdateBook({
        title: `${series} ${volume}巻`,
        series,
        volume,
        cover: cover || "",
        isbn: ""
      });
      const newIndex = books.findIndex(b => b.series === series && b.volume === volume);
      if (newIndex >= 0) renderVolumeDetail(newIndex);
    });
  }
}

function renderVolumeDetail(bookIndex) {
  const book = books[bookIndex];

  const pos = currentEntries.findIndex(e => e.bookIndex === bookIndex);
  if (pos >= 0) currentPos = pos;

  modalBody.innerHTML = `
    ${
      book.cover
        ? `<img class="coverImg" src="${escapeHtml(book.cover)}" alt="cover">`
        : `<div class="coverImg" style="display:flex;align-items:center;justify-content:center;">表紙なし</div>`
    }
    <div class="modalTitle">${escapeHtml(book.series)} ${book.volume ? `（${book.volume}巻）` : ""}</div>
    <div class="modalMeta">
      登録日：${escapeHtml(book.date || "不明")} / ${currentPos + 1} / ${currentEntries.length}
      ${book.isbn ? ` / ISBN:${escapeHtml(book.isbn)}` : ""}
    </div>
    <div class="modalActions">
      <button class="btn" id="pickCoverBtn" type="button">表紙を選ぶ</button>
      <button class="btn" id="refetchBtn" type="button">表紙を再取得</button>
      <button class="danger" id="deleteBtn" type="button">削除</button>
    </div>
  `;

  // ★候補から選ぶ（候補増量 + もっと候補）
  document.getElementById("pickCoverBtn").addEventListener("click", async () => {
    const candidates = await fetchCoverCandidates(book.series, book.volume, 0);
    if (!candidates.length) {
      alert("候補が見つかりませんでした。ISBN登録だと精度が上がります。");
      return;
    }
    renderCoverPicker(bookIndex, candidates, 0);
  });

  // 表紙再取得（ISBN優先）
  document.getElementById("refetchBtn").addEventListener("click", async () => {
    let newCover = "";
    if (book.isbn) {
      const meta = await fetchBookByISBN(book.isbn);
      newCover = meta?.cover || "";
    }
    if (!newCover) newCover = await fetchCoverFromGoogleBooks(book.series, book.volume);

    if (!newCover) {
      alert("表紙が見つかりませんでした。ISBN登録があると精度が上がります。");
      return;
    }

    books[bookIndex].cover = newCover;
    saveAll();
    renderVolumeDetail(bookIndex);
    if (!seriesModal.classList.contains("hidden")) openSeries(book.series);
  });

  // 削除
  document.getElementById("deleteBtn").addEventListener("click", () => {
    const label = book.volume ? `${book.series} ${book.volume}巻` : book.series;
    if (!confirm(`「${label}」を削除しますか？`)) return;

    books.splice(bookIndex, 1);
    saveAll();
    renderSeriesShelf();
    if (!seriesModal.classList.contains("hidden")) openSeries(book.series);
    hideModal();
  });
}

// 表紙候補ピッカー
function renderCoverPicker(bookIndex, candidates, page) {
  const book = books[bookIndex];
  const series = book.series;
  const vol = book.volume;

  modalBody.innerHTML = `
    <div class="modalTitle">表紙を選ぶ：${escapeHtml(series)} ${vol ? `（${vol}巻）` : ""}</div>
    <div class="modalMeta">タップした表紙を採用します（足りないなら「もっと候補」）</div>
    <div class="modalActions">
      <button class="btn" id="backBtn" type="button">戻る</button>
      <button class="btn" id="moreBtn" type="button">もっと候補</button>
    </div>
    <div class="volGrid" id="coverGrid"></div>
  `;

  document.getElementById("backBtn").addEventListener("click", () => {
    renderVolumeDetail(bookIndex);
  });

  document.getElementById("moreBtn").addEventListener("click", async () => {
    const nextPage = page + 1;
    const more = await fetchCoverCandidates(series, vol, nextPage);
    if (!more.length) {
      alert("これ以上候補が見つかりませんでした。ISBNがあると強いです。");
      return;
    }
    const merged = [...new Set([...candidates, ...more])];
    renderCoverPicker(bookIndex, merged, nextPage);
  });

  const grid = document.getElementById("coverGrid");
  candidates.forEach(url => {
    const tile = document.createElement("div");
    tile.className = "volTile owned";

    const img = document.createElement("img");
    img.className = "volThumb";
    img.src = url;
    img.alt = "candidate";

    const label = document.createElement("div");
    label.className = "volLabel";
    label.textContent = "これにする";

    tile.appendChild(img);
    tile.appendChild(label);

    tile.addEventListener("click", () => {
      books[bookIndex].cover = url;
      saveAll();
      renderVolumeDetail(bookIndex);
      if (!seriesModal.classList.contains("hidden")) openSeries(book.series);
    });

    grid.appendChild(tile);
  });
}

/* =========================
   表紙取得：候補増量版
========================= */
async function fetchCoverFromGoogleBooks(series, volume) {
  const candidates = await fetchCoverCandidates(series, volume, 0);
  return candidates[0] || "";
}

async function fetchCoverCandidates(series, volume, page = 0) {
  try {
    const startIndex = page * 40;
    const queries = [];

    if (volume) {
      queries.push(`intitle:"${series}" ${volume} 巻`);
      queries.push(`"${series}" "${volume}" 巻`);
      queries.push(`"${series}" 第${volume}巻`);
      queries.push(`${series} ${volume} コミックス`);
      queries.push(`${series} ${volume} 単行本`);
    } else {
      queries.push(`intitle:"${series}"`);
      queries.push(`"${series}" コミックス`);
      queries.push(`${series} 単行本`);
    }

    const all = [];
    for (const q of queries) {
      const url =
        `https://www.googleapis.com/books/v1/volumes?` +
        `q=${encodeURIComponent(q)}` +
        `&maxResults=40` +
        `&startIndex=${startIndex}` +
        `&printType=books` +
        `&langRestrict=ja` +
        `&orderBy=relevance`;

      const res = await fetch(url);
      const data = await res.json();
      const items = data.items || [];

      for (const it of items) {
        const v = it.volumeInfo;
        const img = v?.imageLinks?.thumbnail || v?.imageLinks?.smallThumbnail;
        if (!img) continue;

        const thumb = img.replace("http://", "https://");
        const title = (v?.title || "").toString();

        all.push({ thumb, title });
      }
    }

    // スコアリング（巻があるなら巻数一致を上げる）
    const vStr = volume ? String(volume) : "";
    const scored = all.map(x => {
      let score = 0;
      if (volume && x.title.includes(vStr)) score += 2;
      if (volume && x.title.includes(`第${vStr}巻`)) score += 2;
      if (x.title.includes(series)) score += 1;
      return { ...x, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const urls = [];
    for (const s of scored) {
      if (!urls.includes(s.thumb)) urls.push(s.thumb);
      if (urls.length >= 30) break; // 1ページ最大30
    }
    return urls;
  } catch {
    return [];
  }
}

/* =========================
   ISBN
========================= */
async function fetchBookByISBN(isbn) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
    const res = await fetch(url);
    const data = await res.json();
    const item = data.items?.[0]?.volumeInfo;
    if (!item) return null;

    const title = item.title || "";
    const cover = (item.imageLinks?.thumbnail || item.imageLinks?.smallThumbnail || "").replace("http://", "https://");
    const parsed = parseSeriesAndVolume(title);

    return { title, series: parsed.series, volume: parsed.volume, cover };
  } catch {
    return null;
  }
}

function normalizeISBN(text) {
  const digits = String(text).replace(/[^\dXx]/g, "");
  if (digits.length === 13 && digits.startsWith("97")) return digits;
  if (digits.length === 10) return digits.toUpperCase();
  return "";
}

/* =========================
   最大巻 推定（精度保証なし）
========================= */
async function estimateMaxVolumeFromGoogleBooks(series) {
  try {
    let best = 0;

    for (const startIndex of [0, 40, 80, 120]) {
      const url =
        `https://www.googleapis.com/books/v1/volumes?` +
        `q=${encodeURIComponent(series)}&maxResults=40&startIndex=${startIndex}&printType=books&langRestrict=ja`;

      const res = await fetch(url);
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) continue;

      for (const it of items) {
        const title = it.volumeInfo?.title || "";
        const p = parseSeriesAndVolume(title);
        if (normalizeSeries(p.series) === normalizeSeries(series) && p.volume) {
          best = Math.max(best, p.volume);
        }
      }
    }

    return best || 0;
  } catch {
    return 0;
  }
}

function normalizeSeries(s) {
  return String(s)
    .replace(/\s+/g, "")
    .replace(/[！!？?・:：\-－]/g, "")
    .toLowerCase();
}

/* =========================
   巻数解析
========================= */
function parseSeriesAndVolume(raw) {
  const t = raw.trim();

  let m = t.match(/^(.*?)(?:\s*[-－:：]?\s*)?(?:第?\s*(\d+)\s*巻)\s*$/);
  if (m) return { series: m[1].trim(), volume: Number(m[2]) };

  m = t.match(/^(.*?)[\s　]*[（(]\s*(\d+)\s*[）)]\s*$/);
  if (m) return { series: m[1].trim(), volume: Number(m[2]) };

  m = t.match(/^(.*?)[\s　]+(\d+)\s*$/);
  if (m) return { series: m[1].trim(), volume: Number(m[2]) };

  return { series: t, volume: null };
}

/* =========================
   保存/読込/移行
========================= */
function saveAll() {
  localStorage.setItem(STORAGE_BOOKS, JSON.stringify(books));
  localStorage.setItem(STORAGE_SERIESMAX, JSON.stringify(seriesMax));
}

function loadAll() {
  books = JSON.parse(localStorage.getItem(STORAGE_BOOKS) || "[]");
  seriesMax = JSON.parse(localStorage.getItem(STORAGE_SERIESMAX) || "{}");
}

function migrateOld() {
  // 古い"books"があれば拾う
  const old = localStorage.getItem("books");
  if (old && !localStorage.getItem(STORAGE_BOOKS)) {
    try {
      const arr = JSON.parse(old);
      if (Array.isArray(arr)) {
        books = arr.map(x => {
          if (typeof x === "string") {
            const p = parseSeriesAndVolume(x);
            return { title: x, series: p.series, volume: p.volume, cover: "", date: "", isbn: "" };
          }
          const title = x.title || "";
          const p = parseSeriesAndVolume(title);
          return {
            title,
            series: x.series ?? p.series,
            volume: (x.volume ?? p.volume) ?? null,
            cover: x.cover ?? "",
            date: x.date ?? "",
            isbn: x.isbn ?? ""
          };
        });
      }
    } catch {}
  }

  // 欠けてる情報を補完
  books = (books || []).map(b => {
    const title = b.title || "";
    const p = parseSeriesAndVolume(title);
    return {
      title,
      series: b.series ?? p.series,
      volume: (b.volume ?? p.volume) ?? null,
      cover: b.cover ?? "",
      date: b.date ?? "",
      isbn: b.isbn ?? ""
    };
  });

  // seriesMaxが空なら所持最大から推定
  const bySeries = groupBySeries(books);
  Object.keys(bySeries).forEach(s => {
    if (!seriesMax[s]) {
      const mx = Math.max(0, ...bySeries[s].filter(b => b.volume).map(b => b.volume));
      if (mx) seriesMax[s] = mx;
    }
  });
}

function groupBySeries(list) {
  const obj = {};
  list.forEach(b => {
    const s = b.series || b.title || "未分類";
    if (!obj[s]) obj[s] = [];
    obj[s].push(b);
  });
  return obj;
}

/* =========================
   ISBNスキャン（対応ブラウザのみ）
========================= */
scanBtn.addEventListener("click", async () => {
  if (!("BarcodeDetector" in window)) {
    alert("このブラウザはISBNスキャン非対応です。ISBNを手入力してください（13桁）。");
    return;
  }

  try {
    barcodeDetector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128"] });
  } catch {
    alert("スキャン機能を初期化できませんでした。ISBNを手入力してください。");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = mediaStream;
  } catch {
    alert("カメラを起動できませんでした。ブラウザ権限を確認してください。");
    return;
  }

  scanStatus.textContent = "バーコードをカメラに映してください…";
  showScan();

  scanTimer = setInterval(async () => {
    try {
      const barcodes = await barcodeDetector.detect(video);
      if (barcodes && barcodes.length) {
        const raw = barcodes[0].rawValue || "";
        const isbn = normalizeISBN(raw);
        if (isbn) {
          scanStatus.textContent = `検出：${isbn}`;
          stopScan();
          bookInput.value = isbn;
          addBtn.click();
        }
      }
    } catch {}
  }, 300);
});

closeScan.addEventListener("click", () => stopScan());
scanModal.addEventListener("click", (e) => { if (e.target === scanModal) stopScan(); });

function showScan() {
  scanModal.classList.remove("hidden");
  scanModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function hideScan() {
  scanModal.classList.add("hidden");
  scanModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
function stopScan() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;

  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  video.srcObject = null;

  hideScan();
}

/* =========================
   モーダル開閉
========================= */
function showSeriesModal() {
  seriesModal.classList.remove("hidden");
  seriesModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function hideSeriesModal() {
  seriesModal.classList.add("hidden");
  seriesModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
closeSeries.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); hideSeriesModal(); });
seriesModal.addEventListener("click", (e) => { if (e.target === seriesModal) hideSeriesModal(); });

function showModal() {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function hideModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
closeModal.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); hideModal(); });
modal.addEventListener("click", (e) => { if (e.target === modal) hideModal(); });

document.addEventListener("keydown", (e) => {
  if (!modal.classList.contains("hidden")) {
    if (e.key === "Escape") hideModal();
    if (e.key === "ArrowLeft") goPrev();
    if (e.key === "ArrowRight") goNext();
  } else if (!seriesModal.classList.contains("hidden")) {
    if (e.key === "Escape") hideSeriesModal();
  }
});

// swipe for volume detail
const modalContent = modal.querySelector(".modalContent");
modalContent.addEventListener("touchstart", (e) => {
  if (modal.classList.contains("hidden")) return;
  const t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
}, { passive: true });

modalContent.addEventListener("touchend", (e) => {
  if (modal.classList.contains("hidden")) return;
  if (touchStartX === null || touchStartY === null) return;

  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    dx < 0 ? goNext() : goPrev();
  }
  touchStartX = null;
  touchStartY = null;
});

/* =========================
   見た目
========================= */
function calmColor(seed) {
  const base = ["#6f6a61", "#5e6768", "#6a6b76", "#6b5f5b", "#657061", "#6a6358"];
  const c = base[hash(seed) % base.length];
  return `
    linear-gradient(180deg, rgba(255,255,255,.16), rgba(0,0,0,.08)),
    repeating-linear-gradient(90deg, rgba(255,255,255,.10) 0px, rgba(255,255,255,.10) 2px, rgba(255,255,255,.0) 2px, rgba(255,255,255,.0) 10px),
    ${c}
  `;
}

function hash(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function placeholderCoverDataUrl() {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">
      <rect width="100%" height="100%" fill="#f1f1f1"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="20" fill="#999">No Cover</text>
    </svg>
  `);
}
