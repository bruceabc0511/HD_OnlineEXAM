/**
 * 線上筆試測驗系統 - 核心邏輯 (app.js) — 雲端多人連線與歷史場次版 (方案 B)
 * 功能包含：
 * 1. 雲端多人同步 (Google Apps Script + GitHub Pages)：跨網路多人同時連線應試、QR Code 專屬應試連結、即時同步題庫與交卷紀錄
 * 2. 考生端 (#007979 主題)：僅在考官「開始測驗」開放試卷期間顯示內容（試卷關閉時完全不顯示任何內容）、姓名/編號/Email 登入、防重複應試、亂數題目、防作弊監控
 * 3. 考官端 (#750000 主題)：PIN 碼安全加密驗證、開始/結束測驗開關控制、Excel 範本匯入（支援空白題庫）、考後寄送考生成績單 Email、每次測驗獨立歸檔為歷史紀錄、錯題分析
 */

// 若有固定部署的預設 Google Apps Script 網址可填於此處；系統亦支援填入一次後自動透過雲端 KV 跨裝置永久綁定
const DEFAULT_GAS_URL = '';
const CLOUD_BIND_KV_APP_KEY = 'i1y48rk0';
const CLOUD_BIND_KV_FIELD = 'hd_exam_gas_id';
const CLOUD_BIND_NTFY_TOPIC = 'hd_online_exam_gas_bind_bruceabc0511';

const STORAGE_KEYS = {
  EXAM_DATA: 'online_exam_bank_v1',
  SUBMISSIONS: 'online_exam_submissions_v1',
  HISTORY_SESSIONS: 'online_exam_history_v1',
  GAS_URL: 'online_exam_gas_url_v1',
  EXAM_LIBRARY: 'online_exam_library_v1',
  EXAMINER_PIN_HASH: 'online_exam_pin_hash_v1'
};

// 考官端 PIN 碼與管理員金鑰安全防護設定 (不在原始碼中儲存任何明文密碼，採用 Salt + SHA-256 加密雜湊)
const EXAMINER_PIN_SALT = 'HD_EXAM_SECURE_SALT_2026';
const DEFAULT_EXAMINER_PIN_HASH = '391f59f4ca8480648b504098e96bffa16f970d261a5cacea40fe5e7789c3f961';

const ADMIN_KEY_SALT = 'HD_EXAM_ADMIN_SALT_2026';
const ADMIN_KEY_HASH = '4007531f25ed2a163a091d340f3fcb5d7bbabb98c22c65074d60152eec2c9b6a';

// 預設題庫 (支援空白題庫與預設關閉試卷狀態)
const DEFAULT_EXAM_DATA = {
  id: 'exam_default',
  title: '未命名測驗',
  durationMinutes: 60,
  examDate: '',
  isExamOpen: false,
  openedAt: null,
  activeExamToken: null, // 模式 A：{ token: 'tk_xxx', createdAt: 0, expiresAt: 0, durationMinutes: 180 }
  questions: []
};

// 系統狀態
let examData = loadExamData();
let examLibrary = loadExamLibrary();
let currentSelectedExamId = (examData && examData.id && examLibrary.some(e => e.id === examData.id))
  ? examData.id
  : (examLibrary[0] ? examLibrary[0].id : 'exam_default');
let submissions = loadSubmissions();
let historySessions = loadHistorySessions();
let isExaminerAuthenticated = false;
let currentExaminerAuthToken = '';
let lastCloudUpdatedAt = '';
let lastCloudSyncExaminer = false;
let currentActiveExaminerTab = 'tabQuestions';
let cloudPollIntervalMs = 10000;
let currentViewingHistoryId = null;
let cloudPollTimer = null;
let examinerLiveTimerInterval = null;
let lastExamDataSaveAt = 0;
let lastExamLibrarySaveAt = 0;
let isGasUrlUnlockedBySecret = false;
let gasSecretClickCount = 0;
let gasSecretClickResetTimer = null;
let editingQuestionId = null;
let currentExamTokenStatus = 'unknown'; // 'valid' | 'expired' | 'invalid' | 'not_generated'
let examTokenCountdownTimer = null;

// 考官 PIN 碼登入防護狀態
let pinFailedAttempts = 0;
let pinLockoutRemaining = 0;
let pinLockoutTimer = null;
let isPinLoggingIn = false;

// 當前考試進行中狀態
let activeSession = {
  isActive: false,
  studentName: '',
  studentId: '',
  studentEmail: '',
  startTime: null,
  remainingSeconds: 0,
  timerInterval: null,
  shuffledQuestions: [],
  answers: {}, // { originalQuestionId: 'A' }
  warningCount: 0,
  lastCheatTriggerAt: 0
};
let activeExamStatusTimer = null;
let isCheckingExamStatus = false;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  await initCloudUrlFromQueryOrDefault();
  updateCloudStatusUI();
  setupExamMetaAutoSync();
  setupDragAndDrop();
  setupAntiCheatListeners();
  startExamTokenCountdown();
  setupExaminerIdleDetector();

  // 解析 URL 是否含有隨機測驗 Token 參數或指定考生角色
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();
  const roleParam = (urlParams.get('role') || '').trim();

  if (urlToken || roleParam === 'student') {
    // 透過隨機測驗連結或指定考生端進入：進入考生端
    switchRole('student');
    if (urlToken) {
      await validateCurrentExamToken(urlToken);
    }
  } else {
    // 直連根網址 (預設畫面)：直接顯示考官端登入畫面 (PIN 碼驗證卡片)
    switchRole('examiner');
  }

  // 跨分頁即時同步考官試卷開關狀態 (當考官結束測驗時，作答中考生分頁毫秒級自動強制交卷)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.EXAM_DATA && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        const isNowOpen = Boolean(parsed.isExamOpen);
        examData.isExamOpen = isNowOpen;
        if (parsed.activeExamToken) {
          examData.activeExamToken = parsed.activeExamToken;
          updateExamLinkTabUI();
        }
        if (!isNowOpen) {
          if (activeSession && activeSession.isActive) {
            finalizeExamSubmission('測驗結束強制交卷');
          } else {
            renderStudentLoginMeta();
          }
        } else {
          if (!activeSession.isActive) {
            renderStudentLoginMeta();
          }
        }
      } catch (err) { }
    }
  });

  // 若已綁定雲端網址，啟動時自動從雲端拉取最新題庫、開放狀態與成績紀錄
  if (getActiveGasUrl()) {
    await syncStateFromCloud(true);
    startCloudPolling();
  }
});

// ==================== 雲端多人連線與同步 ====================
function getActiveGasUrl() {
  return (localStorage.getItem(STORAGE_KEYS.GAS_URL) || DEFAULT_GAS_URL || '').trim();
}

function buildFullGasUrl(depIdOrUrl) {
  const clean = String(depIdOrUrl || '').trim();
  if (!clean || clean === 'NONE') return '';
  return clean.startsWith('http')
    ? clean
    : `https://script.google.com/macros/s/${clean}/exec`;
}

async function saveGlobalBoundGasUrl(gasUrl) {
  const depId = extractGasDeploymentId(gasUrl) || 'NONE';
  try {
    await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${CLOUD_BIND_KV_APP_KEY}/${CLOUD_BIND_KV_FIELD}/${encodeURIComponent(depId)}`,
      { method: 'POST' }
    );
  } catch (e) {
    console.warn('Global KV bind update failed:', e);
  }
  try {
    await fetch(`https://ntfy.sh/${CLOUD_BIND_NTFY_TOPIC}`, {
      method: 'POST',
      body: JSON.stringify({ depId })
    });
  } catch (e) { }
}

async function fetchGlobalBoundGasUrl() {
  // 1. 優先向永久保存的 KeyValue 雲端設定庫讀取已綁定的 GAS 部署 ID
  try {
    const res = await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${CLOUD_BIND_KV_APP_KEY}/${CLOUD_BIND_KV_FIELD}?_t=${Date.now()}`
    );
    if (res.ok) {
      const val = await res.json();
      if (val && val !== 'NONE') {
        return buildFullGasUrl(val);
      }
      if (val === 'NONE') {
        return '';
      }
    }
  } catch (e) {
    console.warn('Global KV bind fetch failed:', e);
  }

  // 2. 備援：向 ntfy 頻道讀取最近一次綁定紀錄
  try {
    const res2 = await fetch(`https://ntfy.sh/${CLOUD_BIND_NTFY_TOPIC}/json?poll=1&since=all`);
    if (res2.ok) {
      const text = await res2.text();
      const lines = text.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const lastEvt = JSON.parse(lines[lines.length - 1]);
        const payload = JSON.parse(lastEvt.message || '{}');
        if (payload.depId && payload.depId !== 'NONE') {
          return buildFullGasUrl(payload.depId);
        }
      }
    }
  } catch (e) { }

  return '';
}

async function initCloudUrlFromQueryOrDefault() {
  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get('api');
  if (apiParam) {
    const fullUrl = buildFullGasUrl(apiParam);
    if (fullUrl) {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, fullUrl);
      saveGlobalBoundGasUrl(fullUrl);
      return;
    }
  }

  if (DEFAULT_GAS_URL && !localStorage.getItem(STORAGE_KEYS.GAS_URL)) {
    localStorage.setItem(STORAGE_KEYS.GAS_URL, DEFAULT_GAS_URL);
  }

  const localUrl = getActiveGasUrl();
  const remoteBoundUrl = await fetchGlobalBoundGasUrl();

  if (remoteBoundUrl) {
    // 若雲端已有綁定網址，所有新裝置開啟網頁時直接自動套用綁定
    if (!localUrl || localUrl !== remoteBoundUrl) {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, remoteBoundUrl);
    }
  } else if (localUrl) {
    // 若本機已填過網址但雲端尚未記錄，自動將本機網址上傳為跨裝置全域綁定
    await saveGlobalBoundGasUrl(localUrl);
  }
}

function extractGasDeploymentId(url) {
  const match = String(url || '').match(/\/macros\/s\/([^/]+)\/exec/);
  return match ? match[1] : '';
}

function buildStudentShareUrl() {
  const baseUrl = window.location.origin + window.location.pathname;
  const gasUrl = getActiveGasUrl();
  const params = new URLSearchParams();

  if (gasUrl) {
    const depId = extractGasDeploymentId(gasUrl);
    params.set('api', depId || gasUrl);
  }

  // 模式 A：將當前有效的隨機測驗 Token 帶入作答連結中，若尚未生成則預設指定考生端
  if (examData && examData.activeExamToken && examData.activeExamToken.token) {
    params.set('token', examData.activeExamToken.token);
  } else {
    params.set('role', 'student');
  }

  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

function updateCloudStatusUI() {
  const gasUrl = getActiveGasUrl();
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const urlInput = document.getElementById('gasWebAppUrlInput');
  const btnSaveGasUrl = document.getElementById('btnSaveGasUrl');
  const lockBadge = document.getElementById('gasLockStatusBadge');
  const shareInput = document.getElementById('studentShareUrlInput');
  const qrImg = document.getElementById('studentQrImage');
  const qrHint = document.getElementById('qrCodeHint');

  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = gasUrl;
  }

  // 若已綁定 Google Apps Script 網址且尚未觸發 10 次暗鎖解鎖，鎖定輸入框與儲存按鈕避免誤刪
  const shouldLockInput = Boolean(gasUrl) && !isGasUrlUnlockedBySecret;
  if (urlInput) {
    urlInput.readOnly = shouldLockInput;
    urlInput.disabled = shouldLockInput;
    urlInput.classList.toggle('input-locked', shouldLockInput);
  }
  if (btnSaveGasUrl) {
    btnSaveGasUrl.disabled = shouldLockInput;
  }
  if (lockBadge) {
    if (!gasUrl) {
      lockBadge.classList.add('hidden');
    } else if (shouldLockInput) {
      lockBadge.textContent = '🔒 已綁定鎖定';
      lockBadge.className = 'badge badge-teal';
    } else {
      lockBadge.textContent = '🔓 已解鎖編輯';
      lockBadge.className = 'badge badge-amber';
    }
  }

  if (gasUrl) {
    if (dot) dot.classList.remove('offline');
    if (text) text.textContent = '已連線';
    const shareUrl = buildStudentShareUrl();
    if (shareInput) shareInput.value = shareUrl;
    if (qrImg && qrHint) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`;
      qrImg.classList.remove('hidden');
      qrHint.innerHTML = '<span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="openStandaloneQrPage()">🔍 點選 QR Code 可開啟獨立頁面單獨顯示</span>';
    }
  } else {
    if (dot) dot.classList.add('offline');
    if (text) text.textContent = '尚未連線';
    if (shareInput) shareInput.value = window.location.origin + window.location.pathname;
    if (qrImg && qrHint) {
      qrImg.classList.add('hidden');
      qrHint.textContent = '請先於上方填入 Google Apps Script 網址並儲存，即可產生跨裝置多人連線 QR Code';
    }
  }
  updateExamLinkTabUI();
}

function handleGasCloudIconClick() {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl || isGasUrlUnlockedBySecret) return;

  gasSecretClickCount += 1;
  if (gasSecretClickResetTimer) {
    clearTimeout(gasSecretClickResetTimer);
  }
  gasSecretClickResetTimer = setTimeout(() => {
    gasSecretClickCount = 0;
  }, 4000);

  if (gasSecretClickCount >= 10) {
    gasSecretClickCount = 0;
    isGasUrlUnlockedBySecret = true;
    updateCloudStatusUI();
    const urlInput = document.getElementById('gasWebAppUrlInput');
    if (urlInput) {
      urlInput.focus();
      urlInput.select();
    }
    showToast('🔓 已開啟 Google Apps Script 網址欄位編輯權限！');
  }
}

function handleCloudPillClick() {
  if (activeSession.isActive) return;
  if (isExaminerAuthenticated) {
    switchRole('examiner');
    switchExaminerTab('tabSettings');
  } else {
    const gasUrl = getActiveGasUrl();
    if (gasUrl) {
      syncStateFromCloud(false);
    } else {
      showToast('💡 請切換至「考官端」➔「系統設定」綁定 Google 雲端試算表');
    }
  }
}

function adjustCloudPollInterval(intervalMs) {
  if (cloudPollIntervalMs === intervalMs && cloudPollTimer) return;
  cloudPollIntervalMs = intervalMs;
  startCloudPolling();
}

function startCloudPolling() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    // 僅在非作答進行中且已設定雲端時背景靜默同步
    if (!activeSession.isActive && getActiveGasUrl()) {
      syncStateFromCloud(true);
    }
  }, cloudPollIntervalMs);
}

// 效能優化：分頁隱藏時降頻至 3 分鐘，切回前台時立即檢查並恢復 10 秒
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    adjustCloudPollInterval(180000);
  } else {
    // 若為考官已登入狀態，檢查是否已閒置超過 30 分鐘 (特別針對行動裝置喚醒/切換 App)
    checkExaminerIdleTimeout();
    adjustCloudPollInterval(10000);
    if (!activeSession.isActive && getActiveGasUrl()) {
      syncStateFromCloud(true);
    } else if (activeSession.isActive) {
      // 考生作答中切回前台時，立即檢查一次測驗是否已被考官結束作答
      if (!examData.isExamOpen) {
        finalizeExamSubmission('測驗結束強制交卷');
      } else {
        const gasUrl = getActiveGasUrl();
        if (gasUrl) {
          fetch(`${gasUrl}?action=checkState&_t=${Date.now()}`)
            .then(res => res.json())
            .then(json => {
              if (json && json.status === 'success' && json.isExamOpen === false) {
                examData.isExamOpen = false;
                if (activeSession.isActive) {
                  finalizeExamSubmission('測驗結束強制交卷');
                }
              }
            })
            .catch(() => { });
        }
      }
    }
  }
});

async function syncStateFromCloud(silent = true, force = false) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    if (!silent) {
      showToast('⚠️ 尚未設定 Google Apps Script 雲端網址，目前為本機儲存模式');
    }
    return false;
  }

  if (!silent) {
    showToast('🔄 正在從雲端資料庫同步最新試卷資訊...');
  }

  try {
    const tokenParam = (isExaminerAuthenticated && currentExaminerAuthToken)
      ? `&token=${encodeURIComponent(currentExaminerAuthToken)}`
      : '';
    const res = await fetch(`${gasUrl}?action=getExamState${tokenParam}&_t=${Date.now()}`);
    const json = await res.json();
    if (json && json.status === 'success') {
      // 效能優化：若背景靜默輪詢時雲端 updatedAt 毫無變更且考官授權身分未切換，直接跳過重繪以節省 CPU
      if (silent && !force && json.updatedAt && json.updatedAt === lastCloudUpdatedAt && lastCloudSyncExaminer === isExaminerAuthenticated) {
        updateCloudStatusUI();
        return true;
      }
      if (json.updatedAt) {
        lastCloudUpdatedAt = json.updatedAt;
      }
      const roleJustUpgraded = isExaminerAuthenticated && !lastCloudSyncExaminer;
      lastCloudSyncExaminer = isExaminerAuthenticated;

      // 讀取試卷庫：雙軌相容讀取（優先讀取專屬 examLibrary 欄位，若無則讀取 examData.examLibrary 備援）
      const cloudLibrary = (Array.isArray(json.examLibrary) && json.examLibrary.length > 0)
        ? json.examLibrary
        : (json.examData && Array.isArray(json.examData.examLibrary) && json.examData.examLibrary.length > 0
          ? json.examData.examLibrary
          : null);

      // 當考官已登入後台或剛異動過試卷庫時，背景靜默輪詢 (silent=true) 不覆蓋本機試卷庫，避免新匯入或手動編輯內容被雲端舊狀態覆蓋
      const shouldSyncExamLibrary = !silent || force || roleJustUpgraded || (!isExaminerAuthenticated && (Date.now() - lastExamLibrarySaveAt > 15000));
      if (shouldSyncExamLibrary && cloudLibrary) {
        examLibrary = cloudLibrary;
        localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(examLibrary));
        if (!currentSelectedExamId || !examLibrary.some(e => e.id === currentSelectedExamId)) {
          currentSelectedExamId = examLibrary[0].id;
        }
      }

      // 當考官已登入後台或剛修改過試卷設定時，背景輪詢 (silent=true) 不覆蓋本機 examData，避免手動修改的「當前試卷資訊」跳回舊範本內容
      const shouldSyncExamData = !silent || force || roleJustUpgraded || (!isExaminerAuthenticated && (Date.now() - lastExamDataSaveAt > 15000));
      if (shouldSyncExamData && json.examData && Array.isArray(json.examData.questions)) {
        const localAnswerMap = {};
        if (examData && Array.isArray(examData.questions)) {
          examData.questions.forEach(q => {
            if (q && q.id && q.answer !== undefined) localAnswerMap[q.id] = q.answer;
          });
        }
        const matchedLibExam = Array.isArray(examLibrary)
          ? examLibrary.find(e => e && e.id === (json.examData.id || 'exam_default'))
          : null;
        if (matchedLibExam && Array.isArray(matchedLibExam.questions)) {
          matchedLibExam.questions.forEach(q => {
            if (q && q.id && q.answer !== undefined && localAnswerMap[q.id] === undefined) {
              localAnswerMap[q.id] = q.answer;
            }
          });
        }

        const mergedQuestions = json.examData.questions.map(q => {
          if (q && q.answer === undefined && localAnswerMap[q.id] !== undefined) {
            return Object.assign({}, q, { answer: localAnswerMap[q.id] });
          }
          return q;
        });

        examData = {
          id: json.examData.id || 'exam_default',
          title: json.examData.title ?? '',
          durationMinutes: json.examData.durationMinutes === '' ? '' : (Number(json.examData.durationMinutes) || 60),
          examDate: normalizeDateForInput(json.examData.examDate ?? ''),
          isExamOpen: Boolean(json.examData.isExamOpen),
          openedAt: json.examData.openedAt ? Number(json.examData.openedAt) : (json.examData.isExamOpen ? (examData.openedAt || Date.now()) : null),
          activeExamToken: json.examData.activeExamToken || examData.activeExamToken || null,
          questions: mergedQuestions
        };
        // 若為考官授權同步，或題目含有完整答案，才寫入本機儲存，避免考生模式無答案資料覆蓋單機版題庫
        if (json.isExaminer !== false || mergedQuestions.every(q => q && q.answer !== undefined)) {
          localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
        }
      }
      if (json.isExaminer !== false && Array.isArray(json.submissions)) {
        submissions = json.submissions;
        localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
      }
      if (json.isExaminer !== false && Array.isArray(json.historySessions)) {
        historySessions = json.historySessions;
        localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));
      }

      if (!activeSession.isActive) {
        renderStudentLoginMeta();
      }
      if (isExaminerAuthenticated) {
        refreshExaminerAllViews();
      }
      updateCloudStatusUI();

      if (!silent) {
        const statusStr = examData.isExamOpen ? '開放中' : '已關閉';
        showToast(`✅ 雲端同步成功！試卷狀態：【${statusStr}】，共 ${examData.questions.length} 題，已交卷 ${submissions.length} 人。`);
      }
      return true;
    }
  } catch (err) {
    console.warn('Cloud sync error:', err);
    if (!silent) {
      showToast('❌ 雲端同步失敗，請確認網路或 Apps Script 部署權限設為「所有人」');
    }
  }
  return false;
}

async function postToCloud(payload, maxRetries = 2) {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) return null;

  // 自動附加考官身分驗證 Token，確保後端管理操作通過身分審查
  if (isExaminerAuthenticated && currentExaminerAuthToken && !payload.authPinHash) {
    payload.authPinHash = currentExaminerAuthToken;
  }

  // 併發退避重試機制：當後端鎖服務繁忙 (status: 'busy') 時自動延遲重試，防止交卷遺漏
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data && data.status === 'busy' && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        continue;
      }
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        continue;
      }
      console.error('Post to cloud error:', err);
      return null;
    }
  }
  return null;
}

async function saveGasUrlConfig() {
  const input = document.getElementById('gasWebAppUrlInput');
  const val = input ? input.value.trim() : '';

  if (!val) {
    localStorage.removeItem(STORAGE_KEYS.GAS_URL);
    isGasUrlUnlockedBySecret = false;
    gasSecretClickCount = 0;
    await saveGlobalBoundGasUrl('');
    updateCloudStatusUI();
    showToast('⚪ 已解除綁定並切換回本機儲存模式');
    return;
  }

  if (!val.startsWith('https://script.google.com/macros/s/')) {
    alert('請輸入正確的 Google Apps Script 網頁應用程式網址（格式為 https://script.google.com/macros/s/.../exec）！');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.GAS_URL, val);
  isGasUrlUnlockedBySecret = false;
  gasSecretClickCount = 0;
  await saveGlobalBoundGasUrl(val);
  updateCloudStatusUI();
  startCloudPolling();

  showToast('🔌 正在驗證並跨裝置綁定雲端資料庫...');
  const ok = await syncStateFromCloud(false);
  if (ok) {
    await postToCloud({
      action: 'saveExamData',
      examData: examData
    });
  }
}

async function testGasConnection() {
  const input = document.getElementById('gasWebAppUrlInput');
  const url = (input && input.value.trim()) ? input.value.trim() : getActiveGasUrl();
  if (!url) {
    alert('請先在輸入框貼上 Google Apps Script 網頁應用程式網址 (.../exec)！');
    return;
  }

  showToast('🔌 正在測試連線至 Google Apps Script...');
  try {
    const res = await fetch(`${url}?action=ping&_t=${Date.now()}`);
    const json = await res.json();
    if (json && json.status === 'success') {
      localStorage.setItem(STORAGE_KEYS.GAS_URL, url);
      await saveGlobalBoundGasUrl(url);
      updateCloudStatusUI();

      if (json.hasExamLibrarySupport) {
        showToast('✅ 連線成功！雲端資料庫運作正常！');
      } else {
        alert(
          '✅ 連線成功！雲端資料庫運作正常。\n\n💡 系統偵測到試算表 Apps Script 目前處於舊版部署（已自動啟用狀態庫雙軌同步，試卷庫跨裝置切換不受影響）。\n若您希望在 Google 試算表中看到獨立的【試卷庫資料】工作表，請於 Apps Script「管理部署作業」編輯時選擇「建立新版本」重新部署。'
        );
      }
    } else {
      showToast('⚠️ 收到回應但狀態異常，請確認部署權限設為「所有人」');
    }
  } catch (err) {
    showToast('❌ 連線測試失敗：請確認網址為 /exec 結尾且誰可以存取設為「所有人 (Anyone)」');
  }
}

async function pushAllLocalDataToCloud() {
  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    alert('請先設定並儲存 Google Apps Script 網址！');
    return;
  }
  showToast('⬆️ 正在將本機試卷庫、當前試卷、成績與歷史紀錄完整推送至雲端...');
  await postToCloud({ action: 'saveExamData', examData, examLibrary });
  await postToCloud({ action: 'saveExamLibrary', examLibrary });
  await postToCloud({ action: 'syncSubmissions', examData, submissions });
  const res = await postToCloud({ action: 'syncHistory', historySessions });
  if (res && res.status === 'success') {
    showToast('✅ 已將本機所有試卷庫、當前試卷、成績與歷史紀錄同步至雲端資料庫！');
  } else {
    showToast('⚠️ 推送完成，若部分資料未更新請檢查網路連線');
  }
}

// ==================== 隨機測驗連結 (180分鐘有效，覆蓋即失效) ====================
function generateRandomExamToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  if (window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(12);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) {
      rand += chars[bytes[i] % chars.length];
    }
  } else {
    for (let i = 0; i < 16; i++) {
      rand += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return 'tk_' + rand;
}

function isExamTokenActive(tokenObj) {
  if (!tokenObj || !tokenObj.token) return false;
  return Date.now() < Number(tokenObj.expiresAt || 0);
}

async function handleGenerateExamToken() {
  if (examData.isExamOpen) {
    alert('⛔ 測驗正在進行中！\n\n' + '若要重新生成連結，請先【結束當前的測驗】。');
    return;
  }

  if (examData.activeExamToken && isExamTokenActive(examData.activeExamToken)) {
    const confirmRegen = confirm(
      '⚠️ 目前已有使用中的隨機測驗連結！\n\n' +
      '若重新生成，先前發送給考生的舊連結將【立即失效作廢】。\n\n' +
      '確定要重新生成新的測驗連結嗎？'
    );
    if (!confirmRegen) return;
  }

  const now = Date.now();
  const token = generateRandomExamToken();
  const durationMinutes = 180;
  const durationMs = durationMinutes * 60 * 1000;

  examData.activeExamToken = {
    token: token,
    createdAt: now,
    expiresAt: now + durationMs,
    durationMinutes: durationMinutes
  };

  saveExamDataToStorage(true);
  updateExamLinkTabUI();
  showToast('🎲 已成功生成隨機測驗連結！');
}

async function handleRevokeExamToken() {
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 目前並無有效的測驗連結可停用！');
    return;
  }

  const isExamRunning = Boolean(examData.isExamOpen);
  const confirmMessage = isExamRunning
    ? '⚠️ 測驗正在進行中！\n\n' + '停用連結會【立即終止測驗】並強制收卷。\n\n' + '確定要停用測驗連結並結束作答嗎？'
    : '⚠️ 確定要立即停用當前的測驗連結嗎？\n\n' +
    '停用後，當前的測驗連結將【立即失效】！\n' +
    '考生將無法再透過該網址進入作答。\n\n' +
    '確定要執行停用嗎？';

  const confirmRevoke = confirm(confirmMessage);
  if (!confirmRevoke) return;

  examData.activeExamToken = null;
  if (isExamRunning) {
    examData.isExamOpen = false;
    examData.openedAt = null;
    stopExaminerLiveTimer();
  }

  saveExamDataToStorage(true);
  if (isExamRunning) {
    refreshExaminerAllViews();
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
    }
    showToast('🛑 已停用測驗連結並結束當前測驗！');
  } else {
    updateExamLinkTabUI();
    showToast('🛑 已停用所有測驗連結！');
  }
}

function updateExamLinkTabUI() {
  const tokenObj = examData.activeExamToken;
  const statusBadge = document.getElementById('tokenStatusBadge');
  const tokenMetaBox = document.getElementById('tokenMetaBox');
  const tokenTimeRemainingEl = document.getElementById('tokenTimeRemaining');
  const tokenCreatedAtEl = document.getElementById('tokenCreatedAt');
  const tokenExpiresAtEl = document.getElementById('tokenExpiresAt');
  const btnGenToken = document.getElementById('btnGenerateExamToken');
  const btnRevokeToken = document.getElementById('btnRevokeExamToken');
  const shareInput = document.getElementById('studentShareUrlInput');
  const qrImg = document.getElementById('studentQrImage');
  const qrHint = document.getElementById('qrCodeHint');

  const now = Date.now();
  const hasToken = tokenObj && tokenObj.token;
  const isExpired = hasToken && (now > Number(tokenObj.expiresAt || 0));

  if (!hasToken) {
    if (statusBadge) {
      statusBadge.className = 'badge badge-secondary';
      statusBadge.textContent = '⚪ 尚未生成';
    }
    if (tokenMetaBox) tokenMetaBox.classList.add('hidden');
    if (btnGenToken) {
      btnGenToken.innerHTML = `產生連結`;
      btnGenToken.className = 'btn btn-token-primary';
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke hidden';
      btnRevokeToken.classList.add('hidden');
    }
    if (shareInput) shareInput.value = '';
    if (qrImg) qrImg.classList.add('hidden');
    if (qrHint) qrHint.textContent = '請先點擊上方按鈕生成隨機測驗連結，系統將自動產生專屬作答網址與 QR Code';
    return;
  }

  if (isExpired) {
    if (statusBadge) {
      statusBadge.className = 'badge badge-danger';
      statusBadge.textContent = '🔴 測驗連結已逾期失效';
    }
    if (tokenMetaBox) tokenMetaBox.classList.remove('hidden');
    if (tokenTimeRemainingEl) tokenTimeRemainingEl.innerHTML = '<span style="color:var(--danger); font-weight:700;">已逾期（已失效）</span>';
    if (btnGenToken) {
      btnGenToken.innerHTML = `重新生成測驗連結`;
      btnGenToken.className = 'btn btn-token-primary';
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke hidden';
      btnRevokeToken.classList.add('hidden');
    }
  } else {
    const remSec = Math.max(0, Math.floor((tokenObj.expiresAt - now) / 1000));
    const h = Math.floor(remSec / 3600);
    const m = Math.floor((remSec % 3600) / 60);
    const s = remSec % 60;
    const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    if (statusBadge) {
      statusBadge.className = 'badge badge-teal';
      statusBadge.textContent = `🟢 連結已生成 (剩餘 ${h > 0 ? h + ' 小時 ' : ''}${m} 分鐘有效)`;
    }
    if (tokenMetaBox) tokenMetaBox.classList.remove('hidden');
    if (tokenTimeRemainingEl) tokenTimeRemainingEl.textContent = formatted;
    if (btnGenToken) {
      btnGenToken.innerHTML = `重新生成測驗連結`;
      btnGenToken.className = 'btn btn-token-primary';
    }
    if (btnRevokeToken) {
      btnRevokeToken.className = 'btn btn-token-revoke';
      btnRevokeToken.classList.remove('hidden');
    }
  }

  if (tokenCreatedAtEl && tokenObj.createdAt) {
    tokenCreatedAtEl.textContent = formatDateTime(new Date(tokenObj.createdAt));
  }
  if (tokenExpiresAtEl && tokenObj.expiresAt) {
    tokenExpiresAtEl.textContent = formatDateTime(new Date(tokenObj.expiresAt));
  }

  const shareUrl = buildStudentShareUrl();
  if (shareInput) shareInput.value = shareUrl;
  if (qrImg && qrHint) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`;
    qrImg.classList.remove('hidden');
    qrHint.innerHTML = '<span style="color:var(--primary); font-weight:600; cursor:pointer;" onclick="openStandaloneQrPage()">🔍 點選 QR Code 可開啟獨立全螢幕頁面投放大螢幕</span>';
  }
}

function startExamTokenCountdown() {
  if (examTokenCountdownTimer) clearInterval(examTokenCountdownTimer);
  examTokenCountdownTimer = setInterval(() => {
    const tabEl = document.getElementById('tabExamLink');
    if (tabEl && !tabEl.classList.contains('hidden')) {
      updateExamLinkTabUI();
    }
  }, 1000);
}

function showTokenInvalidView(message) {
  currentExamTokenStatus = 'invalid';
  const invalidView = document.getElementById('studentTokenInvalidView');
  const invalidDesc = document.getElementById('studentTokenInvalidDesc');
  const loginView = document.getElementById('studentLoginView');
  const closedView = document.getElementById('studentClosedView');
  const quizView = document.getElementById('studentQuizView');

  if (invalidDesc && message) {
    invalidDesc.innerHTML = message;
  }
  if (invalidView) invalidView.classList.remove('hidden');
  if (loginView) loginView.classList.add('hidden');
  if (closedView) closedView.classList.add('hidden');
  if (quizView) quizView.classList.add('hidden');
}

function hideTokenInvalidView() {
  currentExamTokenStatus = 'valid';
  const invalidView = document.getElementById('studentTokenInvalidView');
  if (invalidView) invalidView.classList.add('hidden');
}

async function validateCurrentExamToken(urlToken) {
  if (!urlToken) {
    showTokenInvalidView('⚠️ 請使用考官提供之專屬測驗連結進入作答！');
    return false;
  }

  const gasUrl = getActiveGasUrl();
  let verifiedOnCloud = false;

  // 1. 優先執行雲端權威校驗 (跨裝置/新設備進入時，直接由 Google 伺服器進行即時防竄改驗證)
  if (gasUrl) {
    try {
      const res = await fetch(`${gasUrl}?action=checkState&token=${encodeURIComponent(urlToken)}&_t=${Date.now()}`);
      const json = await res.json();
      if (json && json.status === 'success') {
        verifiedOnCloud = true;
        if (json.activeExamToken) {
          examData.activeExamToken = json.activeExamToken;
          try {
            const raw = localStorage.getItem(STORAGE_KEYS.EXAM_DATA);
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.activeExamToken = json.activeExamToken;
            parsed.isExamOpen = Boolean(json.isExamOpen);
            localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(parsed));
          } catch (e) { }
        }
        examData.isExamOpen = Boolean(json.isExamOpen);

        if (json.tokenStatus === 'valid') {
          hideTokenInvalidView();
          renderStudentLoginMeta();
          return true;
        } else if (json.tokenStatus === 'invalid') {
          showTokenInvalidView('⚠️ 此測驗連結已失效！考官已重新生成新連結，先前連結已立即作廢。<br>請向考官索取最新測驗連結！');
          return false;
        } else if (json.tokenStatus === 'expired') {
          showTokenInvalidView('⚠️ 此測驗連結已逾期失效（已超過 180 分鐘有效期限）！');
          return false;
        } else if (json.tokenStatus === 'not_generated') {
          showTokenInvalidView('⚠️ 此測驗連結已失效或已遭考官停用！<br>目前無有效之測驗連結，請聯繫考官確認。');
          return false;
        }
      }
    } catch (e) {
      console.warn('雲端校驗 Token 網路失敗，降級使用本機狀態比對:', e);
    }
  }

  // 2. 僅在無雲端網址或離線網路異常時，才降級比對本機狀態
  if (!verifiedOnCloud) {
    const localToken = examData.activeExamToken;
    if (!localToken || !localToken.token) {
      showTokenInvalidView('⚠️ 此測驗連結已失效或已遭考官停用！<br>目前無有效之測驗連結，請聯繫考官確認。');
      return false;
    }
    if (localToken.token !== urlToken) {
      showTokenInvalidView('⚠️ 此測驗連結已失效！考官已重新生成新連結，先前連結已立即作廢。<br>請向考官索取最新測驗連結！');
      return false;
    }
    if (Date.now() > Number(localToken.expiresAt || 0)) {
      showTokenInvalidView('⚠️ 此測驗連結已逾期失效（已超過 180 分鐘有效期限）！');
      return false;
    }
  }

  hideTokenInvalidView();
  renderStudentLoginMeta();
  return true;
}

function copyStudentShareUrl() {
  const shareInput = document.getElementById('studentShareUrlInput');
  if (!shareInput) return;
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 尚未生成測驗連結！請先點擊上方【生成隨機測驗連結】按鈕產生連結。');
    return;
  }
  const url = buildStudentShareUrl();
  shareInput.value = url;
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 已複製考生專屬測驗連結！');
  }).catch(() => {
    shareInput.select();
    document.execCommand('copy');
    showToast('📋 已複製考生專屬測驗連結！');
  });
}

function openStandaloneQrPage() {
  if (!examData.activeExamToken || !examData.activeExamToken.token) {
    alert('⚠️ 尚未生成測驗連結！請先點擊上方按鈕生成。');
    return;
  }
  const shareUrl = buildStudentShareUrl();
  const baseDir = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
  const qrPageUrl = `${baseDir}qr.html?data=${encodeURIComponent(shareUrl)}`;
  window.open(qrPageUrl, '_blank', 'noopener,noreferrer');
}

// ==================== 本機與雲端雙向資料存取 ====================
function normalizeDateForInput(dateVal) {
  if (dateVal === null || dateVal === undefined || dateVal === '') return '';
  const str = String(dateVal).trim();
  if (!str) return '';
  // 若已符合 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // 處理 YYYY/M/D、YYYY-M-D、YYYY.M.D
  const match = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (match) {
    const y = match[1];
    const m = String(match[2]).padStart(2, '0');
    const d = String(match[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // 處理 Excel 日期序列值 (例如 46000)
  if (/^\d{5}$/.test(str)) {
    const serial = parseInt(str, 10);
    const utcDays = serial - 25569;
    const dateObj = new Date(utcDays * 86400 * 1000);
    if (!isNaN(dateObj.getTime())) {
      const y = dateObj.getUTCFullYear();
      const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return '';
}

function loadExamData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EXAM_DATA);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.questions)) {
        return {
          id: parsed.id || 'exam_default',
          title: parsed.title ?? '',
          durationMinutes: parsed.durationMinutes === '' ? '' : (Number(parsed.durationMinutes) || 60),
          examDate: normalizeDateForInput(parsed.examDate ?? ''),
          isExamOpen: Boolean(parsed.isExamOpen),
          openedAt: parsed.openedAt ? Number(parsed.openedAt) : (parsed.isExamOpen ? Date.now() : null),
          activeExamToken: parsed.activeExamToken || null,
          questions: parsed.questions
        };
      }
    }
  } catch (e) {
    console.error('載入題庫失敗:', e);
  }
  localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(DEFAULT_EXAM_DATA));
  return JSON.parse(JSON.stringify(DEFAULT_EXAM_DATA));
}

function saveExamDataToStorage(syncCloud = true) {
  lastExamDataSaveAt = Date.now();
  // 保持 examData 乾淨，不將試卷庫附加於當前測驗設定中
  if (examData && examData.examLibrary) {
    delete examData.examLibrary;
  }
  localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  renderStudentLoginMeta();
  if (isExaminerAuthenticated) {
    renderExamControlBanner();
  }
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'saveExamData',
      examData: examData,
      examLibrary: (typeof examLibrary !== 'undefined' ? examLibrary : [])
    });
  }
}

// ==================== 試卷庫 (Exam Library) 儲存與管理 ====================
function loadExamLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.EXAM_LIBRARY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('載入試卷庫失敗:', e);
  }

  // 首次初始化遷移：以當前 examData 作為試卷庫第一份試卷
  const initialId = (typeof examData !== 'undefined' && examData && examData.id) ? examData.id : ('exam_' + Date.now());
  const initialExam = {
    id: initialId,
    title: (typeof examData !== 'undefined' && examData && examData.title) ? examData.title : '預設試卷',
    examDate: (typeof examData !== 'undefined' && examData && examData.examDate) ? examData.examDate : '',
    durationMinutes: (typeof examData !== 'undefined' && examData && examData.durationMinutes !== '') ? examData.durationMinutes : 60,
    questions: (typeof examData !== 'undefined' && examData && Array.isArray(examData.questions)) ? JSON.parse(JSON.stringify(examData.questions)) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const list = [initialExam];
  localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(list));
  return list;
}

function saveExamLibraryToStorage(syncCloud = true) {
  lastExamLibrarySaveAt = Date.now();
  localStorage.setItem(STORAGE_KEYS.EXAM_LIBRARY, JSON.stringify(examLibrary));

  // 確保 examData 保持純淨，不存放試卷庫
  if (examData && examData.examLibrary) {
    delete examData.examLibrary;
    localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  }

  if (syncCloud && getActiveGasUrl()) {
    // 試卷庫資料專屬寫入雲端「試卷庫資料」工作表
    postToCloud({
      action: 'saveExamLibrary',
      examLibrary: examLibrary
    }).then(res => {
      if (res && res.status === 'success') {
        console.log('試卷庫已成功同步至「試卷庫資料」工作表');
      } else if (res && res.status === 'error' && String(res.message || '').includes('saveExamLibrary')) {
        // 雲端 Apps Script 網址仍在執行舊版程式碼，無法寫入「試卷庫資料」工作表
        if (!window.__examLibraryOldGasWarned) {
          window.__examLibraryOldGasWarned = true;
          alert(
            '⚠️ 試卷庫未能寫入 Google 試算表！\n\n' +
            '原因：目前綁定的 Apps Script 網址仍在執行「舊版」程式碼（不支援 saveExamLibrary）。\n\n' +
            '請至 Apps Script：部署 > 管理部署作業 > 編輯（鉛筆）> 版本選「建立新版本」> 部署。\n' +
            '（請勿使用「新增部署作業」，那會產生新網址，系統仍會連到舊網址）'
          );
        }
      } else if (!res) {
        console.warn('試卷庫同步至雲端失敗（無回應或網路錯誤）');
      }
    }).catch(err => {
      console.error('儲存試卷庫專屬工作表失敗:', err);
    });
  }
}

function getCurrentSelectedExam() {
  let exam = examLibrary.find(e => e.id === currentSelectedExamId);
  if (!exam) {
    exam = examLibrary[0];
    if (exam) currentSelectedExamId = exam.id;
  }
  return exam;
}

function loadSubmissions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SUBMISSIONS);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('載入成績紀錄失敗:', e);
  }
  return [];
}

function saveSubmissionsToStorage(syncCloud = true) {
  localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'syncSubmissions',
      examData: examData,
      submissions: submissions
    });
  }
}

function loadHistorySessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.HISTORY_SESSIONS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('載入歷次測驗紀錄失敗:', e);
  }
  return [];
}

function saveHistorySessionsToStorage(syncCloud = true) {
  localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));
  if (syncCloud && getActiveGasUrl()) {
    postToCloud({
      action: 'syncHistory',
      historySessions: historySessions
    });
  }
}

// 計算每題平均配分 (滿分100)
function getPointsPerQuestion(qCount) {
  if (!qCount || qCount <= 0) return 0;
  return Number((100 / qCount).toFixed(2));
}

// ==================== 角色切換 (考生端 #007979 / 考官端 #750000) ====================
function switchRole(role) {
  if (activeSession.isActive) {
    alert('測驗正在進行中，禁止切換介面！');
    return;
  }

  const btnStudent = document.getElementById('btnRoleStudent');
  const btnExaminer = document.getElementById('btnRoleExaminer');
  const studentSec = document.getElementById('studentSection');
  const examinerSec = document.getElementById('examinerSection');

  if (role === 'student') {
    document.body.classList.remove('examiner-mode');
    if (btnStudent) btnStudent.classList.add('active');
    if (btnExaminer) btnExaminer.classList.remove('active');
    if (studentSec) studentSec.classList.remove('hidden');
    if (examinerSec) examinerSec.classList.add('hidden');
    renderStudentLoginMeta();
  } else {
    document.body.classList.add('examiner-mode');
    if (btnExaminer) btnExaminer.classList.add('active');
    if (btnStudent) btnStudent.classList.remove('active');
    if (studentSec) studentSec.classList.add('hidden');
    if (examinerSec) examinerSec.classList.remove('hidden');

    if (isExaminerAuthenticated) {
      showExaminerDashboard();
    } else {
      const pinView = document.getElementById('examinerPinView');
      const dashView = document.getElementById('examinerDashboardView');
      const pinInput = document.getElementById('examinerPinInput');
      const pinErr = document.getElementById('pinErrorMsg');
      const pinLoading = document.getElementById('pinLoadingBar');
      const pinBtn = document.getElementById('pinSubmitBtn');
      if (pinView) pinView.classList.remove('hidden');
      if (dashView) dashView.classList.add('hidden');
      if (pinInput) {
        pinInput.value = '';
        if (pinLockoutRemaining <= 0) pinInput.disabled = false;
      }
      if (pinErr && !pinErr.classList.contains('alert-warning')) pinErr.classList.add('hidden');
      if (pinLoading) pinLoading.classList.add('hidden');
      if (pinBtn && pinLockoutRemaining <= 0) pinBtn.disabled = false;
      if (pinInput && pinLockoutRemaining <= 0) setTimeout(() => pinInput.focus(), 100);
    }
  }
}

// ==================== 考官端：開始與結束測驗控制 ====================
function renderExamControlBanner() {
  const banner = document.getElementById('examControlBanner');
  const badge = document.getElementById('examOpenStatusBadge');
  const desc = document.getElementById('examOpenStatusDesc');
  const btnStart = document.getElementById('btnStartExamSession');
  const btnStop = document.getElementById('btnStopExamSession');

  if (!banner || !badge || !desc || !btnStart || !btnStop) return;

  if (examData.isExamOpen) {
    banner.classList.add('is-open');
    badge.className = 'exam-status-indicator open';
    badge.textContent = '測驗中';
    desc.textContent = `試卷【${examData.title || '未命名測驗'}】已開放作答！`;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    startExaminerLiveTimer();
  } else {
    banner.classList.remove('is-open');
    badge.className = 'exam-status-indicator closed';
    badge.textContent = '無正在進行中的測驗';
    desc.textContent = '目前試卷為關閉狀態，考生端將不會看到任何內容。';
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    stopExaminerLiveTimer();
  }
}

// 考官端即時正數計時器 (開放作答即開始計時，距結束前5分鐘紅底提醒，超時不停止繼續計時，結束作答才歸零隱藏)
function startExaminerLiveTimer() {
  if (!examData.isExamOpen) {
    stopExaminerLiveTimer();
    return;
  }
  if (!examData.openedAt) {
    examData.openedAt = Date.now();
  }
  updateExaminerLiveTimerDisplay();
  if (!examinerLiveTimerInterval) {
    examinerLiveTimerInterval = setInterval(updateExaminerLiveTimerDisplay, 1000);
  }
}

function stopExaminerLiveTimer() {
  if (examinerLiveTimerInterval) {
    clearInterval(examinerLiveTimerInterval);
    examinerLiveTimerInterval = null;
  }
  const timerEl = document.getElementById('examinerLiveTimer');
  const displayEl = document.getElementById('examinerTimerDisplay');
  const overdueTag = document.getElementById('examinerTimerOverdueBadge');
  if (timerEl) {
    timerEl.classList.add('hidden');
    timerEl.classList.remove('timer-warning');
  }
  if (displayEl) {
    displayEl.textContent = '00:00';
  }
  if (overdueTag) {
    overdueTag.classList.add('hidden');
  }
}

function updateExaminerLiveTimerDisplay() {
  const timerEl = document.getElementById('examinerLiveTimer');
  const displayEl = document.getElementById('examinerTimerDisplay');
  const overdueTag = document.getElementById('examinerTimerOverdueBadge');
  if (!timerEl || !displayEl) return;

  if (!examData.isExamOpen || !examData.openedAt) {
    stopExaminerLiveTimer();
    return;
  }

  timerEl.classList.remove('hidden');

  const now = Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - Number(examData.openedAt)) / 1000));
  const hrs = Math.floor(elapsedSec / 3600);
  const mins = Math.floor((elapsedSec % 3600) / 60);
  const secs = elapsedSec % 60;

  const formatted = hrs > 0
    ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  displayEl.textContent = formatted;

  // 計算警示門檻 (設定作答時間前 5 分鐘)
  const durationMins = Number(examData.durationMinutes) || 60;
  const targetSec = durationMins * 60;
  const warningSec = Math.max(0, targetSec - 5 * 60);

  // 快到達作答時間前 5 分鐘改為紅色底色提醒；超時依然不停止計時 (紅底繼續跑)
  if (elapsedSec >= warningSec) {
    timerEl.classList.add('timer-warning');
  } else {
    timerEl.classList.remove('timer-warning');
  }

  // 超過設定作答時間時顯示「已逾時」標記
  if (overdueTag) {
    if (elapsedSec >= targetSec) {
      overdueTag.classList.remove('hidden');
    } else {
      overdueTag.classList.add('hidden');
    }
  }
}

function setExamOpenStatus(isOpen) {
  if (isOpen) {
    const currentExam = getCurrentSelectedExam();
    const targetExam = currentExam || examData;
    if (!targetExam || !targetExam.questions || targetExam.questions.length === 0) {
      alert('目前試卷中沒有任何題目（0 題），請先匯入考題或手動新增題目後再開始測驗！');
      return;
    }

    const openNow = Date.now();
    // 若當前選中的試卷與目前活動的 examData 不同，確認套用選中的試卷
    if (currentExam && examData.id !== currentExam.id) {
      const confirmSwitch = confirm(`確定要將目前選中的試卷【${currentExam.title}】（共 ${currentExam.questions.length} 題）設為本次測驗試卷並開放作答嗎？`);
      if (!confirmSwitch) return;
      examData = {
        id: currentExam.id,
        title: currentExam.title,
        examDate: currentExam.examDate,
        durationMinutes: currentExam.durationMinutes,
        isExamOpen: true,
        openedAt: openNow,
        questions: JSON.parse(JSON.stringify(currentExam.questions || []))
      };
    } else {
      examData.isExamOpen = true;
      examData.openedAt = openNow;
    }

    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    showToast(`🟢 已開始測驗！試卷【${examData.title || '未命名測驗'}】現已開放作答。`);
  } else {
    // 防誤觸確認視窗：結束作答並收卷確認
    const isConfirmed = confirm('🔔 是否確定要結束作答並收卷？\n\n（結束後試卷將關閉，所有尚未交卷的考生將一律強制交卷）');
    if (!isConfirmed) return;

    examData.isExamOpen = false;
    examData.openedAt = null;
    stopExaminerLiveTimer();
    saveExamDataToStorage(true);
    refreshExaminerAllViews();
    // 當考官將測驗設定為結束作答後，若當前有尚未交卷之考生，一律強制交卷
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
    }
    showToast('🔴 已結束測驗並關閉試卷！');
  }
}

// ==================== 考生端流程 (試卷關閉時顯示「目前非測驗時間」) ====================
function renderStudentLoginMeta() {
  const closedView = document.getElementById('studentClosedView');
  const loginView = document.getElementById('studentLoginView');
  const quizView = document.getElementById('studentQuizView');
  const resultView = document.getElementById('studentResultView');

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();

  // 若非考官且未持有隨機測驗連結，顯示失效提示並阻絕考生畫面
  if (!urlToken && !isExaminerAuthenticated) {
    showTokenInvalidView('⚠️ 請使用考官提供之測驗連結進入作答！');
    return;
  }

  // 若 Token 狀態已判定為無效且非考官，維持顯示失效畫面
  if (currentExamTokenStatus === 'invalid' && !isExaminerAuthenticated) {
    return;
  }

  // 若測驗卷已為關閉狀態
  if (!examData.isExamOpen) {
    // 若考生正在作答中，一律立即強制交卷
    if (activeSession && activeSession.isActive) {
      finalizeExamSubmission('測驗結束強制交卷');
      return;
    }
    const isInResult = resultView && !resultView.classList.contains('hidden');
    if (loginView) loginView.classList.add('hidden');
    if (quizView) quizView.classList.add('hidden');
    if (closedView) {
      closedView.classList.toggle('hidden', isInResult);
    }
    return;
  }

  const isInQuizOrResult =
    activeSession.isActive ||
    (quizView && !quizView.classList.contains('hidden')) ||
    (resultView && !resultView.classList.contains('hidden'));

  // 當測驗卷為開放狀態，隱藏「目前非測驗時間」畫面，並在未作答/結果頁時顯示考生登入畫面
  if (closedView) closedView.classList.add('hidden');
  if (loginView && !isInQuizOrResult) {
    loginView.classList.remove('hidden');
  }

  const qCount = examData.questions.length;
  const pts = getPointsPerQuestion(qCount);

  document.getElementById('studentExamTitle').textContent = examData.title || '未命名測驗';
  document.getElementById('studentExamDate').textContent = examData.examDate || '-';
  document.getElementById('studentExamDuration').textContent = examData.durationMinutes || 60;
  document.getElementById('studentExamQCount').textContent = qCount;
  document.getElementById('studentPointsPerQ').textContent = pts;
}

async function handleStartExam(event) {
  event.preventDefault();

  const nameInput = document.getElementById('studentName').value.trim();
  const idInput = document.getElementById('studentId').value.trim();
  const emailInput = document.getElementById('studentEmail').value.trim();
  const startBtn = document.getElementById('btnStartExam');
  const errorBox = document.getElementById('studentLoginError');

  errorBox.classList.add('hidden');

  if (!nameInput || !emailInput) {
    showLoginError('請完整填寫考生姓名與電子郵件 (Email)！');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
    showLoginError('請輸入格式正確的電子郵件 (Email) 信箱！');
    return;
  }

  // 開考前校驗隨機測驗 Token 時效
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = (urlParams.get('token') || '').trim();
  if (!urlToken) {
    showLoginError('缺少有效隨機測驗憑證，請透過考官提供的測驗連結開啟！');
    return;
  }
  const isTokenValid = await validateCurrentExamToken(urlToken);
  if (!isTokenValid) {
    showLoginError('測驗連結已失效或已逾期，無法開始作答！');
    return;
  }

  // 若已連線雲端，開考前先向雲端拉取最新題庫、開放狀態並驗證 Email 是否已作答
  const gasUrl = getActiveGasUrl();
  if (gasUrl) {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '正在同步載入試卷...';
    }
    await syncStateFromCloud(true);
    let cloudEmailDuplicate = null;
    try {
      const checkRes = await fetch(`${gasUrl}?action=checkEmail&email=${encodeURIComponent(emailInput)}&_t=${Date.now()}`);
      const checkJson = await checkRes.json();
      if (checkJson && checkJson.status === 'success' && checkJson.exists) {
        cloudEmailDuplicate = checkJson;
      }
    } catch (e) { }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = `進入全螢幕並開始作答 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
    }
    if (cloudEmailDuplicate) {
      const timeNote = cloudEmailDuplicate.submittedAt ? ` (${cloudEmailDuplicate.submittedAt})` : '';
      showLoginError(`電子郵件「${emailInput}」已於本場次${timeNote}完成交卷，同一組 Email 限作答一次！`);
      return;
    }
  }

  // 若考官已關閉測驗，立即隱藏考生端畫面並阻擋作答
  if (!examData.isExamOpen) {
    renderStudentLoginMeta();
    return;
  }

  if (examData.questions.length === 0) {
    showLoginError('目前題庫中尚無有效題目，請先通知考官匯入考題！');
    return;
  }

  // 檢查當前場次同一電子郵件 (Email) 是否已作答過 (不區分大小寫)
  const duplicated = submissions.find(
    s => s.studentEmail && String(s.studentEmail).trim().toLowerCase() === emailInput.toLowerCase()
  );
  if (duplicated) {
    showLoginError(`電子郵件「${emailInput}」已於本場次 (${duplicated.submittedAt}) 完成交卷，同一組 Email 限作答一次！`);
    return;
  }

  // 嘗試請求全螢幕以提高防作弊保護
  try {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => { });
    }
  } catch (e) { }

  // 亂數排列試題 (Fisher-Yates Shuffle)
  const shuffled = [...examData.questions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 初始化考試 Session
  activeSession = {
    isActive: true,
    studentName: nameInput,
    studentId: idInput,
    studentEmail: emailInput,
    startTime: Date.now(),
    remainingSeconds: (Number(examData.durationMinutes) || 60) * 60,
    timerInterval: null,
    shuffledQuestions: shuffled,
    answers: {},
    warningCount: 0,
    lastCheatTriggerAt: Date.now() // 給予剛進入全螢幕時的緩衝
  };

  // 切換頂部導覽列為考試監控模式
  const roleSwitcherEl = document.getElementById('roleSwitcher');
  if (roleSwitcherEl) roleSwitcherEl.classList.add('hidden');
  document.getElementById('examLiveBar').classList.remove('hidden');
  document.body.classList.add('exam-mode'); // 手機版作答時精簡頂部列
  document.getElementById('liveStudentDisplay').textContent = idInput ? `${nameInput} (${idInput})` : nameInput;
  document.getElementById('liveWarnCount').textContent = '0';
  document.getElementById('liveWarningBadge').classList.remove('warned');
  document.getElementById('liveTimerBox').classList.remove('timer-urgent');

  // 切換畫面至作答區
  document.getElementById('studentLoginView').classList.add('hidden');
  document.getElementById('studentResultView').classList.add('hidden');
  document.getElementById('studentQuizView').classList.remove('hidden');

  renderQuizQuestions();
  startCountdownTimer();
  startActiveExamStatusChecker();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showLoginError(msg) {
  const errorBox = document.getElementById('studentLoginError');
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function renderQuizQuestions() {
  const container = document.getElementById('questionsContainer');
  const palette = document.getElementById('questionPalette');
  const total = activeSession.shuffledQuestions.length;
  const pts = getPointsPerQuestion(total);

  document.getElementById('totalQCount').textContent = total;
  document.getElementById('quizPointsPerQ').textContent = pts;

  container.innerHTML = '';
  palette.innerHTML = '';

  activeSession.shuffledQuestions.forEach((q, idx) => {
    const displayNum = idx + 1;

    // 建立題目卡片
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = `q-card-${q.id}`;

    const optionsHtml = q.options
      .map(opt => {
        return `
          <label class="option-item" id="opt-label-${q.id}-${opt.key}" onclick="selectAnswer(${q.id}, '${opt.key}')">
            <input type="radio" class="option-radio" name="q_${q.id}" value="${opt.key}">
            <span class="option-key">${opt.key}</span>
            <span class="option-label-text">${escapeHtml(opt.text)}</span>
          </label>
        `;
      })
      .join('');

    const displayImgUrl = formatGoogleDriveImageUrl(q.imageUrl);
    const imgHtml = displayImgUrl
      ? `
        <div class="question-image-wrap">
          <img src="${escapeHtml(displayImgUrl)}" alt="第 ${displayNum} 題圖檔" class="question-image-thumb" ${getImageOnErrorAttr(displayImgUrl)} onclick="openImageLightbox('${escapeHtml(displayImgUrl)}', '第 ${displayNum} 題附圖')">
          <div class="question-image-hint">🔍 點擊圖片可放大檢視</div>
        </div>
      `
      : '';

    card.innerHTML = `
      <div class="q-header">
        <span class="q-badge">第 ${displayNum} 題</span>
        <div class="q-text">${escapeHtml(q.question)}</div>
      </div>
      ${imgHtml}
      <div class="options-grid">
        ${optionsHtml}
      </div>
    `;
    container.appendChild(card);

    // 建立右側題號導覽按鈕
    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'palette-btn';
    pBtn.id = `palette-btn-${q.id}`;
    pBtn.textContent = displayNum;
    pBtn.onclick = () => {
      document.getElementById(`q-card-${q.id}`).scrollIntoView({ behavior: 'smooth' });
    };
    palette.appendChild(pBtn);
  });

  updateQuizProgress();
}

function selectAnswer(questionId, optionKey) {
  if (!activeSession.isActive) return;

  activeSession.answers[questionId] = optionKey;

  // 更新該題選項樣式
  const qObj = activeSession.shuffledQuestions.find(q => q.id === questionId);
  if (qObj) {
    qObj.options.forEach(opt => {
      const labelEl = document.getElementById(`opt-label-${questionId}-${opt.key}`);
      if (labelEl) {
        const radio = labelEl.querySelector('input[type="radio"]');
        if (opt.key === optionKey) {
          labelEl.classList.add('selected');
          if (radio) radio.checked = true;
        } else {
          labelEl.classList.remove('selected');
          if (radio) radio.checked = false;
        }
      }
    });
  }

  // 更新卡片與導覽列狀態
  const cardEl = document.getElementById(`q-card-${questionId}`);
  if (cardEl) cardEl.classList.add('answered');

  const pBtn = document.getElementById(`palette-btn-${questionId}`);
  if (pBtn) pBtn.classList.add('answered');

  updateQuizProgress();
}

function updateQuizProgress() {
  const total = activeSession.shuffledQuestions.length;
  const answered = Object.keys(activeSession.answers).length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

  document.getElementById('answeredCount').textContent = answered;
  document.getElementById('quizProgressBar').style.width = `${pct}%`;
}

// ==================== 倒數計時器 ====================
function startCountdownTimer() {
  if (activeSession.timerInterval) {
    clearInterval(activeSession.timerInterval);
  }

  updateTimerDisplay();

  activeSession.timerInterval = setInterval(() => {
    if (!activeSession.isActive) {
      clearInterval(activeSession.timerInterval);
      return;
    }

    activeSession.remainingSeconds--;
    updateTimerDisplay();

    // 剩餘不到 5 分鐘時變紅字提醒
    if (activeSession.remainingSeconds <= 300) {
      document.getElementById('liveTimerBox').classList.add('timer-urgent');
    }

    if (activeSession.remainingSeconds <= 0) {
      clearInterval(activeSession.timerInterval);
      finalizeExamSubmission('時間到自動交卷');
    }
  }, 1000);
}

function updateTimerDisplay() {
  const sec = Math.max(0, activeSession.remainingSeconds);
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  document.getElementById('timerDisplay').textContent = formatted;
}

// ==================== 作答進行中測驗狀態即時監控 (考官結束測驗時強制交卷) ====================
function startActiveExamStatusChecker() {
  if (activeExamStatusTimer) {
    clearInterval(activeExamStatusTimer);
    activeExamStatusTimer = null;
  }

  // 立即檢查一次本機狀態
  if (!examData.isExamOpen && activeSession.isActive) {
    finalizeExamSubmission('測驗結束強制交卷');
    return;
  }

  activeExamStatusTimer = setInterval(async () => {
    if (!activeSession.isActive) {
      clearInterval(activeExamStatusTimer);
      activeExamStatusTimer = null;
      return;
    }

    // 1. 本機狀態檢查 (例如同一視窗或同瀏覽器考官關閉了試卷)
    if (!examData.isExamOpen) {
      clearInterval(activeExamStatusTimer);
      activeExamStatusTimer = null;
      finalizeExamSubmission('測驗結束強制交卷');
      return;
    }

    // 2. 雲端狀態輕量化快速檢查 (每 6 秒非同步查詢雲端 isExamOpen)
    const gasUrl = getActiveGasUrl();
    if (!gasUrl || isCheckingExamStatus) return;

    isCheckingExamStatus = true;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlToken = (urlParams.get('token') || '').trim();
      const tokenParam = urlToken ? `&token=${encodeURIComponent(urlToken)}` : '';
      const res = await fetch(`${gasUrl}?action=checkState${tokenParam}&_t=${Date.now()}`);
      const json = await res.json();
      if (json && json.status === 'success') {
        if (json.isExamOpen === false || json.tokenStatus === 'invalid' || json.tokenStatus === 'expired' || json.tokenStatus === 'not_generated') {
          clearInterval(activeExamStatusTimer);
          activeExamStatusTimer = null;
          examData.isExamOpen = false;
          try {
            const raw = localStorage.getItem(STORAGE_KEYS.EXAM_DATA);
            if (raw) {
              const parsed = JSON.parse(raw);
              parsed.isExamOpen = false;
              localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(parsed));
            }
          } catch (e) { }
          if (activeSession.isActive) {
            finalizeExamSubmission('測驗結束強制交卷');
          }
        }
      }
    } catch (err) {
      console.warn('輪詢雲端測驗開放狀態失敗:', err);
    } finally {
      isCheckingExamStatus = false;
    }
  }, 6000);
}

// ==================== 防作弊監控機制 ====================
function setupAntiCheatListeners() {
  // 1. 偵測分頁切換或最小化 (visibilitychange)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeSession.isActive) {
      handleAntiCheatViolation('切換瀏覽器分頁或最小化視窗');
    }
  });

  // 2. 偵測視窗失去焦點 (window blur，例如點選其他應用程式或快捷鍵切出)
  window.addEventListener('blur', () => {
    if (activeSession.isActive) {
      handleAntiCheatViolation('離開作答視窗焦點');
    }
  });

  // 3. 禁止作答期間按右鍵選單與複製題目
  document.addEventListener('contextmenu', e => {
    if (activeSession.isActive) {
      e.preventDefault();
    }
  });

  document.addEventListener('copy', e => {
    if (activeSession.isActive) {
      e.preventDefault();
    }
  });
}

function handleAntiCheatViolation(reason) {
  if (!activeSession.isActive) return;

  // 避免同一次切換同時觸發 visibilitychange 與 blur 造成重複計次 (設定 1.2 秒防抖)
  const now = Date.now();
  if (now - activeSession.lastCheatTriggerAt < 1200) {
    return;
  }
  activeSession.lastCheatTriggerAt = now;

  activeSession.warningCount += 1;

  // 更新頂部警告徽章
  document.getElementById('liveWarnCount').textContent = activeSession.warningCount;
  document.getElementById('liveWarningBadge').classList.add('warned');

  if (activeSession.warningCount < 3) {
    // 第 1、2 次離開：跳出嚴重警告 Modal
    const titleEl = document.getElementById('antiCheatModalTitle');
    const ruleEl = document.getElementById('antiCheatModalRuleText');
    if (titleEl) {
      titleEl.textContent = `防作弊系統警告 (第 ${activeSession.warningCount} / 3 次)`;
    }
    if (ruleEl) {
      ruleEl.innerHTML = `請注意：這是您的<strong>第 ${activeSession.warningCount} 次警告</strong>。<br>若離開作答畫面累計達 <strong>3 次</strong>，系統將<strong>立即強制終止您的測驗並自動交卷</strong>！`;
    }
    document.getElementById('antiCheatModal').classList.remove('hidden');
  } else if (activeSession.warningCount >= 3) {
    // 第 3 次離開：立即關閉所有 Modal 並強制終止測驗
    document.getElementById('antiCheatModal').classList.add('hidden');
    document.getElementById('submitConfirmModal').classList.add('hidden');
    finalizeExamSubmission('防作弊強制終止 (離開畫面達3次)');
  }
}

function acknowledgeCheatWarning() {
  activeSession.lastCheatTriggerAt = Date.now();
  document.getElementById('antiCheatModal').classList.add('hidden');
}

// ==================== 交卷與計分處理 ====================
function requestSubmitExam() {
  if (!activeSession.isActive) return;

  const total = activeSession.shuffledQuestions.length;
  const answered = Object.keys(activeSession.answers).length;
  const unanswered = total - answered;

  const confirmText = document.getElementById('submitConfirmText');
  if (unanswered > 0) {
    confirmText.innerHTML = `您目前已完成 <strong>${answered} / ${total}</strong> 題，尚有 <strong style="color: var(--danger);">${unanswered} 題未作答</strong>！<br>確定要現在交卷嗎？`;
  } else {
    confirmText.innerHTML = `您已全數完成 <strong>${total} / ${total}</strong> 題作答。<br>交卷後無法再修改答案，確定提交嗎？`;
  }

  document.getElementById('submitConfirmModal').classList.remove('hidden');
}

function closeSubmitModal() {
  document.getElementById('submitConfirmModal').classList.add('hidden');
}

async function finalizeExamSubmission(statusReason) {
  if (!activeSession.isActive) return;
  activeSession.isActive = false;

  if (activeSession.timerInterval) {
    clearInterval(activeSession.timerInterval);
    activeSession.timerInterval = null;
  }
  if (activeExamStatusTimer) {
    clearInterval(activeExamStatusTimer);
    activeExamStatusTimer = null;
  }

  if (statusReason.includes('考官結束') || statusReason.includes('結束作答')) {
    showToast('⚠️ 考官已結束本次測驗，系統已強制為您提交目前試卷！');
  }

  document.getElementById('submitConfirmModal').classList.add('hidden');
  document.getElementById('antiCheatModal').classList.add('hidden');

  // 退回一般視窗模式
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
  } catch (e) { }

  // 計算成績 (支援本機離線與伺服器雙重校驗)
  const totalQ = examData.questions.length;
  let correctCount = 0;
  const answerDetails = {};

  examData.questions.forEach(q => {
    const selected = activeSession.answers[q.id] || '';
    const hasAnswer = Boolean(q.answer);
    const isCorrect = hasAnswer ? (selected.toUpperCase() === String(q.answer).toUpperCase()) : false;
    if (isCorrect) correctCount++;
    answerDetails[q.id] = {
      selected: selected || '未作答',
      correctAnswer: q.answer || '',
      isCorrect: hasAnswer ? isCorrect : false
    };
  });

  const rawScore = totalQ > 0 ? (correctCount / totalQ) * 100 : 0;
  const finalScore = Number(rawScore.toFixed(1));

  const timeSpentSeconds = Math.max(
    1,
    Math.round((Date.now() - activeSession.startTime) / 1000)
  );
  const formattedTimeSpent = formatDuration(timeSpentSeconds);
  const submittedAt = formatDateTime(new Date());

  const record = {
    id: (window.crypto && crypto.randomUUID) ? ('SUB_' + crypto.randomUUID().substring(0, 12)) : ('SUB_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
    examTitle: examData.title,
    examDate: examData.examDate,
    studentName: activeSession.studentName,
    studentId: activeSession.studentId,
    studentEmail: activeSession.studentEmail,
    score: finalScore,
    correctCount,
    totalQuestions: totalQ,
    answeredCount: Object.keys(activeSession.answers).length,
    warningCount: activeSession.warningCount,
    status: statusReason,
    timeSpentSeconds,
    timeSpentFormatted: formattedTimeSpent,
    submittedAt,
    emailSentAt: '',
    answers: Object.assign({}, activeSession.answers),
    answerDetails
  };

  submissions.unshift(record);
  localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));

  // 恢復頂部導覽列
  document.getElementById('examLiveBar').classList.add('hidden');
  const roleSwitcherEl = document.getElementById('roleSwitcher');
  if (roleSwitcherEl) roleSwitcherEl.classList.remove('hidden');
  document.body.classList.remove('exam-mode');

  // 顯示交卷完成憑證畫面 (不顯示分數與標準答案)
  document.getElementById('studentQuizView').classList.add('hidden');
  document.getElementById('studentResultView').classList.remove('hidden');

  const iconWrap = document.getElementById('resultIconWrap');
  const titleEl = document.getElementById('resultTitle');
  const subEl = document.getElementById('resultSubtitle');

  if (statusReason.includes('強制終止')) {
    iconWrap.classList.add('forced');
    titleEl.textContent = '測驗已遭系統強制終止並自動交卷';
    subEl.textContent = '因系統偵測到您離開作答畫面達 3 次，已依防作弊規定立即終止測驗並鎖定目前已填寫之答案。考試結束後將寄送成績單至您的信箱。';
  } else if (statusReason.includes('考官結束') || statusReason.includes('結束作答')) {
    iconWrap.classList.add('forced');
    titleEl.textContent = '考官已結束本次測驗並強制交卷';
    subEl.textContent = '考官已結束本次測驗作答權限，系統已為您強制提交目前已作答之答案。考試成績將由考官另行寄送通知至您的電子信箱。';
  } else {
    iconWrap.classList.remove('forced');
    titleEl.textContent = '已完成測驗交卷';
    subEl.textContent = '您的作答紀錄已成功儲存。為維護考試公平性，現場不公佈分數與標準答案，考官將於考試結束後寄送成績單至您的電子信箱。';
  }

  document.getElementById('receiptExamTitle').textContent = record.examTitle;
  document.getElementById('receiptName').textContent = record.studentName;
  document.getElementById('receiptStudentId').textContent = record.studentId || '-';
  document.getElementById('receiptEmail').textContent = record.studentEmail || '-';
  document.getElementById('receiptAnswered').textContent = `${record.answeredCount} / ${record.totalQuestions} 題`;
  document.getElementById('receiptTimeSpent').textContent = record.timeSpentFormatted;
  document.getElementById('receiptStatus').textContent = record.status;
  document.getElementById('receiptTimestamp').textContent = record.submittedAt;

  const cloudStatusEl = document.getElementById('receiptCloudStatus');
  if (getActiveGasUrl()) {
    cloudStatusEl.textContent = '🔄 正在同步上傳...';
    const cloudRes = await postToCloud({
      action: 'submitExam',
      record: record
    });
    if (cloudRes && (cloudRes.status === 'success' || cloudRes.status === 'duplicate')) {
      cloudStatusEl.innerHTML = '<span style="color:var(--primary);">✅ 已成功上傳</span>';
      // 若後端完成客觀權威評分，同步更新本機端分數與作答明細
      if (cloudRes.record) {
        record.score = cloudRes.record.score;
        record.correctCount = cloudRes.record.correctCount;
        record.totalQuestions = cloudRes.record.totalQuestions;
        record.answerDetails = cloudRes.record.answerDetails;
        localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
      }
    } else {
      cloudStatusEl.innerHTML = '<span style="color:var(--accent-dark);">⚠️ 已儲存於本機 (雲端連線逾時)</span>';
    }
  } else {
    cloudStatusEl.textContent = '已儲存於本機瀏覽器';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetToStudentHome() {
  document.getElementById('studentStartForm').reset();
  document.getElementById('studentLoginError').classList.add('hidden');
  document.getElementById('studentResultView').classList.add('hidden');
  renderStudentLoginMeta();
}

// ==================== 考官端驗證與管理後台 ====================
// 純 JavaScript SHA-256 備援實作 (確保在任何環境、協定或舊版瀏覽器皆可穩定計算雜湊)
function sha256Fallback(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i, j;
  let result = '';

  const words = [];
  const asciiBitLength = ascii[lengthProperty] * 8;

  let hash = [];
  const k = [];
  let primeCounter = 0;

  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  hash = hash.slice(0, 8);

  ascii += '\x80';
  while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
  words[words[lengthProperty]] = (asciiBitLength) | 0;

  for (j = 0; j < words[lengthProperty];) {
    const w = words.slice(j, j += 16);
    const oldHash = hash;
    hash = hash.slice(0, 8);

    for (i = 0; i < 64; i++) {
      const i2 = i + j;
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ ((~e) & hash[6]))
        + k[i]
        + (w[i] = (i < 16) ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0
        );
      const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }

    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

async function hashWithSalt(salt, value) {
  const salted = `${salt}:${value}`;
  if (window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const enc = new TextEncoder();
      const data = enc.encode(salted);
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('crypto.subtle 失敗，切換至純 JS 雜湊', e);
    }
  }
  return sha256Fallback(salted);
}

async function hashExaminerPin(pin) {
  return hashWithSalt(EXAMINER_PIN_SALT, pin);
}

async function hashAdminKey(key) {
  return hashWithSalt(ADMIN_KEY_SALT, key);
}

function getStoredExaminerPinHash() {
  const customHash = localStorage.getItem(STORAGE_KEYS.EXAMINER_PIN_HASH);
  if (customHash && (
    customHash === 'f019306584afed3d66239ede39a4ff22f3157215af1df5a891e79c725620ade4' ||
    customHash === 'f77548413d6d3ced941815c06f4499b328e47f9893e15b6c2d4d3c8838efa166'
  )) {
    localStorage.removeItem(STORAGE_KEYS.EXAMINER_PIN_HASH);
    return DEFAULT_EXAMINER_PIN_HASH;
  }
  if (customHash && customHash.trim()) {
    return customHash.trim().toLowerCase();
  }
  return DEFAULT_EXAMINER_PIN_HASH;
}

async function handlePinLogin(event) {
  event.preventDefault();
  if (isPinLoggingIn) return;

  const pinInputEl = document.getElementById('examinerPinInput');
  const pinInput = pinInputEl.value.trim();
  const errBox = document.getElementById('pinErrorMsg');
  const loadingBar = document.getElementById('pinLoadingBar');
  const pinBtn = document.getElementById('pinSubmitBtn') || document.querySelector('#pinForm button[type="submit"]');

  if (pinLockoutRemaining > 0) {
    errBox.textContent = `⚠️ 連續錯誤次數過多，目前系統鎖定中！請等待 ${pinLockoutRemaining} 秒後再試。`;
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    return;
  }

  if (!pinInput) {
    errBox.textContent = '⚠️ 請輸入考官登入 PIN 碼！';
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    pinInputEl.focus();
    return;
  }

  if (!/^\d{4,12}$/.test(pinInput)) {
    errBox.textContent = '❌ PIN 碼格式不符（僅能為 4 至 12 碼半形數字）！';
    errBox.className = 'alert alert-danger';
    errBox.classList.remove('hidden');
    pinInputEl.select();
    return;
  }

  isPinLoggingIn = true;
  let isPinValid = false;
  errBox.classList.add('hidden');
  if (loadingBar) loadingBar.classList.remove('hidden');
  if (pinBtn) pinBtn.disabled = true;
  if (pinInputEl) pinInputEl.disabled = true;

  try {
    const inputHash = await hashExaminerPin(pinInput);
    const targetHash = getStoredExaminerPinHash();

    isPinValid = (inputHash === targetHash);
    let cloudLockedMsg = '';

    // 若已連線雲端，優先向雲端驗證 PIN 雜湊（支援跨裝置變更 PIN 同步與雲端防暴力破解鎖定）
    if (getActiveGasUrl()) {
      const verifyRes = await postToCloud({
        action: 'verifyExaminer',
        authPinHash: inputHash
      });
      if (verifyRes && verifyRes.status === 'success') {
        isPinValid = true;
        localStorage.setItem(STORAGE_KEYS.EXAMINER_PIN_HASH, inputHash);
      } else if (verifyRes && verifyRes.status === 'locked') {
        isPinValid = false;
        cloudLockedMsg = verifyRes.message || '❌ PIN 碼錯誤次數過多，雲端已暫時鎖定 5 分鐘！';
      } else if (verifyRes && verifyRes.status === 'unauthorized') {
        isPinValid = false;
      }
    }

    if (isPinValid) {
      pinFailedAttempts = 0;
      isExaminerAuthenticated = true;
      currentExaminerAuthToken = inputHash;
      lastExaminerActivityTime = Date.now();
      lastExaminerActivityRecordAt = Date.now();
      errBox.classList.add('hidden');
      if (getActiveGasUrl()) {
        await syncStateFromCloud(true, true);
      }
      showExaminerDashboard();
    } else {
      pinFailedAttempts++;
      if (cloudLockedMsg) {
        startPinLockout(30);
        errBox.textContent = cloudLockedMsg;
      } else if (pinFailedAttempts >= 5) {
        startPinLockout(30);
        errBox.textContent = '❌ PIN 碼已連續錯誤 5 次，系統已暫時鎖定 30 秒！';
      } else {
        errBox.textContent = `❌ PIN 碼錯誤，請重新確認！（剩餘 ${5 - pinFailedAttempts} 次嘗試機會）`;
      }
      errBox.className = 'alert alert-danger';
      errBox.classList.remove('hidden');
    }
  } finally {
    isPinLoggingIn = false;
    if (loadingBar) loadingBar.classList.add('hidden');
    if (pinLockoutRemaining <= 0) {
      if (pinBtn) pinBtn.disabled = false;
      if (pinInputEl) {
        pinInputEl.disabled = false;
        if (!isPinValid) {
          pinInputEl.focus();
          pinInputEl.select();
        }
      }
    }
  }
}

function startPinLockout(seconds) {
  pinLockoutRemaining = seconds;
  const pinBtn = document.querySelector('#pinForm button[type="submit"]');
  const pinInputEl = document.getElementById('examinerPinInput');
  const errBox = document.getElementById('pinErrorMsg');

  if (pinBtn) pinBtn.disabled = true;
  if (pinInputEl) pinInputEl.disabled = true;

  if (pinLockoutTimer) clearInterval(pinLockoutTimer);
  pinLockoutTimer = setInterval(() => {
    pinLockoutRemaining--;
    if (pinLockoutRemaining <= 0) {
      clearInterval(pinLockoutTimer);
      pinLockoutTimer = null;
      pinLockoutRemaining = 0;
      pinFailedAttempts = 0;
      if (pinBtn) pinBtn.disabled = false;
      if (pinInputEl) {
        pinInputEl.disabled = false;
        pinInputEl.focus();
      }
      if (errBox) {
        errBox.textContent = '鎖定已解除，請重新輸入 PIN 碼。';
        errBox.className = 'alert alert-info';
      }
    } else {
      if (errBox) {
        errBox.textContent = `❌ 連續錯誤達 5 次，系統鎖定中... 請等待 ${pinLockoutRemaining} 秒後再試！`;
      }
    }
  }, 1000);
}

// ==================== 考官端閒置自動登出機制 (桌面與行動裝置全面適用) ====================
const EXAMINER_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 閒置超過 30 分鐘 (1,800,000 毫秒) 自動登出
let lastExaminerActivityTime = Date.now();
let lastExaminerActivityRecordAt = 0;
let examinerIdleCheckTimer = null;

function recordExaminerActivity() {
  if (!isExaminerAuthenticated) return;
  const now = Date.now();
  // 節流保護：每 2 秒最多記錄一次，避免高頻 touchmove/mousemove 消耗行動裝置 CPU 與電力
  if (now - lastExaminerActivityRecordAt > 2000) {
    lastExaminerActivityRecordAt = now;
    lastExaminerActivityTime = now;
  }
}

function checkExaminerIdleTimeout() {
  if (!isExaminerAuthenticated) return;
  const now = Date.now();
  if (now < lastExaminerActivityTime) {
    // 預防裝置系統時間異常回調
    lastExaminerActivityTime = now;
    return;
  }
  const elapsed = now - lastExaminerActivityTime;
  if (elapsed >= EXAMINER_IDLE_TIMEOUT_MS) {
    console.warn(`[考官端安全防護] 系統已閒置超過 30 分鐘 (累計 ${Math.round(elapsed / 1000)} 秒未動作)，執行自動安全登出。`);
    logoutExaminer('idle');
  }
}

function setupExaminerIdleDetector() {
  // 監聽桌面與行動裝置的使用者互動事件
  // 使用 passive: true 確保觸控滾動與畫面滑動維持最高流暢度
  const activityEvents = [
    'mousedown', 'mousemove', 'keydown', 'wheel', 'click', 'input', 'change',
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointerup',
    'scroll', 'dragover', 'drop'
  ];

  activityEvents.forEach(evt => {
    window.addEventListener(evt, recordExaminerActivity, { passive: true });
  });

  // 定期檢查閒置時間 (每 15 秒檢查一次)
  if (examinerIdleCheckTimer) clearInterval(examinerIdleCheckTimer);
  examinerIdleCheckTimer = setInterval(checkExaminerIdleTimeout, 15000);

  // 行動裝置喚醒、螢幕解鎖、切換應用程式或瀏覽器分頁切回時立即檢查
  window.addEventListener('focus', checkExaminerIdleTimeout);
  window.addEventListener('pageshow', checkExaminerIdleTimeout);
}

function logoutExaminer(reason) {
  const isIdle = (reason === 'idle');
  isExaminerAuthenticated = false;
  currentExaminerAuthToken = '';
  isGasUrlUnlockedBySecret = false;
  gasSecretClickCount = 0;
  stopExaminerLiveTimer();
  updateCloudStatusUI();

  // 關閉考官端可能開啟中的浮動視窗 (Modal)
  const examinerModals = ['studentDetailModal', 'addQuestionModal', 'archiveSessionModal', 'imageLightboxModal'];
  examinerModals.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const dashView = document.getElementById('examinerDashboardView');
  const pinView = document.getElementById('examinerPinView');
  const pinInput = document.getElementById('examinerPinInput');
  const pinLoading = document.getElementById('pinLoadingBar');
  const pinErr = document.getElementById('pinErrorMsg');

  if (dashView) dashView.classList.add('hidden');
  if (pinView) pinView.classList.remove('hidden');
  if (pinInput) pinInput.value = '';
  if (pinLoading) pinLoading.classList.add('hidden');

  if (isIdle) {
    showToast('⚠️ 閒置已超過 30 分鐘，系統已自動安全登出。');
    if (pinErr) {
      pinErr.textContent = '⚠️ 因閒置超過 30 分鐘未動作，系統已自動安全登出。請重新輸入 PIN 碼登入。';
      pinErr.className = 'alert alert-warning';
      pinErr.classList.remove('hidden');
    }
  } else {
    if (pinErr) {
      pinErr.classList.add('hidden');
    }
  }
}

async function handleUpdateExaminerPin(event) {
  if (event) event.preventDefault();
  const adminKeyEl = document.getElementById('adminSecretKeyInput');
  const newPinEl = document.getElementById('newExaminerPinInput');
  const confirmPinEl = document.getElementById('confirmExaminerPinInput');
  const alertBox = document.getElementById('updatePinAlertBox');

  const adminKey = (adminKeyEl ? adminKeyEl.value : '').trim();
  const newPin = (newPinEl ? newPinEl.value : '').trim();
  const confirmPin = (confirmPinEl ? confirmPinEl.value : '').trim();

  function showPinAlert(msg, type) {
    if (!alertBox) {
      if (type === 'danger') alert(msg);
      else showToast(msg);
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
    alertBox.classList.remove('hidden');
  }

  if (!adminKey) {
    showPinAlert('⚠️ 請輸入管理員金鑰以取得變更權限！', 'danger');
    if (adminKeyEl) adminKeyEl.focus();
    return;
  }

  // 1. 驗證管理員金鑰 (採用 Salt + SHA-256 雜湊對比)
  const inputAdminHash = await hashAdminKey(adminKey);
  if (inputAdminHash !== ADMIN_KEY_HASH) {
    showPinAlert('❌ 管理員金鑰驗證失敗！無法變更考官 PIN 碼。', 'danger');
    if (adminKeyEl) adminKeyEl.select();
    return;
  }

  // 2. 驗證新 PIN 碼格式 (僅限半形數字，至少4碼，至多12碼)
  if (!newPin) {
    showPinAlert('⚠️ 請輸入新考官 PIN 碼！', 'danger');
    if (newPinEl) newPinEl.focus();
    return;
  }
  if (!/^\d+$/.test(newPin)) {
    showPinAlert('⚠️ 考官 PIN 碼僅能使用半形數字 (0~9)，不得包含英文字母、空格或符號！', 'danger');
    if (newPinEl) newPinEl.focus();
    return;
  }
  if (newPin.length < 4 || newPin.length > 12) {
    showPinAlert('⚠️ 考官 PIN 碼長度須介於 4 至 12 碼之間！', 'danger');
    if (newPinEl) newPinEl.focus();
    return;
  }
  if (newPin !== confirmPin) {
    showPinAlert('⚠️ 兩次輸入的新 PIN 碼不一致，請重新確認！', 'danger');
    if (confirmPinEl) confirmPinEl.focus();
    return;
  }

  // 3. 計算新 PIN 碼的 Salt + SHA-256 雜湊並保存至本機安全性儲存
  const newPinHash = await hashExaminerPin(newPin);
  localStorage.setItem(STORAGE_KEYS.EXAMINER_PIN_HASH, newPinHash);
  currentExaminerAuthToken = newPinHash;

  // 清空輸入框
  if (adminKeyEl) adminKeyEl.value = '';
  if (newPinEl) newPinEl.value = '';
  if (confirmPinEl) confirmPinEl.value = '';

  // 同步新 PIN 雜湊至雲端後端，確保雲端立即同步認證
  if (getActiveGasUrl()) {
    postToCloud({
      action: 'updateExaminerPin',
      adminKey: adminKey,
      newPinHash: newPinHash
    });
  }

  showPinAlert('✅ 考官登入 PIN 碼已成功更新！日後登入請使用新設定的 PIN 碼。', 'success');
  showToast('✅ 考官 PIN 碼已成功變更！');
}

async function handleResetExaminerPin() {
  const adminKey = prompt('請輸入管理員金鑰以恢復預設 PIN 碼：');
  if (adminKey === null) return;
  const trimmedKey = adminKey.trim();
  if (!trimmedKey) {
    alert('⚠️ 必須輸入管理員金鑰！');
    return;
  }

  const inputAdminHash = await hashAdminKey(trimmedKey);
  if (inputAdminHash !== ADMIN_KEY_HASH) {
    alert('❌ 管理員金鑰驗證失敗！無法恢復預設 PIN 碼。');
    return;
  }

  localStorage.removeItem(STORAGE_KEYS.EXAMINER_PIN_HASH);
  currentExaminerAuthToken = DEFAULT_EXAMINER_PIN_HASH;

  if (getActiveGasUrl()) {
    postToCloud({
      action: 'updateExaminerPin',
      adminKey: trimmedKey,
      newPinHash: DEFAULT_EXAMINER_PIN_HASH
    });
  }

  const alertBox = document.getElementById('updatePinAlertBox');
  if (alertBox) {
    alertBox.textContent = '🔄 考官 PIN 碼已成功恢復為系統初始預設值 (9999)！';
    alertBox.className = 'alert alert-info';
    alertBox.classList.remove('hidden');
  }
  showToast('🔄 已成功恢復預設考官 PIN 碼 (9999)！');
}

function showExaminerDashboard() {
  document.getElementById('examinerPinView').classList.add('hidden');
  document.getElementById('examinerDashboardView').classList.remove('hidden');
  refreshExaminerAllViews(true);
}

function switchExaminerTab(tabId) {
  currentActiveExaminerTab = tabId;
  document.querySelectorAll('.dashboard-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  ['tabQuestions', 'tabScores', 'tabAnalytics', 'tabHistory', 'tabExamLink', 'tabSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== tabId);
  });

  refreshExaminerAllViews();
}

function refreshExaminerAllViews(forceAll = false) {
  renderExamControlBanner();
  updateCloudStatusUI();

  // 更新頁籤計數徽章
  const scoreBadge = document.getElementById('tabScoreCount');
  if (scoreBadge) scoreBadge.textContent = submissions.length;
  const histBadge = document.getElementById('tabHistoryCount');
  if (histBadge) histBadge.textContent = historySessions.length;

  // 效能優化：僅渲染目前活動的分頁，避免每次輪詢全量重建所有 DOM
  if (forceAll || currentActiveExaminerTab === 'tabQuestions') {
    renderExaminerQuestionTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabScores') {
    renderExaminerScoresTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabAnalytics') {
    renderExaminerAnalyticsTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabHistory') {
    renderExaminerHistoryTab();
  }
  if (forceAll || currentActiveExaminerTab === 'tabExamLink') {
    updateExamLinkTabUI();
  }
}

// ==================== 考官端頁籤 1：試卷庫與考題管理 (支援多份試卷獨立保存) ====================
function handleSelectExamFromLibrary(examId) {
  if (!examId) return;
  currentSelectedExamId = examId;
  refreshExaminerAllViews();
  const exam = getCurrentSelectedExam();
  if (exam) {
    showToast(`📖 已載入試卷【${exam.title || '未命名試卷'}】（共 ${(exam.questions || []).length} 題）`);
  }
}

function handleCreateNewExamPaper() {
  const defaultTitle = `新試卷 ${examLibrary.length + 1}`;
  const inputTitle = prompt('請輸入新試卷名稱：', defaultTitle);
  if (inputTitle === null) return;
  const title = inputTitle.trim() || defaultTitle;

  const isDup = examLibrary.some(e => e.title.trim().toLowerCase() === title.toLowerCase());
  if (isDup) {
    alert(`試卷庫中已存在同名試卷「${title}」，請使用其他名稱！`);
    return;
  }

  const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
  const newExam = {
    id: 'exam_' + Date.now(),
    title: title,
    examDate: todayStr,
    durationMinutes: 60,
    questions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  examLibrary.push(newExam);
  currentSelectedExamId = newExam.id;
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`➕ 已建立新試卷「${title}」！您可直接開始新增考題或自左側匯入 Excel。`);
}

function isExamLockedForEditing(exam) {
  const target = exam || getCurrentSelectedExam();
  return Boolean(target && examData && examData.isExamOpen && examData.id === target.id);
}

function guardActiveExamEditing(exam, actionLabel = '異動此試卷') {
  if (!isExamLockedForEditing(exam)) return false;
  const target = exam || getCurrentSelectedExam();
  const title = (target && target.title) ? target.title : (examData.title || '當前試卷');
  alert(`⛔ 試卷「${title}」正在測驗進行中！\n\n測驗進行中的試卷禁止${actionLabel}。\n請先於上方控制列點擊「結束作答」後再進行修改。`);
  return true;
}

function handleRenameExamPaper() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '重新命名')) return;
  const newTitle = prompt('請輸入此份試卷的新名稱：', currentExam.title || '');
  if (newTitle === null) return;
  const trimmed = newTitle.trim();
  if (!trimmed) {
    alert('試卷名稱不可為空白！');
    return;
  }

  const isDup = examLibrary.some(e => e.id !== currentExam.id && e.title.trim().toLowerCase() === trimmed.toLowerCase());
  if (isDup) {
    alert(`試卷庫中已存在同名試卷「${trimmed}」，請使用其他名稱！`);
    return;
  }

  currentExam.title = trimmed;
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.title = trimmed;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`✏️ 試卷已重新命名為「${trimmed}」！`);
}

function handleDeleteExamPaper() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (examLibrary.length <= 1) {
    alert('試卷庫中至少需保留一份試卷！若要清空考題，請使用「清空全部題目」按鈕。');
    return;
  }
  if (examData.id === currentExam.id && examData.isExamOpen) {
    alert(`試卷「${currentExam.title}」目前正處於「測驗開放中」狀態！\n\n請先於上方控制列點擊「結束作答」後再進行刪除。`);
    return;
  }

  const qCount = (currentExam.questions || []).length;
  if (!confirm(`確定要自試卷庫中刪除試卷「${currentExam.title}」嗎？\n\n（此試卷內含 ${qCount} 題考題將一併刪除，此操作無法復原）`)) {
    return;
  }

  examLibrary = examLibrary.filter(e => e.id !== currentExam.id);
  currentSelectedExamId = examLibrary[0].id;

  if (examData.id === currentExam.id) {
    examData = {
      ...examLibrary[0],
      isExamOpen: false
    };
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showToast(`🗑️ 已自試卷庫中刪除試卷「${currentExam.title}」！`);
}

function handleApplyAsActiveExam() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (examData.id === currentExam.id) {
    showToast(`此試卷【${currentExam.title}】已經是當前測驗試卷！`);
    return;
  }

  // 當有測驗正在開放中，如欲套用的試卷與開放中的試卷不相同時，跳出提醒並不讓使用者覆蓋
  if (examData.isExamOpen) {
    alert(
      `⚠️ 目前正在測驗中！\n\n試卷【${examData.title || '未命名測驗'}】目前正處於「測驗開放中」狀態。\n若將其他試卷設為當前會影響目前進行中的測驗與線上考生作答！\n\n如需切換為此試卷，請先於上方控制列點擊「結束作答」關閉測驗後再進行更換。`
    );
    return;
  }

  if (submissions.length > 0) {
    const shouldArchive = confirm(
      `切換測驗試卷前提醒：\n目前場次已有 ${submissions.length} 位考生的交卷成績！\n\n是否先將當前場次的考生成績封存為「歷次測驗紀錄」並清空當前名單？`
    );
    if (shouldArchive) {
      createAndSaveHistorySession(`${examData.title || '未命名測驗'} (${examData.examDate || '-'})`, true);
    }
  }

  examData = {
    id: currentExam.id,
    title: currentExam.title,
    examDate: currentExam.examDate,
    durationMinutes: currentExam.durationMinutes,
    isExamOpen: false,
    questions: JSON.parse(JSON.stringify(currentExam.questions || []))
  };

  saveExamDataToStorage(true);
  refreshExaminerAllViews();
  showToast(`✅ 已將試卷【${currentExam.title}】設為當前測驗試卷（目前為關閉狀態，確認無誤後可點擊上方開放作答）！`);
}

function setupExamMetaAutoSync() {
  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');

  const syncMetaFromInputs = (pushCloud = false) => {
    const currentExam = getCurrentSelectedExam();
    if (!currentExam) return;
    if (isExamLockedForEditing(currentExam)) {
      if (titleInput) titleInput.value = currentExam.title ?? '';
      if (dateInput) dateInput.value = normalizeDateForInput(currentExam.examDate ?? '');
      if (durationInput) durationInput.value = currentExam.durationMinutes === '' ? '' : (currentExam.durationMinutes ?? 60);
      return;
    }
    if (titleInput) currentExam.title = titleInput.value.trim();
    if (dateInput) currentExam.examDate = normalizeDateForInput(dateInput.value);
    if (durationInput) {
      const rawVal = durationInput.value.trim();
      currentExam.durationMinutes = rawVal === '' ? '' : Math.max(1, Number(rawVal) || 60);
    }
    currentExam.updatedAt = new Date().toISOString();

    // 即時更新下拉選單文字
    const libSelect = document.getElementById('examLibrarySelect');
    if (libSelect && libSelect.selectedOptions && libSelect.selectedOptions[0]) {
      const isActive = examData && examData.id === currentExam.id;
      const statusMark = isActive ? (examData.isExamOpen ? '　【🟢測驗進行中】' : '　【📍當前試卷】') : '';
      libSelect.selectedOptions[0].textContent = `${currentExam.title || '未命名試卷'} (${(currentExam.questions || []).length} 題)${statusMark}`;
    }

    if (examData.id === currentExam.id) {
      examData.title = currentExam.title;
      examData.examDate = currentExam.examDate;
      examData.durationMinutes = currentExam.durationMinutes;
      saveExamDataToStorage(pushCloud);
    }
    saveExamLibraryToStorage(pushCloud);
  };

  [titleInput, dateInput, durationInput].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => syncMetaFromInputs(false));
    el.addEventListener('change', () => syncMetaFromInputs(true));
  });
}

function renderExaminerQuestionTab() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;

  // 1. 渲染試卷庫下拉選單
  const libSelect = document.getElementById('examLibrarySelect');
  if (libSelect) {
    libSelect.innerHTML = '';
    examLibrary.forEach(exam => {
      const opt = document.createElement('option');
      opt.value = exam.id;
      const isActive = examData && examData.id === exam.id;
      const statusMark = isActive ? (examData.isExamOpen ? '　【🟢測驗進行中】' : '　【📍當前試卷】') : '';
      opt.textContent = `${exam.title || '未命名試卷'} (${(exam.questions || []).length} 題)${statusMark}`;
      libSelect.appendChild(opt);
    });
    libSelect.value = currentExam.id;
  }

  // 2. 顯示當前選中試卷是否為活動測驗試卷的徽章與套用按鈕
  const activeBadge = document.getElementById('currentExamActiveBadge');
  const btnApply = document.getElementById('btnApplyAsActiveExam');
  const isCurrentActive = examData && examData.id === currentExam.id;

  if (btnApply) {
    btnApply.style.display = isCurrentActive ? 'none' : 'inline-block';
  }

  const qCount = (currentExam.questions || []).length;
  const pts = getPointsPerQuestion(qCount);

  const titleInput = document.getElementById('metaExamTitle');
  const dateInput = document.getElementById('metaExamDate');
  const durationInput = document.getElementById('metaExamDuration');

  if (titleInput && document.activeElement !== titleInput) {
    titleInput.value = currentExam.title ?? '';
  }
  if (dateInput && document.activeElement !== dateInput) {
    dateInput.value = normalizeDateForInput(currentExam.examDate ?? '');
  }
  if (durationInput && document.activeElement !== durationInput) {
    durationInput.value = currentExam.durationMinutes === '' ? '' : (currentExam.durationMinutes ?? 60);
  }

  const isLocked = isExamLockedForEditing(currentExam);
  [titleInput, dateInput, durationInput].forEach(el => {
    if (!el) return;
    el.disabled = isLocked;
    el.classList.toggle('input-locked', isLocked);
  });
  const metaSubmitBtn = document.querySelector('#examMetaForm button[type="submit"]');
  if (metaSubmitBtn) {
    metaSubmitBtn.disabled = isLocked;
    metaSubmitBtn.title = isLocked ? '測驗進行中，禁止修改試卷資訊' : '';
  }

  document.getElementById('metaValidQCount').textContent = qCount;
  document.getElementById('metaPointsPerQ').textContent = pts;
  document.getElementById('questionTableCount').textContent = qCount;

  const tbody = document.getElementById('questionsTableBody');
  tbody.innerHTML = '';

  if (qCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 24px;">目前試卷【${escapeHtml(currentExam.title)}】為空白（0 題），可從左側匯入 Excel 範本或點擊「➕ 手動新增單選題」</td></tr>`;
    return;
  }

  currentExam.questions.forEach((q, idx) => {
    const tr = document.createElement('tr');
    const formattedOpts = (q.options || [])
      .map(o => `<span class="badge badge-teal" style="margin-right:4px;">${o.key}</span>${escapeHtml(o.text)}`)
      .join('<br>');

    const displayTableImg = formatGoogleDriveImageUrl(q.imageUrl);
    const imgBadge = displayTableImg
      ? `<br><span class="table-img-badge" onclick="openImageLightbox('${escapeHtml(displayTableImg)}', '第 ${idx + 1} 題圖檔')">🖼️ 查看圖片</span>`
      : '';

    tr.innerHTML = `
      <td><strong>#${idx + 1}</strong></td>
      <td>${escapeHtml(q.question)}${imgBadge}</td>
      <td style="font-size: 0.86rem; line-height: 1.7;">${formattedOpts}</td>
      <td><span class="badge badge-amber" style="font-size:0.9rem;">${escapeHtml(q.answer)}</span></td>
      <td>${pts} 分</td>
      <td style="white-space: nowrap;">
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="openEditQuestionModal(${q.id})">編輯</button>
          <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteQuestion(${q.id})">刪除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveExamMetadata(event) {
  event.preventDefault();
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '修改試卷資訊（名稱、日期、作答時間）')) return;

  currentExam.title = document.getElementById('metaExamTitle').value.trim();
  currentExam.examDate = normalizeDateForInput(document.getElementById('metaExamDate').value.trim());
  const rawDuration = document.getElementById('metaExamDuration').value.trim();
  currentExam.durationMinutes = rawDuration === '' ? '' : Math.max(1, Number(rawDuration) || 60);
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.title = currentExam.title;
    examData.examDate = currentExam.examDate;
    examData.durationMinutes = currentExam.durationMinutes;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`已成功儲存試卷【${currentExam.title}】的設定並同步至試卷資料庫！`, 'success');
}

function deleteQuestion(qId) {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '刪除題目')) return;
  const targetQ = currentExam.questions.find(q => q.id === qId);
  const qPreview = targetQ && targetQ.question ? `\n\n題目：${targetQ.question}` : '';
  if (!confirm(`確定要刪除第 ${qId} 題嗎？${qPreview}`)) return;

  currentExam.questions = currentExam.questions.filter(q => q.id !== qId);
  // 重新編號
  currentExam.questions.forEach((q, i) => {
    q.id = i + 1;
  });
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = currentExam.questions;
    if (examData.questions.length === 0) {
      examData.isExamOpen = false;
    }
    saveExamDataToStorage(true);
  }
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
}

function clearAllQuestions() {
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, '清空全部題目')) return;
  const hasQuestions = (currentExam.questions || []).length > 0;
  if (!hasQuestions) return;
  if (!confirm(`確定要清空試卷「${currentExam.title}」中的所有考題嗎？`)) return;

  currentExam.questions = [];
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = [];
    examData.isExamOpen = false;
    saveExamDataToStorage(true);
  }

  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`已清空試卷「${currentExam.title}」中的所有題目。`, 'success');
}

function syncAnswerSelectWithOptions(preferredAnswer) {
  const optionsEl = document.getElementById('newQOptions');
  const answerSelect = document.getElementById('newQAnswer');
  if (!optionsEl || !answerSelect) return;

  const currentVal = preferredAnswer !== undefined
    ? String(preferredAnswer || '').toUpperCase()
    : String(answerSelect.value || '').toUpperCase();

  const parsedOptions = parseOptionsString(optionsEl.value);
  answerSelect.innerHTML = '';

  if (parsedOptions.length === 0) {
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.disabled = true;
    placeholderOpt.selected = true;
    placeholderOpt.textContent = '請先於上方輸入選項內容（每行一項）';
    answerSelect.appendChild(placeholderOpt);
    return;
  }

  parsedOptions.forEach(opt => {
    const optEl = document.createElement('option');
    optEl.value = opt.key;
    optEl.textContent = opt.key;
    answerSelect.appendChild(optEl);
  });

  const hasCurrent = parsedOptions.some(o => o.key === currentVal);
  answerSelect.value = hasCurrent ? currentVal : parsedOptions[0].key;
}

function openAddQuestionModal() {
  const currentExam = getCurrentSelectedExam();
  if (guardActiveExamEditing(currentExam, '新增題目')) return;
  editingQuestionId = null;
  document.getElementById('addQuestionForm').reset();
  const titleEl = document.getElementById('questionModalTitle');
  const submitBtn = document.getElementById('questionModalSubmitBtn');
  if (titleEl) titleEl.textContent = '新增單選題';
  if (submitBtn) submitBtn.textContent = '新增題目';
  setQuestionModalImageState('');
  syncAnswerSelectWithOptions('');
  document.getElementById('addQuestionModal').classList.remove('hidden');
}

function openEditQuestionModal(qId) {
  const currentExam = getCurrentSelectedExam();
  if (guardActiveExamEditing(currentExam, '編輯題目內容')) return;
  const targetQ = (currentExam ? currentExam.questions : examData.questions).find(q => q.id === qId);
  if (!targetQ) return;

  editingQuestionId = qId;
  const titleEl = document.getElementById('questionModalTitle');
  const submitBtn = document.getElementById('questionModalSubmitBtn');
  if (titleEl) titleEl.textContent = `✏️ 編輯第 ${qId} 題`;
  if (submitBtn) submitBtn.textContent = '儲存修改';

  document.getElementById('newQText').value = targetQ.question || '';
  const formattedLines = Array.isArray(targetQ.options) && targetQ.options.length > 0
    ? targetQ.options.map(o => `(${o.key}) ${o.text}`).join('\n')
    : (targetQ.rawOptions || '');
  document.getElementById('newQOptions').value = formattedLines;
  syncAnswerSelectWithOptions(String(targetQ.answer || 'A').toUpperCase());

  setQuestionModalImageState(targetQ.imageUrl || '');
  document.getElementById('addQuestionModal').classList.remove('hidden');
}

function closeAddQuestionModal() {
  editingQuestionId = null;
  setQuestionModalImageState('');
  document.getElementById('addQuestionModal').classList.add('hidden');
}

/**
 * 將各類 Google 雲端硬碟檔案連結格式自動轉換為可跨域直接在 <img> 標籤中載入的直連圖片網址
 */
function formatGoogleDriveImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const url = rawUrl.trim();

  // 若為 Data URL 或一般外鏈非 Google Drive 圖片，直接返回
  if (url.startsWith('data:')) {
    return url;
  }

  // 匹配 Google Drive File ID 的各種常見格式
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/open\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/uc\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/thumbnail\?[^#]*id=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/i,
    /googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/i
  ];

  for (const reg of patterns) {
    const match = url.match(reg);
    if (match && match[1]) {
      const fileId = match[1];
      // 優先使用 Google 官方 CDN 直連網址，支援跨域嵌入 <img>
      return `https://lh3.googleusercontent.com/d/${fileId}`;
    }
  }

  return url;
}

/**
 * 取得圖片載入失敗時的自動 fallback 屬性 (若 lh3.googleusercontent.com 失敗則切換至 drive thumbnail)
 */
function getImageOnErrorAttr(url) {
  if (!url) return '';
  const fileIdMatch = String(url).match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
  if (!fileIdMatch) return '';
  const fileId = fileIdMatch[1];
  return `onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='https://drive.google.com/thumbnail?id=${fileId}&sz=w1600';}"`;
}

function setQuestionModalImageState(url, localPreviewUrl) {
  const formattedUrl = formatGoogleDriveImageUrl(url);
  const urlInput = document.getElementById('newQImageUrl');
  const previewWrap = document.getElementById('newQImagePreviewWrap');
  const previewImg = document.getElementById('newQImagePreview');
  const btnClear = document.getElementById('btnClearQImage');
  const statusEl = document.getElementById('qImageUploadStatus');

  if (urlInput) urlInput.value = formattedUrl || '';
  if (statusEl) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
  }

  const effectiveSrc = localPreviewUrl || formattedUrl;

  if (effectiveSrc) {
    if (previewImg) {
      previewImg.removeAttribute('data-fallback');
      previewImg.src = effectiveSrc;
      const fileIdMatch = formattedUrl.match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
      if (fileIdMatch && !localPreviewUrl) {
        const fileId = fileIdMatch[1];
        previewImg.onerror = function () {
          if (!this.dataset.fallback) {
            this.dataset.fallback = '1';
            this.src = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
          }
        };
      } else {
        previewImg.onerror = null;
      }
    }
    if (previewWrap) previewWrap.classList.remove('hidden');
    if (btnClear) btnClear.classList.remove('hidden');
  } else {
    if (previewImg) {
      previewImg.src = '';
      previewImg.onerror = null;
    }
    if (previewWrap) previewWrap.classList.add('hidden');
    if (btnClear) btnClear.classList.add('hidden');
  }
}

function handleImageUrlInput() {
  const urlInput = document.getElementById('newQImageUrl');
  if (!urlInput) return;
  const rawUrl = urlInput.value.trim();
  if (rawUrl) {
    const formatted = formatGoogleDriveImageUrl(rawUrl);
    setQuestionModalImageState(formatted);
  } else {
    setQuestionModalImageState('');
  }
}

function clearQuestionImage() {
  setQuestionModalImageState('');
}

async function handleQuestionImageSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const gasUrl = getActiveGasUrl();
  const statusEl = document.getElementById('qImageUploadStatus');
  const btnUpload = document.getElementById('btnUploadQImage');

  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = '⏳ 正在讀取並準備上傳圖片...';
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const dataUrl = e.target.result;
    const base64Index = dataUrl.indexOf(',');
    const base64Data = base64Index !== -1 ? dataUrl.substring(base64Index + 1) : dataUrl;

    if (gasUrl) {
      if (statusEl) statusEl.textContent = '☁️ 正在上傳圖檔至 Google 雲端硬碟資料夾...';
      if (btnUpload) btnUpload.disabled = true;

      const res = await postToCloud({
        action: 'uploadQuestionImage',
        base64Data: base64Data,
        mimeType: file.type || 'image/png',
        fileName: file.name || 'question.png'
      });

      if (btnUpload) btnUpload.disabled = false;

      if (res && res.status === 'success' && res.imageUrl) {
        // 設定雲端直連網址並以本機 dataUrl 確保預覽立即順暢顯示
        setQuestionModalImageState(res.imageUrl, dataUrl);
        if (statusEl) {
          statusEl.classList.remove('hidden');
          statusEl.style.color = '#15803d';
          statusEl.textContent = '✅ 圖片已成功上傳至指定 Google 雲端硬碟！';
        }
        showToast('🖼️ 考題圖片已成功上傳至雲端資料夾！');
        return;
      } else {
        const errMsg = (res && res.message) ? res.message : '雲端上傳回應異常';
        if (String(errMsg).includes('DriveApp') || String(errMsg).includes('權限') || String(errMsg).includes('authorization')) {
          alert(`【Google 雲端硬碟尚未授權】\n\n原因：Google 尚未授予此 Apps Script 存取 Google 雲端硬碟 (DriveApp) 的權限。\n\n解決步驟：\n1. 打開 Google 試算表的「擴充功能」>「Apps Script」\n2. 上方執行函式下拉選單選擇「testDriveAuthorization」並點選「執行」\n3. 依提示完成 Google 帳號授權（核對權限 -> 進階 -> 前往 -> 允許）\n4. 點選右上角「部署」>「管理部署作業」> 點鉛筆圖示「編輯」> 版本選擇「建立新版本」後儲存即可！\n\n（本次系統已自動改用本機圖片預覽）`);
        } else {
          alert(`上傳至雲端硬碟失敗（${errMsg}），系統將自動使用本機圖片預覽。`);
        }
      }
    }

    // 若尚未連線雲端或連線失敗，以 Data URL 作為本地備援
    setQuestionModalImageState(dataUrl);
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.style.color = '#d97706';
      statusEl.textContent = '⚠️ 已以本機圖片載入（若連線雲端可自動上傳至雲端硬碟備份）';
    }
  };
  reader.readAsDataURL(file);
}

function handleSaveNewQuestion(event) {
  event.preventDefault();
  const currentExam = getCurrentSelectedExam();
  if (!currentExam) return;
  if (guardActiveExamEditing(currentExam, editingQuestionId !== null ? '編輯題目內容' : '新增題目')) {
    closeAddQuestionModal();
    return;
  }

  const qText = document.getElementById('newQText').value.trim();
  const rawOpts = document.getElementById('newQOptions').value.trim();
  const ans = document.getElementById('newQAnswer').value.trim().toUpperCase();
  const rawImgUrl = (document.getElementById('newQImageUrl') ? document.getElementById('newQImageUrl').value.trim() : '');
  const imgUrl = formatGoogleDriveImageUrl(rawImgUrl);

  const parsedOptions = parseOptionsString(rawOpts);
  if (parsedOptions.length < 2) {
    alert('請輸入至少 2 個選項（每行一個選項）！');
    return;
  }

  if (editingQuestionId !== null) {
    const targetQ = currentExam.questions.find(q => q.id === editingQuestionId);
    if (targetQ) {
      const prevAns = String(targetQ.answer || '').toUpperCase();
      targetQ.question = qText;
      targetQ.rawOptions = rawOpts;
      targetQ.options = parsedOptions;
      targetQ.answer = ans;
      targetQ.imageUrl = imgUrl;

      // 若目前選取的試卷恰為當前進行中的測驗且已有考生交卷，考官修改答案時同步重算考生成績
      if (examData.id === currentExam.id && prevAns !== ans && submissions.length > 0) {
        const totalQ = examData.questions.length;
        submissions.forEach(sub => {
          if (sub.answerDetails && sub.answerDetails[targetQ.id]) {
            const d = sub.answerDetails[targetQ.id];
            d.correctAnswer = ans;
            d.isCorrect = String(d.selected || '').toUpperCase() === ans;
          }
          let newCorrectCount = 0;
          examData.questions.forEach(q => {
            const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
            if (detail && detail.isCorrect) newCorrectCount++;
          });
          sub.correctCount = newCorrectCount;
          sub.totalQuestions = totalQ;
          sub.score = totalQ > 0 ? Number(((newCorrectCount / totalQ) * 100).toFixed(1)) : 0;
        });
        saveSubmissionsToStorage(true);
      }
    }

    currentExam.updatedAt = new Date().toISOString();
    if (examData.id === currentExam.id) {
      examData.questions = currentExam.questions;
      saveExamDataToStorage(true);
    }
    saveExamLibraryToStorage(true);
    closeAddQuestionModal();
    refreshExaminerAllViews();
    showImportAlert(`已成功更新試卷【${currentExam.title}】第 ${editingQuestionId} 題內容並同步！`, 'success');
    return;
  }

  const newId = (currentExam.questions || []).length + 1;
  currentExam.questions.push({
    id: newId,
    question: qText,
    imageUrl: imgUrl,
    rawOptions: rawOpts,
    options: parsedOptions,
    answer: ans
  });
  currentExam.updatedAt = new Date().toISOString();

  if (examData.id === currentExam.id) {
    examData.questions = currentExam.questions;
    saveExamDataToStorage(true);
  }
  saveExamLibraryToStorage(true);
  closeAddQuestionModal();
  refreshExaminerAllViews();
  showImportAlert(`已新增第 ${newId} 題至試卷【${currentExam.title}】！`, 'success');
}

// ==================== Excel 範本匯入與解析 ====================
function setupDragAndDrop() {
  const dropzone = document.getElementById('excelDropzone');
  if (!dropzone) return;

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processExcelFile(e.dataTransfer.files[0]);
    }
  });
}

function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (file) {
    processExcelFile(file);
  }
  event.target.value = '';
}

function processExcelFile(file) {
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: true });
      parseTemplateRows(rows, file.name);
    } catch (err) {
      console.error(err);
      showImportAlert('讀取 Excel 檔案失敗，請確認檔案格式是否為有效的 .xlsx, .xls 或 .csv！', 'danger');
    }
  };
  reader.readAsArrayBuffer(file);
}

function parseTemplateRows(rows, fileName) {
  if (!rows || rows.length === 0) {
    showImportAlert('檔案內容空白或格式不符！', 'danger');
    return;
  }

  const parsedQuestions = [];

  // 範本中第 1~5 列 (index 0~4) 為範例不需要讀取，第 6 列 (index 5) 為空白分隔列，題目從第 7 列 (index 6) 開始讀取
  // 試卷資訊（試卷名稱、考試日期、作答時間）不再讀取匯入檔案，完全保留考官手動輸入的值
  for (let r = 6; r < rows.length; r++) {
    const row = rows[r].map(cell => String(cell ?? '').trim());
    if (row[0] === '範例') continue;

    const qLabelIdx = row.findIndex(cell => cell === '題目');
    if (qLabelIdx !== -1) {
      const questionText = row[qLabelIdx + 1] || '';
      const ansLabelIdx = row.findIndex(cell => cell === '答案');

      let answerText = '';
      if (ansLabelIdx !== -1 && row[ansLabelIdx + 1]) {
        answerText = row[ansLabelIdx + 1];
      }

      const optionLines = [];
      let k = r + 1;
      for (; k < rows.length; k++) {
        const subRow = rows[k].map(cell => String(cell ?? '').trim());
        // 遇到下一題的「題目」列時停止
        if (subRow.includes('題目')) {
          break;
        }
        // 讀取選項文字（位於「題目/選項」標籤右側欄位）
        const optCell = subRow[qLabelIdx + 1] || '';
        if (optCell) {
          optionLines.push(optCell);
        }
        // 讀取答案文字（位於「答案」標籤正下方或右側欄位）
        if (!answerText && ansLabelIdx !== -1) {
          if (subRow[ansLabelIdx]) {
            answerText = subRow[ansLabelIdx];
          } else if (subRow[ansLabelIdx + 1]) {
            answerText = subRow[ansLabelIdx + 1];
          }
        }
      }

      const rawOptionsText = optionLines.join('\n');
      if (questionText && rawOptionsText) {
        const optionsArr = parseOptionsString(rawOptionsText);
        const cleanAns = answerText.replace(/[^A-Za-z]/g, '').toUpperCase() || 'A';

        parsedQuestions.push({
          id: parsedQuestions.length + 1,
          question: questionText,
          rawOptions: rawOptionsText,
          options: optionsArr,
          answer: cleanAns
        });
      }

      r = k - 1;
    }
  }

  const fileBaseTitle = fileName.replace(/\.[^/.]+$/, '').replace(/_考題範本$/, '').trim() || '匯入試卷';
  const existingExam = examLibrary.find(e => e.title.trim().toLowerCase() === fileBaseTitle.toLowerCase());

  if (existingExam) {
    const shouldOverwrite = confirm(
      `偵測到試卷庫中已存在同名試卷「${fileBaseTitle}」（現有 ${(existingExam.questions || []).length} 題）！\n\n【確定】：覆蓋更新原試卷「${fileBaseTitle}」的題目內容\n【取消】：另存為新試卷（將另存為新版試卷獨立保存）`
    );

    if (shouldOverwrite) {
      if (guardActiveExamEditing(existingExam, '匯入覆蓋題目')) return;
      if (examData.id === existingExam.id && submissions.length > 0) {
        const shouldArchive = confirm(
          `提醒：當前場次已有 ${submissions.length} 位考生的交卷成績！\n\n是否先將當前場次的考生成績封存為「歷次測驗紀錄」並清空當前名單？`
        );
        if (shouldArchive) {
          createAndSaveHistorySession(`${examData.title || '未命名測驗'} (${examData.examDate || '-'})`, true);
        }
      }

      existingExam.questions = parsedQuestions;
      existingExam.updatedAt = new Date().toISOString();
      currentSelectedExamId = existingExam.id;

      if (examData.id === existingExam.id) {
        examData.questions = parsedQuestions;
        saveExamDataToStorage(true);
      }

      saveExamLibraryToStorage(true);
      refreshExaminerAllViews();
      showImportAlert(`已成功覆蓋更新試卷「${fileBaseTitle}」！共讀取 ${parsedQuestions.length} 題有效單選題。`, 'success');
      return;
    } else {
      // 另存為新試卷
      let newTitle = `${fileBaseTitle} (新版)`;
      let counter = 2;
      while (examLibrary.some(e => e.title.trim().toLowerCase() === newTitle.toLowerCase())) {
        newTitle = `${fileBaseTitle} (新版 ${counter++})`;
      }

      const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
      const newExam = {
        id: 'exam_' + Date.now(),
        title: newTitle,
        examDate: todayStr,
        durationMinutes: 60,
        questions: parsedQuestions,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      examLibrary.push(newExam);
      currentSelectedExamId = newExam.id;
      saveExamLibraryToStorage(true);
      refreshExaminerAllViews();
      showImportAlert(`已將題目另存為新試卷「${newTitle}」！共讀取 ${parsedQuestions.length} 題有效單選題。`, 'success');
      return;
    }
  }

  // 試卷庫中尚無同名試卷，直接新建一份
  const todayStr = normalizeDateForInput(new Date().toISOString().slice(0, 10));
  const newExam = {
    id: 'exam_' + Date.now(),
    title: fileBaseTitle,
    examDate: todayStr,
    durationMinutes: 60,
    questions: parsedQuestions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  examLibrary.push(newExam);
  currentSelectedExamId = newExam.id;
  saveExamLibraryToStorage(true);
  refreshExaminerAllViews();
  showImportAlert(`成功自「${fileName}」匯入新試卷「${fileBaseTitle}」至試卷庫！共讀取 ${parsedQuestions.length} 題有效單選題。`, 'success');
}

function parseOptionsString(rawStr) {
  const lines = String(rawStr)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const result = [];
  const usedKeys = new Set();

  lines.forEach((line, idx) => {
    const defaultKey = idx < 26 ? String.fromCharCode(65 + idx) : String(idx + 1);
    const match = line.match(/^[\(\[（]?([A-Za-z])[\)\]）．.、]+\s*(.*)$/);
    if (match) {
      const parsedKey = match[1].toUpperCase();
      const finalKey = usedKeys.has(parsedKey) ? defaultKey : parsedKey;
      usedKeys.add(finalKey);
      result.push({
        key: finalKey,
        text: match[2].trim()
      });
    } else {
      usedKeys.add(defaultKey);
      result.push({
        key: defaultKey,
        text: line
      });
    }
  });

  return result;
}

function showImportAlert(msg, type) {
  const boxes = document.querySelectorAll('#importAlertBox');
  boxes.forEach(box => {
    box.textContent = msg;
    box.className = `alert alert-${type === 'danger' ? 'danger' : 'success'}`;
    box.classList.remove('hidden');
  });
}

function downloadSampleExcel(event) {
  showToast('📥 正在下載「考題匯入範本.xlsx」...');
  const sampleFileName = '考題匯入範本.xlsx';
  const githubRawUrl = 'https://raw.githubusercontent.com/bruceabc0511/EZOnlineEXAM/main/%E8%80%83%E9%A1%8C%E5%8C%AF%E5%85%A5%E7%AF%84%E6%9C%AC.xlsx';

  // 若為原生 <a> 點擊，瀏覽器將依 href 與 download 屬性自動觸發下載
  if (event && event.currentTarget && event.currentTarget.tagName === 'A') {
    return;
  }

  const link = document.createElement('a');
  link.href = window.location.protocol.startsWith('http') ? encodeURI(sampleFileName) : githubRawUrl;
  link.download = sampleFileName;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ==================== 考官端頁籤 2：當前場次成績統計與寄送 Email ====================
function renderExaminerScoresTab() {
  document.getElementById('tabScoreCount').textContent = submissions.length;
  const tbody = document.getElementById('scoresTableBody');
  tbody.innerHTML = '';

  if (submissions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color: var(--text-muted); padding: 28px;">目前場次尚無考生交卷紀錄。</td></tr>`;
    return;
  }

  submissions.forEach(sub => {
    tbody.appendChild(buildSubmissionRowElement(sub, 'CURRENT'));
  });
}

function buildSubmissionRowElement(sub, sessionId) {
  const tr = document.createElement('tr');
  const isForced = String(sub.status || '').includes('強制終止');
  const statusBadge = isForced
    ? `<span class="badge badge-danger">${escapeHtml(sub.status)}</span>`
    : `<span class="badge badge-teal">${escapeHtml(sub.status)}</span>`;

  const warnBadge =
    sub.warningCount > 0
      ? `<span class="badge badge-danger">${sub.warningCount} 次</span>`
      : `<span class="text-muted">0 次</span>`;

  const scoreColor = sub.score >= 60 ? 'var(--primary-darker)' : 'var(--danger)';
  const emailDisplay = sub.studentEmail
    ? `<span style="font-size:0.86rem;">${escapeHtml(sub.studentEmail)}</span>`
    : `<span class="text-muted text-sm">未填寫</span>`;

  const emailStatusBadge = sub.emailSentAt
    ? `<span class="badge badge-teal" title="寄送時間：${escapeHtml(sub.emailSentAt)}">✅ 已寄送</span>`
    : `<span class="badge badge-amber">尚未寄送</span>`;

  tr.innerHTML = `
    <td style="white-space: nowrap;"><strong>${escapeHtml(sub.studentId || '-')}</strong></td>
    <td style="white-space: nowrap; min-width: 90px;">${escapeHtml(sub.studentName)}</td>
    <td class="cell-wrap-email">${emailDisplay}</td>
    <td style="white-space: nowrap;"><strong style="font-size:1.05rem; color:${scoreColor};">${sub.score} 分</strong></td>
    <td style="white-space: nowrap;">${sub.correctCount} / ${sub.totalQuestions} 題</td>
    <td style="white-space: nowrap;">${escapeHtml(sub.timeSpentFormatted)}</td>
    <td style="white-space: nowrap;">${warnBadge}</td>
    <td style="white-space: nowrap;">${statusBadge}</td>
    <td class="cell-wrap-time">${escapeHtml(sub.submittedAt)}</td>
    <td style="white-space: nowrap;">${emailStatusBadge}</td>
    <td style="white-space: nowrap;">
      <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteSingleSubmission('${sub.id}', '${sessionId}')">刪除</button>
    </td>
  `;
  return tr;
}

function getSessionDataById(sessionId) {
  if (sessionId === 'CURRENT') {
    return {
      title: examData.title,
      examDate: examData.examDate,
      questions: examData.questions,
      submissions: submissions
    };
  }
  const hist = historySessions.find(h => h.id === sessionId);
  if (!hist) return null;
  return {
    title: hist.examTitle || hist.sessionTitle,
    examDate: hist.examDate,
    questions: hist.questionsSnapshot || [],
    submissions: hist.submissions || []
  };
}

function viewStudentDetail(sessionId, subId) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj) return;

  const sub = sessionObj.submissions.find(s => s.id === subId);
  if (!sub) return;

  document.getElementById('detailModalTitle').textContent = `${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''} - 作答明細 (${sub.score} 分)`;
  const body = document.getElementById('detailModalBody');

  let rowsHtml = '';
  sessionObj.questions.forEach((q, idx) => {
    const d = sub.answerDetails ? sub.answerDetails[q.id] : null;
    const picked = d ? d.selected : '未作答';
    const isCorrect = d ? d.isCorrect : false;
    const badge = isCorrect
      ? `<span class="badge badge-teal">✔ 答對</span>`
      : `<span class="badge badge-danger">✘ 答錯</span>`;

    rowsHtml += `
      <tr>
        <td>第 ${idx + 1} 題</td>
        <td>${escapeHtml(q.question)}</td>
        <td><strong>${escapeHtml(picked)}</strong></td>
        <td><strong style="color:var(--primary);">${escapeHtml(q.answer)}</strong></td>
        <td>${badge}</td>
      </tr>
    `;
  });

  body.innerHTML = `
    <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <span class="text-muted text-sm">電子信箱：<strong>${escapeHtml(sub.studentEmail || '未填寫')}</strong>｜交卷時間：${escapeHtml(sub.submittedAt)}</span>
      <button type="button" class="btn btn-primary btn-sm" onclick="sendSingleScoreEmail('${sessionId}', '${sub.id}')">📧 寄送此考生成績單 Email</button>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:80px;">題號</th>
          <th>題目</th>
          <th style="width:90px;">考生作答</th>
          <th style="width:90px;">標準答案</th>
          <th style="width:90px;">結果</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  document.getElementById('studentDetailModal').classList.remove('hidden');
}

function closeStudentDetailModal() {
  document.getElementById('studentDetailModal').classList.add('hidden');
}

function deleteSingleSubmission(subId, sessionId = 'CURRENT') {
  if (!confirm('確定要刪除此位考生的作答紀錄嗎？（刪除後該電子郵件即可重新應試）')) return;
  if (sessionId === 'CURRENT') {
    submissions = submissions.filter(s => s.id !== subId);
    saveSubmissionsToStorage(true);
    refreshExaminerAllViews();
  } else {
    const hist = historySessions.find(h => h.id === sessionId);
    if (hist && Array.isArray(hist.submissions)) {
      hist.submissions = hist.submissions.filter(s => s.id !== subId);
      hist.stats = calculateStatsForList(hist.submissions);
      saveHistorySessionsToStorage(true);
      refreshExaminerAllViews();
      if (currentViewingHistoryId === sessionId) {
        viewHistorySessionDetail(sessionId);
      }
    }
  }
}

function clearAllSubmissions() {
  if (submissions.length === 0) return;
  if (!confirm('確定要清空「當前場次」所有考生的成績紀錄嗎？（若需保存紀錄，建議先點選「結束本場測驗並歸檔至歷史紀錄」）')) return;
  submissions = [];
  saveSubmissionsToStorage(true);
  refreshExaminerAllViews();
}

// ==================== 考後寄送成績單 Email 功能 (含考生作答明細與對錯標記，不含題目與標準答案) ====================
function extractStudentAnswersForEmail(sub, sessionObj) {
  const details = sub.answerDetails || {};
  const questions = (sessionObj && Array.isArray(sessionObj.questions) && sessionObj.questions.length > 0)
    ? sessionObj.questions
    : null;

  const list = [];
  if (questions) {
    questions.forEach((q, idx) => {
      const d = details[q.id];
      list.push({
        qNum: idx + 1,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    });
  } else {
    const total = Number(sub.totalQuestions) || Object.keys(details).length;
    for (let i = 1; i <= total; i++) {
      const d = details[i];
      list.push({
        qNum: i,
        selected: d && d.selected ? String(d.selected) : '-',
        isCorrect: Boolean(d && d.isCorrect)
      });
    }
  }
  return list;
}

function buildStudentAnswerGridHtml(studentAnswers) {
  if (!Array.isArray(studentAnswers) || studentAnswers.length === 0) return '';

  const perRow = 5;
  let rowsHtml = '';

  for (let i = 0; i < studentAnswers.length; i += perRow) {
    const chunk = studentAnswers.slice(i, i + perRow);

    let qNumCells = '';
    let ansCells = '';

    for (let j = 0; j < perRow; j++) {
      const item = chunk[j];
      if (item) {
        qNumCells += `<td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;font-size:15px;">${item.qNum}</td>`;
        const bg = item.isCorrect ? '#ccfbf1' : '#fca5a5';
        const fg = item.isCorrect ? '#0f172a' : '#7f1d1d';
        ansCells += `<td style="background:${bg};color:${fg};font-weight:700;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;font-size:16px;">${escapeHtml(item.selected)}</td>`;
      } else {
        qNumCells += `<td style="background:#005959;color:#ffffff;text-align:center;padding:8px 6px;border:1px solid #003d3d;width:15%;"></td>`;
        ansCells += `<td style="background:#f8fafc;color:#94a3b8;text-align:center;padding:10px 6px;border:1px solid #003d3d;width:15%;"></td>`;
      }
    }

    rowsHtml += `
      <tr>
        <td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:8px 10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">題號</td>
        ${qNumCells}
      </tr>
      <tr>
        <td style="background:#005959;color:#ffffff;font-weight:700;text-align:center;padding:10px;border:1px solid #003d3d;width:25%;white-space:nowrap;font-size:15px;">考生答案</td>
        ${ansCells}
      </tr>
    `;
  }

  return `
    <div style="margin-top:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div style="font-size:15px;font-weight:700;color:#005959;">📋 考生作答明細　　</div>
        <div style="font-size:12.5px;color:#475569;">
          <span style="display:inline-block;width:12px;height:12px;background:#ccfbf1;border:1px solid #005959;vertical-align:middle;margin-right:4px;"></span>答對
          <span style="display:inline-block;width:12px;height:12px;background:#fca5a5;border:1px solid #dc2626;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>答錯
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;border:2px solid #003d3d;font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;">
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function buildScoreEmailHtmlClient(sub, sessionObj, studentAnswers) {
  const scoreColor = Number(sub.score) >= 60 ? '#007979' : '#dc2626';
  const passBadge = Number(sub.score) >= 60 ? '及格' : '未達及格標準 (60分)';
  const examDateStr = sub.examDate || (sessionObj && sessionObj.examDate) || '-';
  const gridHtml = buildStudentAnswerGridHtml(studentAnswers);

  return `
    <div style="font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:620px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#ffffff;">
      <div style="background:linear-gradient(135deg,#005959,#007979);color:#ffffff;padding:20px 24px;">
        <div style="font-size:13px;opacity:0.9;">線上筆試測驗系統 — 成績通知單</div>
        <h2 style="margin:6px 0 0;font-size:20px;">${escapeHtml(sub.examTitle || (sessionObj && sessionObj.title) || '線上筆試測驗')}</h2>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 16px;font-size:15px;color:#334155;">
          <strong>${escapeHtml(sub.studentName)}</strong>${sub.studentId ? `（編號：<strong>${escapeHtml(sub.studentId)}</strong>）` : ''} 您好，您的筆試測驗成績結果如下：
        </p>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;margin-bottom:16px;">
          <div style="font-size:14px;color:#64748b;">測驗總分（滿分 100 分）</div>
          <div style="font-size:34px;font-weight:800;color:${scoreColor};margin:6px 0;">
            ${sub.score} <span style="font-size:16px;font-weight:600;">分（${passBadge}）</span>
          </div>
          <div style="font-size:13.5px;color:#475569;margin-top:10px;line-height:1.8;">
            • 考試日期：<strong>${escapeHtml(examDateStr)}</strong><br>
            • 答對題數：<strong>${sub.correctCount} / ${sub.totalQuestions} 題</strong><br>
            • 作答耗時：<strong>${escapeHtml(sub.timeSpentFormatted || '-')}</strong><br>
            • 交卷狀態：<strong>${escapeHtml(sub.status || '正常交卷')}</strong><br>
            • 交卷時間：<strong>${escapeHtml(sub.submittedAt || '-')}</strong>
          </div>
        </div>

        ${gridHtml}

        <p style="margin-top:20px;font-size:12px;color:#94a3b8;text-align:center;">
          本信件由「線上筆試測驗系統」自動發送，僅提供個人作答選項與對錯結果，不附載試題與標準答案。
        </p>
      </div>
    </div>
  `;
}

function buildPlainTextScoreEmail(sub, sessionObj) {
  const passText = Number(sub.score) >= 60 ? '及格' : '未達及格標準(60分)';
  const examDateStr = sub.examDate || sessionObj.examDate || '-';
  const studentAnswers = extractStudentAnswersForEmail(sub, sessionObj);
  const ansSummaryLines = studentAnswers.map(
    item => `第 ${item.qNum} 題：${item.selected} (${item.isCorrect ? '答對' : '答錯'})`
  );

  const lines = [
    `${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''} 您好：`,
    ``,
    `以下為您在【${sub.examTitle || sessionObj.title || '線上筆試測驗'}】的筆試測驗成績通知單：`,
    `----------------------------------------`,
    `• 考生姓名：${sub.studentName}`,
    `• 編號：${sub.studentId || '-'}`,
    `• 考試日期：${examDateStr}`,
    `• 測驗總分：${sub.score} 分 (${passText})`,
    `• 答對題數：${sub.correctCount} / ${sub.totalQuestions} 題`,
    `• 作答耗時：${sub.timeSpentFormatted}`,
    `• 交卷狀態：${sub.status}`,
    `• 交卷時間：${sub.submittedAt}`,
    `----------------------------------------`,
    `【考生作答明細】`,
    ...ansSummaryLines,
    `----------------------------------------`,
    `（為維護題庫保密原則，本成績單不附載考題與標準答案）`,
    ``,
    `線上筆試測驗系統 敬上`
  ];
  return lines.join('\n');
}

async function sendSingleScoreEmail(sessionId, subId) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj) return;
  const sub = sessionObj.submissions.find(s => s.id === subId);
  if (!sub) return;

  if (!sub.studentEmail || !sub.studentEmail.includes('@')) {
    const manualEmail = prompt(`考生「${sub.studentName}」尚未填寫有效的 Email，請輸入要寄送的電子郵件信箱：`, '');
    if (!manualEmail || !manualEmail.includes('@')) return;
    sub.studentEmail = manualEmail.trim();
  }

  await dispatchScoreEmails(sessionId, [sub], sessionObj);
}

async function sendAllScoresEmail(sessionId, silentIfNone = false) {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj || sessionObj.submissions.length === 0) {
    if (!silentIfNone) alert('目前沒有考生成績可供寄送！');
    return;
  }

  const validSubs = sessionObj.submissions.filter(s => s.studentEmail && s.studentEmail.includes('@'));
  if (validSubs.length === 0) {
    if (!silentIfNone) alert('本場次考生皆未填寫有效的電子郵件 (Email)！');
    return;
  }

  if (!silentIfNone) {
    if (!confirm(`確定要寄送成績通知信給本場次共 ${validSubs.length} 位考生嗎？\n（信件含個人測驗總分與考生作答對錯明細，不包含題目與標準答案）`)) {
      return;
    }
  }

  await dispatchScoreEmails(sessionId, validSubs, sessionObj);
}

async function dispatchScoreEmails(sessionId, recipients, sessionObj) {
  const gasUrl = getActiveGasUrl();
  const nowStr = formatDateTime(new Date());

  // 寄信資料傳遞成績摘要與考生每題作答選項及對錯 (studentAnswers)，不包含題目與標準答案
  const sanitizedRecipients = recipients.map(r => {
    const studentAnswers = extractStudentAnswersForEmail(r, sessionObj);
    return {
      id: r.id,
      examTitle: r.examTitle,
      examDate: r.examDate,
      studentName: r.studentName,
      studentId: r.studentId,
      studentEmail: r.studentEmail,
      score: r.score,
      correctCount: r.correctCount,
      totalQuestions: r.totalQuestions,
      timeSpentFormatted: r.timeSpentFormatted,
      status: r.status,
      submittedAt: r.submittedAt,
      studentAnswers: studentAnswers,
      customHtmlBody: buildScoreEmailHtmlClient(r, sessionObj, studentAnswers)
    };
  });

  // 模式 1：若已綁定 Google Apps Script 雲端後端，直接透過 Google MailApp 雲端背景自動發送 HTML 成績信
  if (gasUrl) {
    showToast(`📧 正在透過 Google 雲端自動寄送 ${sanitizedRecipients.length} 封考生成績通知信...`);
    const res = await postToCloud({
      action: 'sendScoreEmails',
      sessionId: sessionId,
      recipients: sanitizedRecipients,
      examData: {
        title: sessionObj.title,
        examDate: sessionObj.examDate
      }
    });

    if (res && res.status === 'success') {
      const sentIds = res.sentIds || recipients.map(r => r.id);
      const sentTime = res.emailSentAt || nowStr;

      sessionObj.submissions.forEach(s => {
        if (sentIds.includes(s.id)) {
          s.emailSentAt = sentTime;
        }
      });

      if (sessionId === 'CURRENT') {
        saveSubmissionsToStorage(false);
      } else {
        saveHistorySessionsToStorage(false);
      }
      refreshExaminerAllViews();
      if (currentViewingHistoryId) {
        viewHistorySessionDetail(currentViewingHistoryId);
      }

      if (res.errors && res.errors.length > 0) {
        alert(`已寄出 ${res.sentCount} 封信，但有部分信箱發送失敗：\n${res.errors.join('\n')}`);
      } else {
        showToast(`✅ 成功寄出 ${res.sentCount} 封 HTML 考生成績單 Email！`);
      }
      return;
    } else {
      showToast('⚠️ 雲端寄信未回應，將切換為本機郵件發送模式');
    }
  }

  // 模式 2：本機未綁定雲端時，使用 mailto: 喚起系統郵件客戶端寄發完整成績單
  if (recipients.length === 1) {
    const sub = recipients[0];
    const subject = `【測驗成績通知】${sub.examTitle || sessionObj.title || '線上筆試測驗'} - ${sub.studentName}${sub.studentId ? ` (${sub.studentId})` : ''}`;
    const body = buildPlainTextScoreEmail(sub, sessionObj);
    sub.emailSentAt = nowStr;

    if (sessionId === 'CURRENT') {
      saveSubmissionsToStorage(false);
    } else {
      saveHistorySessionsToStorage(false);
    }
    refreshExaminerAllViews();
    if (currentViewingHistoryId) {
      viewHistorySessionDetail(currentViewingHistoryId);
    }

    window.location.href = `mailto:${encodeURIComponent(sub.studentEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    showToast(`✉️ 已開啟「${sub.studentName}」的成績通知信件視窗！`);
  } else {
    const bccList = recipients.map(r => r.studentEmail).join(',');
    const subject = `【測驗成績公佈】${sessionObj.title || '線上筆試測驗'} (${sessionObj.examDate || '-'}) 個人成績總表`;
    const summaryLines = [
      `各位考生您好，【${sessionObj.title || '線上筆試測驗'}】測驗已結束，成績摘要如下：`,
      `----------------------------------------`
    ];
    recipients.forEach(r => {
      summaryLines.push(`• ${r.studentName}${r.studentId ? ` (${r.studentId})` : ''}：${r.score} 分 (答對 ${r.correctCount}/${r.totalQuestions} 題)`);
      r.emailSentAt = nowStr;
    });
    summaryLines.push(
      `----------------------------------------`,
      `💡 考官提示：若於「☁️ 雲端連線與寄信設定」綁定 Google Apps Script，系統即可自動為每位考生獨立寄發專屬 HTML 個人成績單！`
    );

    if (sessionId === 'CURRENT') {
      saveSubmissionsToStorage(false);
    } else {
      saveHistorySessionsToStorage(false);
    }
    refreshExaminerAllViews();
    if (currentViewingHistoryId) {
      viewHistorySessionDetail(currentViewingHistoryId);
    }

    window.location.href = `mailto:?bcc=${encodeURIComponent(bccList)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summaryLines.join('\n'))}`;
    showToast(`✉️ 已標記寄送狀態並開啟批次成績通知郵件（若綁定雲端即可全自動背景獨立發信）`);
  }
}

// ==================== 將每一次測驗結果獨立成一筆歷史紀錄 (頁籤 4) ====================
function openArchiveSessionModal() {
  if (submissions.length === 0) {
    alert('目前場次尚無任何考生交卷紀錄，請待考生交卷後再進行結算歸檔！');
    return;
  }

  document.getElementById('archiveStudentCount').textContent = submissions.length;
  const defaultTitle = `${examData.title || '線上筆試測驗'} (${examData.examDate || formatDateTime(new Date()).slice(0, 10)})`;
  document.getElementById('archiveSessionTitle').value = defaultTitle;
  document.getElementById('archiveAutoSendEmail').checked = true;
  document.getElementById('archiveClearCurrent').checked = true;
  document.getElementById('archiveSessionModal').classList.remove('hidden');
}

function closeArchiveSessionModal() {
  document.getElementById('archiveSessionModal').classList.add('hidden');
}

async function confirmArchiveCurrentSession(event) {
  event.preventDefault();
  const customTitle = document.getElementById('archiveSessionTitle').value.trim() || examData.title || '未命名測驗';
  const autoSendEmail = document.getElementById('archiveAutoSendEmail').checked;
  const clearCurrent = document.getElementById('archiveClearCurrent').checked;

  closeArchiveSessionModal();

  // 歸檔時一併關閉當前測驗開放狀態
  examData.isExamOpen = false;
  saveExamDataToStorage(true);

  // 若勾選歸檔同時自動寄送成績信給尚未收到信的考生
  if (autoSendEmail) {
    const unsentSubs = submissions.filter(s => s.studentEmail && s.studentEmail.includes('@') && !s.emailSentAt);
    if (unsentSubs.length > 0) {
      await dispatchScoreEmails('CURRENT', unsentSubs, {
        title: examData.title,
        examDate: examData.examDate,
        questions: examData.questions,
        submissions: submissions
      });
    }
  }

  const newHist = createAndSaveHistorySession(customTitle, clearCurrent, null);
  switchExaminerTab('tabHistory');
  viewHistorySessionDetail(newHist.id);
  showToast(`🗂️ 已結束測驗並將「${customTitle}」儲存至歷次測驗紀錄！`);
}

function createAndSaveHistorySession(sessionTitle, clearCurrent = true, newExamData = null) {
  const stats = calculateStatsForList(submissions);
  const archivedRecord = {
    id: 'HIST_' + Date.now(),
    sessionTitle: sessionTitle || examData.title || '未命名測驗',
    examTitle: examData.title || '未命名測驗',
    examDate: examData.examDate || '-',
    durationMinutes: examData.durationMinutes,
    archivedAt: formatDateTime(new Date()),
    questionsSnapshot: JSON.parse(JSON.stringify(examData.questions)),
    submissions: JSON.parse(JSON.stringify(submissions)),
    stats: stats
  };

  historySessions.unshift(archivedRecord);
  localStorage.setItem(STORAGE_KEYS.HISTORY_SESSIONS, JSON.stringify(historySessions));

  if (clearCurrent) {
    submissions = [];
    localStorage.setItem(STORAGE_KEYS.SUBMISSIONS, JSON.stringify(submissions));
  }

  if (newExamData) {
    examData = newExamData;
    localStorage.setItem(STORAGE_KEYS.EXAM_DATA, JSON.stringify(examData));
  }

  if (getActiveGasUrl()) {
    postToCloud({
      action: 'archiveSession',
      historyRecord: archivedRecord,
      clearCurrent: clearCurrent,
      newExamData: newExamData || examData
    });
  }

  refreshExaminerAllViews();
  return archivedRecord;
}

function renderExaminerHistoryTab() {
  const countEl = document.getElementById('tabHistoryCount');
  if (countEl) countEl.textContent = historySessions.length;

  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (historySessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color: var(--text-muted); padding: 28px;">目前尚無封存的歷次測驗紀錄。於每次考試結束後點擊「📌 結束本場測驗並歸檔至歷史紀錄」，即可將每一次測驗結果獨立保存於此！</td></tr>`;
    return;
  }

  historySessions.forEach((hist, idx) => {
    const st = hist.stats || calculateStatsForList(hist.submissions || []);
    const qLen = hist.questionsSnapshot ? hist.questionsSnapshot.length : 0;
    const subLen = hist.submissions ? hist.submissions.length : 0;

    const tr = document.createElement('tr');
    if (currentViewingHistoryId === hist.id) {
      tr.style.background = 'var(--primary-tint)';
    }

    tr.innerHTML = `
      <td>
        <strong>#${historySessions.length - idx}</strong>
        <div class="text-muted text-sm">${escapeHtml(hist.archivedAt)}</div>
      </td>
      <td><strong>${escapeHtml(hist.sessionTitle || hist.examTitle)}</strong></td>
      <td>${escapeHtml(hist.examDate || '-')}</td>
      <td>${qLen} 題</td>
      <td><strong>${subLen} 人</strong></td>
      <td><strong style="color:var(--primary);">${st.mean} 分</strong></td>
      <td><strong style="color:var(--accent-dark);">${st.median} 分</strong></td>
      <td>${st.stdDev}</td>
      <td><span class="badge ${st.passRate >= 60 ? 'badge-teal' : 'badge-danger'}">${st.passRate}%</span></td>
      <td>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-sm" onclick="viewHistorySessionDetail('${hist.id}')">🔍 檢視本場次明細</button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="exportScoresToExcel('${hist.id}')">📥 匯出報表</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="sendAllScoresEmail('${hist.id}')">📩 寄送成績單</button>
          <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteHistorySession('${hist.id}')">刪除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function viewHistorySessionDetail(histId) {
  const hist = historySessions.find(h => h.id === histId);
  if (!hist) return;

  currentViewingHistoryId = histId;
  renderExaminerHistoryTab();

  const detailCard = document.getElementById('historySessionDetailCard');
  detailCard.classList.remove('hidden');

  const subs = hist.submissions || [];
  const questions = hist.questionsSnapshot || [];
  const st = calculateStatsForList(subs);

  document.getElementById('histDetailTitle').textContent = hist.sessionTitle || hist.examTitle;
  document.getElementById('histDetailMeta').textContent = `考試日期：${hist.examDate || '-'} ｜ 歸檔時間：${hist.archivedAt} ｜ 題數：${questions.length} 題`;

  document.getElementById('btnHistSendAllEmail').onclick = () => sendAllScoresEmail(hist.id);
  document.getElementById('btnHistExportExcel').onclick = () => exportScoresToExcel(hist.id);

  document.getElementById('histStatTotal').textContent = `${subs.length} 人`;
  document.getElementById('histStatForced').textContent = `強制終止：${st.forcedCount} 人`;
  document.getElementById('histStatMean').textContent = `${st.mean} 分`;
  document.getElementById('histStatStdDev').textContent = `標準差：${st.stdDev}`;
  document.getElementById('histStatMedian').textContent = `${st.median} 分`;
  document.getElementById('histStatPassRate').textContent = `及格率 (≥60分)：${st.passRate}%`;
  document.getElementById('histStatMaxMin').textContent = subs.length > 0 ? `${st.max} / ${st.min}` : '- / -';

  renderErrorRankingIntoContainer(
    document.getElementById('histErrorRankingList'),
    questions,
    subs
  );
  renderDistributionIntoContainer(
    document.getElementById('histDistributionChart'),
    subs
  );

  const tbody = document.getElementById('histScoresTableBody');
  tbody.innerHTML = '';
  subs.forEach(sub => {
    tbody.appendChild(buildSubmissionRowElement(sub, hist.id));
  });

  detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeHistorySessionDetail() {
  currentViewingHistoryId = null;
  document.getElementById('historySessionDetailCard').classList.add('hidden');
  renderExaminerHistoryTab();
}

function deleteHistorySession(histId) {
  if (!confirm('確定要永久刪除此筆歷史測驗紀錄嗎？此操作無法復原！')) return;
  historySessions = historySessions.filter(h => h.id !== histId);
  if (currentViewingHistoryId === histId) {
    closeHistorySessionDetail();
  }
  saveHistorySessionsToStorage(true);
  refreshExaminerAllViews();
}

// ==================== 匯出考試成績與錯題統計成 Excel (.xlsx) ====================
function getCellDisplayWidth(val) {
  if (val === null || val === undefined) return 0;
  const lines = String(val).split(/\r?\n/);
  let maxLineLen = 0;
  lines.forEach(line => {
    let len = 0;
    for (const ch of line) {
      len += ch.charCodeAt(0) > 255 ? 2.1 : 1;
    }
    if (len > maxLineLen) maxLineLen = len;
  });
  return Math.ceil(maxLineLen);
}

function autoFitWorksheetColumns(rows, worksheet, minWidth = 10, maxWidth = 90) {
  if (!rows || rows.length === 0 || !worksheet) return;
  const colCount = rows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);
  const cols = [];
  for (let c = 0; c < colCount; c++) {
    let maxW = minWidth;
    for (let r = 0; r < rows.length; r++) {
      const cellVal = rows[r] ? rows[r][c] : '';
      const w = getCellDisplayWidth(cellVal) + 4;
      if (w > maxW) maxW = w;
    }
    cols.push({ wch: Math.min(maxW, maxWidth) });
  }
  worksheet['!cols'] = cols;
}

function exportScoresToExcel(sessionId = 'CURRENT') {
  const sessionObj = getSessionDataById(sessionId);
  if (!sessionObj || sessionObj.submissions.length === 0) {
    alert('尚無考生成績可供匯出！');
    return;
  }

  const targetSubs = sessionObj.submissions;
  const targetQuestions = sessionObj.questions;

  const headers = [
    '編號',
    '考生姓名',
    '電子郵件 (Email)',
    '總分',
    '答對題數',
    '總題數',
    '作答耗時',
    '防作弊警告次數',
    '交卷狀態',
    '交卷時間',
    '成績信狀態'
  ];
  targetQuestions.forEach((q, idx) => {
    headers.push(`第${idx + 1}題(正解:${q.answer})`);
  });

  const scoreRows = [headers];
  targetSubs.forEach(sub => {
    const row = [
      sub.studentId || '',
      sub.studentName,
      sub.studentEmail || '',
      sub.score,
      sub.correctCount,
      sub.totalQuestions,
      sub.timeSpentFormatted,
      sub.warningCount,
      sub.status,
      sub.submittedAt,
      sub.emailSentAt ? `已寄送 (${sub.emailSentAt})` : '尚未寄送'
    ];
    targetQuestions.forEach(q => {
      const d = sub.answerDetails ? sub.answerDetails[q.id] : null;
      row.push(d ? d.selected : '未作答');
    });
    scoreRows.push(row);
  });

  const stats = calculateStatsForList(targetSubs);
  scoreRows.push([]);
  scoreRows.push(['【統計摘要】']);
  scoreRows.push(['應試人數', targetSubs.length]);
  scoreRows.push(['平均分數', stats.mean]);
  scoreRows.push(['中位數', stats.median]);
  scoreRows.push(['標準差', stats.stdDev]);
  scoreRows.push(['及格率', `${stats.passRate}%`]);

  const wsScores = XLSX.utils.aoa_to_sheet(scoreRows);
  autoFitWorksheetColumns(scoreRows, wsScores);

  const qAnalysisHeaders = ['題號', '題目內容', '標準答案', '總作答人數', '答錯人數', '答錯率(%)', '最常誤選選項'];
  const qAnalysisRows = [qAnalysisHeaders];
  const itemStats = calculateQuestionErrorStatsForList(targetQuestions, targetSubs);

  itemStats.forEach(item => {
    qAnalysisRows.push([
      `第 ${item.index} 題`,
      item.question,
      item.answerDisplay || item.answer,
      item.totalAttempts,
      item.wrongCount,
      `${item.errorRate}%`,
      item.topWrongOption || '無'
    ]);
  });

  const wsAnalysis = XLSX.utils.aoa_to_sheet(qAnalysisRows);
  autoFitWorksheetColumns(qAnalysisRows, wsAnalysis);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsScores, '考生成績總表');
  XLSX.utils.book_append_sheet(wb, wsAnalysis, '題目答錯率分析');

  XLSX.writeFile(wb, `${sessionObj.title || '線上測驗'}_成績統計報表.xlsx`);
}

// ==================== 考官端頁籤 3：測驗結果分析功能 ====================
function calculateStatsForList(targetSubmissions) {
  const count = targetSubmissions.length;
  if (count === 0) {
    return { mean: 0, median: 0, stdDev: 0, max: 0, min: 0, passRate: 0, forcedCount: 0 };
  }

  const scores = targetSubmissions.map(s => Number(s.score)).sort((a, b) => a - b);
  const sum = scores.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / count).toFixed(1));

  let median = 0;
  const mid = Math.floor(count / 2);
  if (count % 2 === 0) {
    median = Number(((scores[mid - 1] + scores[mid]) / 2).toFixed(1));
  } else {
    median = Number(scores[mid].toFixed(1));
  }

  const variance = scores.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count;
  const stdDev = Number(Math.sqrt(variance).toFixed(1));

  const max = scores[scores.length - 1];
  const min = scores[0];
  const passCount = scores.filter(s => s >= 60).length;
  const passRate = Math.round((passCount / count) * 100);
  const forcedCount = targetSubmissions.filter(s => String(s.status || '').includes('強制終止')).length;

  return { mean, median, stdDev, max, min, passRate, forcedCount };
}

function calculateQuestionErrorStatsForList(questionsList, targetSubmissions) {
  const totalStudents = targetSubmissions.length;
  const list = (questionsList || []).map((q, idx) => {
    let wrongCount = 0;
    const wrongOptionTally = {};

    targetSubmissions.forEach(sub => {
      const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
      const picked = detail ? detail.selected : '未作答';
      const isCorrect = detail ? detail.isCorrect : false;

      if (!isCorrect) {
        wrongCount++;
        wrongOptionTally[picked] = (wrongOptionTally[picked] || 0) + 1;
      }
    });

    let topWrongOption = '';
    let topWrongOptionCount = 0;
    Object.entries(wrongOptionTally).forEach(([optKey, cnt]) => {
      if (cnt > topWrongOptionCount) {
        topWrongOptionCount = cnt;
        topWrongOption = `${optKey} (${cnt}人)`;
      }
    });

    const errorRate = totalStudents > 0 ? Number(((wrongCount / totalStudents) * 100).toFixed(1)) : 0;
    const matchedOpt = (q.options || []).find(
      o => String(o.key).toUpperCase() === String(q.answer).toUpperCase()
    );
    const answerDisplay = matchedOpt && matchedOpt.text
      ? `(${q.answer}) ${matchedOpt.text}`
      : q.answer;

    // 統計各選項被選次數（供獨立檢討視窗完整呈現各選項誘答分佈）
    const optionSelectionCounts = {};
    targetSubmissions.forEach(sub => {
      const detail = sub.answerDetails ? sub.answerDetails[q.id] : null;
      const picked = detail && detail.selected ? String(detail.selected).toUpperCase() : '未作答';
      optionSelectionCounts[picked] = (optionSelectionCounts[picked] || 0) + 1;
    });

    return {
      id: q.id,
      index: idx + 1,
      question: q.question,
      imageUrl: q.imageUrl || '',
      options: q.options || [],
      answer: q.answer,
      answerDisplay,
      totalAttempts: totalStudents,
      wrongCount,
      errorRate,
      topWrongOption,
      optionSelectionCounts
    };
  });

  return list.sort((a, b) => b.errorRate - a.errorRate);
}

function renderErrorRankingIntoContainer(container, questionsList, targetSubmissions) {
  if (!container) return;
  container.innerHTML = '';

  if (targetSubmissions.length === 0 || !questionsList || questionsList.length === 0) {
    container.innerHTML = `<p class="text-muted" style="padding:16px 0;">尚無考生作答數據可供分析。</p>`;
    return;
  }

  const itemStats = calculateQuestionErrorStatsForList(questionsList, targetSubmissions);
  itemStats.forEach((item, rankIdx) => {
    const badgeClass =
      item.errorRate >= 50 ? 'badge-danger' : item.errorRate >= 25 ? 'badge-amber' : 'badge-teal';

    const div = document.createElement('div');
    div.className = 'rank-item';
    div.innerHTML = `
      <div class="rank-item-top">
        <div class="rank-q-title">
          <span class="badge badge-teal" style="margin-right:6px;">排名 #${rankIdx + 1}</span>
          <strong>第 ${item.index} 題：</strong>${escapeHtml(item.question)}
        </div>
        <span class="rank-err-badge ${badgeClass}">答錯率 ${item.errorRate}%</span>
      </div>
      <div class="bar-bg">
        <div class="bar-fill-danger" style="width: ${item.errorRate}%"></div>
      </div>
      <div class="rank-meta">
        <span>正確答案：<strong>${escapeHtml(item.answerDisplay || item.answer)}</strong></span>
        <span>答錯人數：<strong>${item.wrongCount} / ${item.totalAttempts} 人</strong></span>
        <span>最常誤選：<strong>${escapeHtml(item.topWrongOption || '無')}</strong></span>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderDistributionIntoContainer(container, targetSubmissions) {
  if (!container) return;
  const buckets = [
    { label: '90 - 100 分', min: 90, max: 100, count: 0 },
    { label: '80 - 89 分', min: 80, max: 89.99, count: 0 },
    { label: '70 - 79 分', min: 70, max: 79.99, count: 0 },
    { label: '60 - 69 分', min: 60, max: 69.99, count: 0 },
    { label: '未滿 60 分', min: 0, max: 59.99, count: 0 }
  ];

  targetSubmissions.forEach(s => {
    const sc = Number(s.score);
    const b = buckets.find(bk => sc >= bk.min && sc <= bk.max);
    if (b) b.count++;
  });

  container.innerHTML = buckets
    .map(b => {
      const pct = targetSubmissions.length > 0 ? Math.round((b.count / targetSubmissions.length) * 100) : 0;
      return `
        <div class="dist-row">
          <strong>${b.label}</strong>
          <div class="dist-bar-wrap">
            <div class="dist-bar-fill" style="width: ${pct}%"></div>
          </div>
          <span style="text-align:right;">${b.count} 人 (${pct}%)</span>
        </div>
      `;
    })
    .join('');
}

function renderExaminerAnalyticsTab() {
  const stats = calculateStatsForList(submissions);

  document.getElementById('statTotalStudents').innerHTML = `${submissions.length} <small>人</small>`;
  document.getElementById('statForcedCount').textContent = `防作弊強制終止：${stats.forcedCount} 人`;
  document.getElementById('statAverageScore').innerHTML = `${stats.mean} <small>分</small>`;
  document.getElementById('statStdDev').textContent = `標準差：${stats.stdDev}`;
  document.getElementById('statMedianScore').innerHTML = `${stats.median} <small>分</small>`;
  document.getElementById('statPassRate').textContent = `及格率 (≥60分)：${stats.passRate}%`;
  document.getElementById('statMaxMinScore').textContent =
    submissions.length > 0 ? `${stats.max} / ${stats.min}` : '- / -';

  renderErrorRankingIntoContainer(
    document.getElementById('errorRateRankingList'),
    examData.questions,
    submissions
  );

  renderDistributionIntoContainer(
    document.getElementById('scoreDistributionChart'),
    submissions
  );
}

function openErrorRankingWindow(sessionId = 'CURRENT') {
  const targetId = sessionId || 'CURRENT';
  const sessionObj = getSessionDataById(targetId);
  if (!sessionObj || !sessionObj.questions || sessionObj.questions.length === 0) {
    alert('目前題庫中尚無題目可供檢討！');
    return;
  }
  if (!sessionObj.submissions || sessionObj.submissions.length === 0) {
    alert('目前尚無考生作答數據可供檢討分析！');
    return;
  }

  const itemStats = calculateQuestionErrorStatsForList(sessionObj.questions, sessionObj.submissions);
  const stats = calculateStatsForList(sessionObj.submissions);
  const examTitle = sessionObj.title || '線上筆試測驗';
  const examDate = sessionObj.examDate || '-';

  const win = window.open('', '_blank');
  if (!win) {
    alert('瀏覽器阻擋了彈出視窗，請允許本網站開啟新視窗！');
    return;
  }

  const buildItemCardHtml = (item, rankNum) => {
    const badgeBg = item.errorRate >= 50 ? '#fee2e2' : item.errorRate >= 25 ? '#fef3c7' : '#dcfce7';
    const badgeFg = item.errorRate >= 50 ? '#991b1b' : item.errorRate >= 25 ? '#92400e' : '#166534';

    const optionsHtml = (item.options || [])
      .map(opt => {
        const keyUpper = String(opt.key).toUpperCase();
        const isCorrectOpt = keyUpper === String(item.answer).toUpperCase();
        const count = (item.optionSelectionCounts && item.optionSelectionCounts[keyUpper]) || 0;
        const pct = item.totalAttempts > 0 ? Math.round((count / item.totalAttempts) * 100) : 0;

        let optStyle = 'background:#f8fafc;border:1.5px solid #e2e8f0;color:#1e293b;';
        let tagHtml = '';
        if (isCorrectOpt) {
          optStyle = 'background:#ecfdf5;border:2px solid #16a34a;color:#065f46;font-weight:700;';
          tagHtml = `<span style="background:#16a34a;color:#ffffff;font-size:12px;padding:2px 8px;border-radius:99px;margin-left:8px;">✔ 正確答案</span>`;
        } else if (count > 0) {
          optStyle = 'background:#fff1f2;border:1.5px solid #fda4af;color:#881337;';
          tagHtml = `<span style="background:#fecdd3;color:#9f1239;font-size:12px;padding:2px 8px;border-radius:99px;margin-left:8px;font-weight:600;">誤選</span>`;
        }

        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:8px;margin-top:8px;${optStyle}">
            <div style="font-size:15.5px;line-height:1.5;">
              <span style="display:inline-block;min-width:28px;font-weight:800;">(${escapeHtml(opt.key)})</span>
              ${escapeHtml(opt.text)}
              ${tagHtml}
            </div>
            <div style="white-space:nowrap;font-size:14px;font-weight:700;">
              ${count} 人 (${pct}%)
            </div>
          </div>
        `;
      })
      .join('');

    const displayItemImg = formatGoogleDriveImageUrl(item.imageUrl);
    const itemImgHtml = displayItemImg
      ? `<div style="margin:10px 0 14px 0; text-align:center;">
           <img src="${escapeHtml(displayItemImg)}" alt="第 ${item.index} 題圖檔" ${getImageOnErrorAttr(displayItemImg)} style="max-height:240px; max-width:100%; border-radius:6px; border:1px solid #cbd5e1; cursor:zoom-in;" onclick="window.open('${escapeHtml(displayItemImg)}', '_blank')">
         </div>`
      : '';

    return `
      <div class="review-card" data-rank="${rankNum}" data-qindex="${item.index}">
        <div class="review-card-top">
          <div class="review-q-title">
            <span class="rank-pill">排名 #${rankNum}</span>
            <span class="qnum-pill">第 ${item.index} 題</span>
            <span class="q-text">${escapeHtml(item.question)}</span>
          </div>
          <span class="err-pill" style="background:${badgeBg};color:${badgeFg};">
            答錯率 ${item.errorRate}% (${item.wrongCount}/${item.totalAttempts}人)
          </span>
        </div>
        ${itemImgHtml}
        <div class="bar-track">
          <div class="bar-fill" style="width:${item.errorRate}%;"></div>
        </div>
        <div class="options-wrap">
          ${optionsHtml}
        </div>
        <div class="review-meta">
          <span>正確答案：<strong style="color:#15803d;">${escapeHtml(item.answerDisplay || item.answer)}</strong></span>
          <span>答錯人數：<strong>${item.wrongCount} / ${item.totalAttempts} 人</strong></span>
          <span>最常誤選：<strong style="color:#be123c;">${escapeHtml(item.topWrongOption || '無')}</strong></span>
        </div>
      </div>
    `;
  };

  const cardsHtml = itemStats.map((item, idx) => buildItemCardHtml(item, idx + 1)).join('');

  const docHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>題目答錯率排行榜與試題檢討 — ${escapeHtml(examTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans TC', 'Microsoft JhengHei', sans-serif;
      background: #f8f1f1;
      color: #1e293b;
      padding-bottom: 48px;
    }
    .top-header {
      background: linear-gradient(135deg, #4a0000 0%, #750000 100%);
      color: #ffffff;
      padding: 20px 28px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 14px;
    }
    .top-header h1 {
      font-size: 1.35rem;
      margin-bottom: 4px;
    }
    .top-meta {
      font-size: 0.92rem;
      opacity: 0.92;
    }
    .toolbar-btns {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn-tool {
      border: 1px solid rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.15);
      color: #ffffff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-tool:hover, .btn-tool.active {
      background: #ffffff;
      color: #750000;
    }
    .container {
      max-width: 1060px;
      margin: 24px auto;
      padding: 0 20px;
    }
    .review-card {
      background: #ffffff;
      border-radius: 12px;
      padding: 22px 24px;
      margin-bottom: 18px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
    }
    .review-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 12px;
    }
    .review-q-title {
      font-size: 1.12rem;
      font-weight: 700;
      line-height: 1.55;
      color: #0f172a;
    }
    .rank-pill {
      display: inline-block;
      background: #750000;
      color: #ffffff;
      font-size: 0.82rem;
      padding: 3px 10px;
      border-radius: 99px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .qnum-pill {
      display: inline-block;
      background: #f1f5f9;
      color: #334155;
      font-size: 0.85rem;
      padding: 3px 10px;
      border-radius: 99px;
      margin-right: 8px;
      vertical-align: middle;
    }
    .err-pill {
      white-space: nowrap;
      padding: 5px 12px;
      border-radius: 99px;
      font-size: 0.9rem;
      font-weight: 800;
    }
    .bar-track {
      width: 100%;
      height: 8px;
      background: #f1f5f9;
      border-radius: 99px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #f59e0b, #e11d48);
      border-radius: 99px;
    }
    .options-wrap {
      margin-bottom: 14px;
    }
    .review-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      padding-top: 12px;
      border-top: 1px dashed #cbd5e1;
      font-size: 0.92rem;
      color: #475569;
    }
    @media print {
      .top-header { position: static; background: #750000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .toolbar-btns { display: none; }
      body { background: #ffffff; }
      .review-card { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <header class="top-header">
    <div>
      <h1>🚨 題目答錯率排行榜與試題檢討 — ${escapeHtml(examTitle)}</h1>
      <div class="top-meta">
        考試日期：${escapeHtml(examDate)} ｜ 應試人數：${sessionObj.submissions.length} 人 ｜ 平均分數：${stats.mean} 分 ｜ 及格率：${stats.passRate}%
      </div>
    </div>
    <div class="toolbar-btns">
      <button type="button" class="btn-tool active" id="btnSortErr" onclick="sortCards('rank')">🔥 依答錯率排序 (高➔低)</button>
      <button type="button" class="btn-tool" id="btnSortQNum" onclick="sortCards('qindex')">🔢 依題號排序 (第1題➔第${sessionObj.questions.length}題)</button>
      <button type="button" class="btn-tool" onclick="window.print()">🖨️ 列印 / 匯出 PDF</button>
    </div>
  </header>
  <main class="container" id="cardsContainer">
    ${cardsHtml}
  </main>
  <script>
    function sortCards(mode) {
      const container = document.getElementById('cardsContainer');
      const cards = Array.from(container.querySelectorAll('.review-card'));
      cards.sort((a, b) => {
        return Number(a.dataset[mode]) - Number(b.dataset[mode]);
      });
      cards.forEach(c => container.appendChild(c));
      document.getElementById('btnSortErr').classList.toggle('active', mode === 'rank');
      document.getElementById('btnSortQNum').classList.toggle('active', mode === 'qindex');
    }
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(docHtml);
  win.document.close();
}

// ==================== 題目圖片放大檢視燈箱 ====================
function openImageLightbox(imgUrl, caption = '題目附圖') {
  if (!imgUrl) return;
  const formattedUrl = formatGoogleDriveImageUrl(imgUrl);
  const modal = document.getElementById('imageLightboxModal');
  const imgEl = document.getElementById('lightboxImage');
  const capEl = document.getElementById('lightboxCaption');

  if (imgEl) {
    imgEl.removeAttribute('data-fallback');
    imgEl.src = formattedUrl;
    const fileIdMatch = formattedUrl.match(/(?:d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
    if (fileIdMatch) {
      const fileId = fileIdMatch[1];
      imgEl.onerror = function () {
        if (!this.dataset.fallback) {
          this.dataset.fallback = '1';
          this.src = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
        }
      };
    } else {
      imgEl.onerror = null;
    }
  }
  if (capEl) capEl.textContent = `${caption}（點擊背景或右上角 ✕ 關閉）`;
  if (modal) modal.classList.remove('hidden');
}

function closeImageLightbox() {
  const modal = document.getElementById('imageLightboxModal');
  const imgEl = document.getElementById('lightboxImage');
  if (modal) modal.classList.add('hidden');
  if (imgEl) imgEl.src = '';
}

// ==================== 一鍵複製 Google Apps Script 後端程式碼 (Code.gs) ====================
async function copyGasBackendCode() {
  try {
    const res = await fetch('gas/Code.gs');
    if (res.ok) {
      const code = await res.text();
      await navigator.clipboard.writeText(code);
      showToast('✅ 已複製 Google Apps Script (Code.gs) 完整程式碼！請貼至 Google 試算表的 Apps Script 編輯器。');
      return;
    }
  } catch (e) { }
  alert('請開啟專案目錄下的 gas/Code.gs 檔案複製內容。');
}

// ==================== 工具函式 ====================
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m} 分 ${s} 秒`;
}

function formatDateTime(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const mm = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
