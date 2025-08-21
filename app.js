// ---- Simple SPA router (hash-based) ----
const screens=[...document.querySelectorAll('.screen')];
const tabs=[...document.querySelectorAll('.tab')];

// === Supabase init ===
const SUPABASE_URL = 'https://ofdarhkobovoixztjjcx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZGFyaGtvYm92b2l4enRqamN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNTY2NzUsImV4cCI6MjA3MDYzMjY3NX0.6d5SW_Cs3JvU1XsI5V89GOVmpyocxa5d-GBp1RHo-kc';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === Globals (must come early) ===
let followingSet = new Set();   // ← 여기로 이동
let currentActivity = null;
let selectedCourse = null;

// === Avatar (defaults & helpers) ===
const DEFAULT_AVATARS = [
  'assets/profile/running_profile.png',
  'assets/profile/cycling_profile.png',
  'assets/profile/hiking_profile.png'
];
const PLACEHOLDER_AVATAR = 'assets/profile/running_profile.png';

function getProviderAvatarFrom(meta){
  // Kakao / Google 등 공통 케이스를 모두 커버
  return meta?.avatar_url || meta?.picture || meta?.profile_image_url || meta?.thumbnail_image_url || null;
}
function setProfileAvatarUI(url){
  const img = document.getElementById('profileAvatar');
  if (img) img.src = url || PLACEHOLDER_AVATAR;
}

// ---- Mock data & feed ----
const feedEl=document.getElementById('feed');
let mockActivities = (JSON.parse(localStorage.getItem('activities') || '[]') || [])
  .map(a => ({ ...a, sport: normalizeSport(a.sport) }));

let currentNetworkTab = 'following';// 상세 화면 컨트롤/시트 참조
const btnActMore   = document.getElementById('btnActMore');
const actionSheet  = document.getElementById('actionSheet');
const asAddMedia   = document.getElementById('asAddMedia');
const asEdit       = document.getElementById('asEdit');
const asDelete     = document.getElementById('asDelete');
const asCancel     = document.getElementById('asCancel');

const editSheet    = document.getElementById('editActivitySheet');
const editTitle    = document.getElementById('editTitle');
const editNotes    = document.getElementById('editNotes');
const editFiles    = document.getElementById('editFiles');
const editGallery  = document.getElementById('editGallery');

let edit_pendingFiles = [];          // 새로 추가한 파일들 (File[])
let edit_removedExisting = new Set(); // 기존 URL 중 삭제 표시된 것들

function openSheet(el){ el?.classList.add('show'); }
function closeSheet(el){ el?.classList.remove('show'); }

// === Auth (이메일 매직링크) ===

// 1) 이메일 입력 받아 매직링크 전송
async function loginWithEmail() {
  const email = prompt('로그인할 이메일을 입력하세요');
  if (!email) return;

  // Supabase Auth 설정의 "Site URL"에 현재 사이트 주소를 넣어두면 가장 안전함
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) alert(error.message);
  else alert('이메일로 로그인 링크를 보냈어요. 메일함을 확인하세요!');
}

// 소셜 로그인 (Google/Naver/Kakao)
async function loginWithOAuth(provider){
  try{
    const { data, error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin } // 로그인 후 돌아올 주소
    });
    if (error) throw error;
    // OAuth는 보통 리다이렉트됩니다.
  }catch(e){
    alert('로그인 실패: ' + (e.message || e));
  }
}

function clearFeedCacheOnLogout(){
  followingSet = new Set();
  mockActivities = [];
  try { localStorage.removeItem('activities'); } catch(_) {}
}


// === Nickname rules ===
const MAX_NICK = 10;
const sanitizeNick = (s) => (s || '').trim().slice(0, MAX_NICK);

// 케이스 무시 정확 일치 중복 확인 + 비어있지 않은지 확인
async function isNickTaken(nick, myId){
  const { data, error } = await sb
    .from('profiles')
    .select('id')
    .ilike('display_name', sanitizeNick(nick))  // '%'' 없이 ilike => 정확일치(대소문자 무시)
    .neq('id', myId)
    .limit(1);
  if (error) return false; // 네트워크 오류 시 DB 유니크 인덱스가 최후 방어
  return (data && data.length > 0);
}

// 최초 가입 시 닉네임 자동 생성(중복이면 2,3… 숫자 붙여서 10자에 맞춤)
async function pickAvailableNick(base, myId){
  let root = sanitizeNick(base) || 'Runner';
  let cand = root;
  let n = 1;
  while (await isNickTaken(cand, myId)) {
    n++;
    const suf = String(n);
    cand = (root.slice(0, MAX_NICK - suf.length) + suf);
  }
  return cand;
}

// (추가) 내 과거 활동을 공개로 전환 (본인 것만)
async function makeMyOldActivitiesPublic(){
  const { data: { session } } = await sb.auth.getSession();
  const me = session?.user?.id;
  if (!me) return;
  await sb.from('activities')
    .update({ visibility: 'public' })
    .eq('user_id', me).is('visibility', null);
}

// (추가) 로그인 직후 한 번 실행
sb.auth.getSession().then(() => makeMyOldActivitiesPublic().catch(()=>{}));
sb.auth.onAuthStateChange((_e, session) => { if (session) makeMyOldActivitiesPublic().catch(()=>{}); });


// 2) 헤더 버튼 UI 상태 갱신 (헤더에는 '로그인'만 노출, 로그아웃은 프로필 탭으로 이동)
function setAuthUI(session){
  const btn = document.getElementById('btnAuth');
  // 헤더 우측 버튼 정책:
  // - 로그인 상태: 헤더 버튼 숨김(프로필 탭에서 로그아웃 가능)
  // - 비로그인 상태: 헤더 버튼 = '로그인' (프로필 탭으로 이동해 소셜 로그인)
  if (!btn) return;

  if (session) {
    btn.style.display = 'none';
  } else {
    btn.style.display = '';
    btn.textContent = '로그인';
    btn.onclick = () => show('profile'); // 프로필 화면으로 이동 → 소셜 로그인 노출
  }

  // 프로필 탭의 로그인/로그아웃 섹션도 함께 갱신
  updateProfileAuthSection(session);
}

function updateProfileAuthSection(session){
  const wrap      = document.getElementById('profileAuth');
  const btnLogout = document.getElementById('btnLogout');
  const provBox   = document.getElementById('loginProviders');

  if (!wrap) return;

  if (session) {
    if (btnLogout) btnLogout.style.display = '';
    if (provBox)   provBox.style.display   = 'none';
  } else {
    if (btnLogout) btnLogout.style.display = 'none';
    if (provBox)   provBox.style.display   = 'flex';
  }

  // ★ 편집 카드(닉네임/기본 종목/주간 목표) 토글
  const editCard = document.getElementById('profileEditCard');
  if (editCard) editCard.style.display = session ? '' : 'none';

  // ★ 캘린더 카드 토글 (statsCard와 그 바깥 wrapper까지 같이 숨김)
  const statsCard = document.getElementById('statsCard');
  // statsCard의 부모( row ) → 그 부모가 바깥 .card
  const statsOuter = statsCard ? statsCard.parentElement?.parentElement : null;
  if (statsCard)  statsCard.style.display  = session ? '' : 'none';
  if (statsOuter && statsOuter.classList.contains('card')) {
    statsOuter.style.display = session ? '' : 'none';
  }

  // ★ 로그아웃 시 입력/아바타도 비워서 화면에 안 보이게
  if (!session) {
    if (nickname) nickname.value = '';
    if (goal) goal.value = '';
    const avatarImg = document.getElementById('avatarImg');
    if (avatarImg) avatarImg.src = '';
    const avatarBox = document.getElementById('avatarBox') || document.getElementById('avatarPreview');
    if (avatarBox) avatarBox.style.display = 'none';
  } else {
    const avatarBox = document.getElementById('avatarBox') || document.getElementById('avatarPreview');
    if (avatarBox) avatarBox.style.display = '';
  }
}


// === Avatar picker ===
let _avatarTempSel = null;

function openAvatarSheet(){
  // 로그인 확인
  if (!window._myUid) { alert('로그인이 필요합니다'); return; }
  // 그리드 렌더 (매번 최신 썸네일로)
  const grid = document.getElementById('avatarGrid');
  if (grid){
    grid.innerHTML = DEFAULT_AVATARS.map(u => `
      <button class="btn ghost" data-avatar="${u}"
              style="padding:0;border-radius:12px;overflow:hidden;height:96px;background:#F3F4F6">
        <img src="${u}" alt="" style="width:100%;height:100%;object-fit:cover" />
      </button>
    `).join('');
    grid.querySelectorAll('[data-avatar]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        _avatarTempSel = btn.getAttribute('data-avatar');
        // 선택 표시(테두리)
        grid.querySelectorAll('[data-avatar]').forEach(b => b.style.outline='none');
        btn.style.outline = '3px solid #06B6D4';
      });
    });
  }
  if (_avatarTempSel) markAvatarSelection(_avatarTempSel);
  openSheet(document.getElementById('avatarSheet'));
}

function markAvatarSelection(url){
  const grid = document.getElementById('avatarGrid');
  if (!grid) return;
  // 모든 아웃라인 제거
  grid.querySelectorAll('[data-avatar]').forEach(b => b.style.outline = 'none');

  // 이미 타일이 있으면 하이라이트만
  let btn = Array.from(grid.querySelectorAll('[data-avatar]'))
    .find(b => b.getAttribute('data-avatar') === url);

  // 없으면 맨 앞으로 새 타일 추가
  if (!btn) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button class="btn ghost" data-avatar="${url}"
              style="padding:0;border-radius:12px;overflow:hidden;height:96px;background:#F3F4F6">
        <img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover" />
      </button>`;
    const el = wrap.firstElementChild;
    el.addEventListener('click', ()=>{
      _avatarTempSel = url;
      markAvatarSelection(url);
    });
    grid.prepend(el);
    btn = el;
  }
  btn.style.outline = '3px solid #06B6D4';
}


async function updateProfileAvatar(url){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  // DB 업데이트
  const { error } = await sb.from('profiles')
    .update({ avatar_url: url })
    .eq('id', uid);
  if (error) { alert('저장 실패: ' + error.message); return; }

  // 로컬/화면 반영
  const p = JSON.parse(localStorage.getItem('profile') || '{}');
  localStorage.setItem('profile', JSON.stringify({ ...p, avatarUrl: url }));
  setProfileAvatarUI(url);

  closeSheet(document.getElementById('avatarSheet'));
  alert('프로필 이미지가 변경되었습니다');
}

// DB에서 코스 목록 가져오기
async function fetchCoursesFromDB() {
  const { data, error } = await sb
    .from('courses')
    .select('id,name,sport,distance_km,elev_gain_m,city,cover_url,gpx_url,created_at')
    .eq('is_public', true)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('courses fetch error', error);
    return [];
  }
  return (data || []).map(c => ({
    id: c.id,
    name: c.name,
    sport: c.sport,
    distance: Number(c.distance_km || 0),
    elev: Number(c.elev_gain_m || 0),
    city: c.city || '',
    cover: c.cover_url || '',
    gpx: c.gpx_url
  }));
}

// 코스 화면 초기화/렌더
async function initCoursesScreen() {
  const listEl   = document.getElementById('courseList');
  const filterEl = document.getElementById('courseFilter');
  const searchEl = document.getElementById('courseSearch');

  // 1) DB에서 전체 코스 로드
  const all = await fetchCoursesFromDB();

  // 2) 검색어 상태
  let q = '';

  // 3) 렌더 함수 (종목 + 이름/도시 검색)
  function render(filter = 'all') {
    let items = (filter === 'all') ? all : all.filter(c => c.sport === filter);

    const key = (q || '').trim().toLowerCase();
    if (key) {
      items = items.filter(c =>
        (c.name || '').toLowerCase().includes(key) ||
        (c.city || '').toLowerCase().includes(key)
      );
    }

    listEl.innerHTML = items.length
      ? items.map(c => `
          <div class="card">
            <div class="row between">
              <strong>${c.name}</strong>
              ${c.city ? `<span class="chip">${c.city}</span>` : ''}
            </div>
            <div class="muted">
              ${(c.distance || 0).toFixed(1)} km · 고도 ${Math.round(c.elev || 0)} m
            </div>
            <div class="row" style="gap:8px;margin-top:8px">
              <button class="btn" onclick="selectCourse('${c.id}')">코스 선택</button>
              <button class="btn ghost" onclick="previewCourse('${c.id}')">미리보기</button>
            </div>
          </div>
        `).join('')
      : '<div class="card muted">검색 결과가 없습니다.</div>';
  }

  // 4) GPX 로드 + 지도 그리기 공용 함수
  async function loadAndDrawGpx(gpxUrl) {
    if (!gpxUrl) { alert('GPX 경로가 없습니다.'); return; }
    
    // ★ 추가: URL에서 불필요한 <와 > 문자를 제거하여 URL을 정제합니다.
    const cleanedUrl = gpxUrl.trim().replaceAll('<', '').replaceAll('>', '');
    
    try {
      // ★ 수정: 정제된 URL을 사용합니다.
      const res = await fetch(cleanedUrl);
      
      // HTTP 상태 코드가 200이 아니면 오류를 던집니다. (예: 404, 500 등)
      if (!res.ok) {
          throw new Error(`GPX 로드 실패: ${res.status} ${res.statusText}`);
      }
      
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const pts = [...doc.querySelectorAll('trkpt')].map(p => ({
        lat: parseFloat(p.getAttribute('lat')),
        lon: parseFloat(p.getAttribute('lon'))
      }));

      show('record');
      initKakaoMap();
      
      // 기존 폴리라인 제거 (만약 있다면)
      if (kakaoPolyline) {
        kakaoPolyline.setMap(null);
        kakaoPolyline = null;
      }

      drawTrackOnMap(pts, { fit: true, centerLast: true });
    } catch (e) {
      console.error('GPX 불러오기 실패:', e);
      alert('GPX 불러오기 실패');
    }
  }

// 5) 전역 핸들러 연결 (미리보기 = 모달에서 지도/정보 표시, 선택 = 기록 탭 이동)
window.previewCourse = async (id) => {
  const c = all.find(x => x.id === id);
  if (!c) return;

  // 1) 텍스트/수치 채우기
  document.getElementById('cpName').textContent = c.name || '코스 미리보기';
  document.getElementById('cpDist').textContent  = (c.distance || 0).toFixed(1);
  document.getElementById('cpElev').textContent  = Math.round(c.elev || 0);

  const cityWrap = document.getElementById('cpCityWrap');
  if (c.city) {
    cityWrap.style.display = '';
    document.getElementById('cpCity').textContent = c.city;
  } else {
    cityWrap.style.display = 'none';
  }

  // 2) 모달 열기
  const sheet = document.getElementById('coursePreviewSheet');
  sheet.classList.add('show');

  // 3) 지도 초기화 + 경로 그리기
  window.initCoursePreviewMap();

  if (c.gpx) {
    try {
      const cleanedUrl = c.gpx.trim().replaceAll('<', '').replaceAll('>', '');
      const res = await fetch(cleanedUrl);
      if (!res.ok) throw new Error('GPX 로드 실패');
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const pts = [...doc.querySelectorAll('trkpt')].map(p => ({
        lat: parseFloat(p.getAttribute('lat')),
        lon: parseFloat(p.getAttribute('lon'))
      }));
      if (pts.length) {
        window.drawCoursePreviewTrack(pts);
        // 모달이 열리고 난 뒤 한 번 더 리사이즈 트리거
        setTimeout(() => kakao.maps.event.trigger(window.cpMap, 'resize'), 120);
      }
    } catch (e) {
      console.warn('미리보기 GPX 불러오기 실패:', e);
    }
  }

  // 4) 버튼/닫기 바인딩
  document.getElementById('btnCpSelect').onclick = () => {
    window.selectedCourse = c;
    sheet.classList.remove('show');
    alert(`'${c.name}' 코스를 선택했습니다.`);
  };
  const close = () => sheet.classList.remove('show');
  document.getElementById('btnCpClose').onclick = close;
  document.getElementById('btnCloseCoursePreview').onclick = close;

  // 바깥(오버레이) 클릭하면 닫기 (모달 내부 클릭은 유지)
  sheet.onclick = (e) => {
    if (e.target === sheet) close();
  };
};



  window.selectCourse = async (id) => {
    const c = all.find(x => x.id === id);
    if (!c) return;
    selectedCourse = c;
    window.selectedCourse = c;
    await loadAndDrawGpx(c.gpx);
  };

  // 6) 이벤트
  filterEl?.addEventListener('change', e => render(e.target.value));
  searchEl?.addEventListener('input', e => {
    q = e.target.value;
    render(filterEl?.value || 'all');
  });

  // 7) 첫 렌더
  render('all');
}

// 3) 내 프로필을 보장(처음 로그인 시 row 생성/업데이트)
async function ensureProfile(user){
  // DB에 있나 확인(+ avatar_url 상태도 함께 조회)
  const { data: row } = await sb.from('profiles')
    .select('id, avatar_url')
    .eq('id', user.id)
    .single();

  const raw =
    (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) ||
    (user.email ? user.email.split('@')[0] : 'Runner');

  const providerAvatar = getProviderAvatarFrom(user.user_metadata);

  if (row) {
    // 이미 row가 있는데 avatar_url이 비어 있으면 소셜 아바타로 1회 채워줌
    if (!row.avatar_url && providerAvatar) {
      await sb.from('profiles').update({ avatar_url: providerAvatar }).eq('id', user.id);
    }
    return;
  }

  // 신규 가입 → 닉네임/아바타 함께 생성
  const display = await pickAvailableNick(raw, user.id);
  await sb.from('profiles').insert({
    id: user.id,
    display_name: display,
    avatar_url: providerAvatar || null
  });
}

async function syncProfileFromServer(){
  const { data: { session} } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return;
  const { data, error } = await sb
    .from('profiles')
    .select('display_name, avatar_url')
    .eq('id', uid)
    .single();
  if (!error && data) {
    const nick = data.display_name || '';
    const avatarUrl = data.avatar_url || null;

    if (nickname) nickname.value = nick;
    setProfileAvatarUI(avatarUrl);

    // 로컬 프로필 병합 저장(avatarUrl 유지)
    const p = JSON.parse(localStorage.getItem('profile') || '{}');
    localStorage.setItem('profile', JSON.stringify({ ...p, nickname: nick, avatarUrl }));
  }
}





// 4) 초깃값 반영 + 이후 상태 변화 구독
sb.auth.getSession().then(({ data }) => {
  setAuthUI(data.session);
  window._myUid = data.session?.user?.id || null;
  if (data.session) {
    ensureProfile(data.session.user);
    syncProfileFromServer();   // ★ 추가
  }
});

sb.auth.onAuthStateChange((_event, session) => {
  setAuthUI(session);
  window._myUid = session?.user?.id || null;
  if (session) {
    ensureProfile(session.user);
    syncProfileFromServer();   // ★ 추가
    } else {
    // 로그아웃: 피드 캐시/상태를 초기화
    clearFeedCacheOnLogout();
  }

  fetchSocialFeedFromCloud().then(renderFeed);
  refreshClubs();
});

// --- sport helpers ---
const SPORT_LABEL = {
  running: '👟Running',
  cycling: '🚲Cycling',
  hiking:  '⛰️Hiking'
};

function normalizeSport(s){
  if(!s) return 'running';
  const t = String(s).toLowerCase();
  if (t.includes('run') || s.includes('👟')) return 'running';
  if (t.includes('cycl')|| s.includes('🚲')) return 'cycling';
  if (t.includes('hik') || s.includes('⛰'))  return 'hiking';
  return 'running';
}

function prettySport(code){
  return SPORT_LABEL[normalizeSport(code)] || '👟Running';
}

function getDefaultSport(){
  // profile.defaultSport(로컬) > 온보딩(prefSport) > 'running'
  const p = JSON.parse(localStorage.getItem('profile')||'{}');
  return normalizeSport(p.defaultSport || localStorage.getItem('prefSport') || 'running');
}

function setSportPickerUI(value){
  const v = normalizeSport(value);
  document.querySelectorAll('#sportPicker .chip.select')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.sport === v));
}

// === Kakao Map ===
let kakaoMap, kakaoPolyline, mapReady = false;
let startMarker, endMarker; // ⭐ 추가: 시작/종료 마커 전역 변수

function initKakaoMap() {
  
  if (mapReady) return;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  mapEl.innerHTML = ''; // ★ 플레이스홀더 제거

  kakaoMap = new kakao.maps.Map(mapEl, {
    center: new kakao.maps.LatLng(37.5665, 126.9780), // 서울시청
    level: 5
  });
  kakaoMap.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  mapReady = true;

  // 탭 전환 후 빈화면 방지용 리사이즈 트리거
  setTimeout(() => {
    kakao.maps.event.trigger(kakaoMap, 'resize');
  }, 50);
}

// 좌표 배열([{lat, lon}])을 폴리라인으로 그리기
function drawTrackOnMap(coords, { fit = true, centerLast = true } = {}) {
  if (!mapReady || !coords?.length) return;

  // ⭐ 추가: 기존 마커 및 폴리라인 삭제
  if (kakaoPolyline) kakaoPolyline.setMap(null);
  if (startMarker) startMarker.setMap(null);
  if (endMarker) endMarker.setMap(null);

  const path = coords.map(c => new kakao.maps.LatLng(c.lat, c.lon));

  // ⭐ 폴리라인 객체 새로 생성 (기존 코드는 재활용 방식이었으나, 확실한 동작을 위해 새로 생성)
  kakaoPolyline = new kakao.maps.Polyline({
    map: kakaoMap,
    path,
    strokeWeight: 4,
    strokeOpacity: 1,
    strokeColor: '#06B6D4'
  });

  // ⭐ 추가: 시작 마커
  const startPos = path[0];
  const startImageSrc = 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/red_b.png';
  const startImageSize = new kakao.maps.Size(24, 35);
  const startMarkerImage = new kakao.maps.MarkerImage(startImageSrc, startImageSize);
  startMarker = new kakao.maps.Marker({
    map: kakaoMap,
    position: startPos,
    image: startMarkerImage,
  });

  // ⭐ 추가: 종료 마커
  const endPos = path[path.length - 1];
  const endImageSrc = 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/blue_b.png';
  const endImageSize = new kakao.maps.Size(24, 35);
  const endMarkerImage = new kakao.maps.MarkerImage(endImageSrc, endImageSize);
  endMarker = new kakao.maps.Marker({
    map: kakaoMap,
    position: endPos,
    image: endMarkerImage,
  });

  // 항상 화면을 경로에 맞춤
  if (fit) {
    const bounds = new kakao.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    kakaoMap.setBounds(bounds);
  }

  // 추가로 마지막 점으로 센터 이동하고 싶으면 옵션으로
  if (centerLast) {
    const last = path[path.length - 1];
    if (last) kakaoMap.setCenter(last);
  }
}

// 필요 시 코스 시작점으로 센터 이동
function centerTo(lat, lon) {
  if (!mapReady) return;
  kakaoMap.setCenter(new kakao.maps.LatLng(lat, lon));
}

// === Detail Map (Activity Screen) ===
let detailMap, detailPolyline, detailMapReady = false;
let detailStartMarker, detailEndMarker; // ⭐ 추가: 상세 화면용 마커 전역 변수

function initDetailMap() {
  if (detailMapReady) return;
  const el = document.getElementById('detailMap');
  if (!el) return;
  el.innerHTML = ''; // ★ 플레이스홀더 제거

  detailMap = new kakao.maps.Map(el, {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 5
  });
  detailMap.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  detailMapReady = true;

  setTimeout(() => kakao.maps.event.trigger(detailMap, 'resize'), 50);
}

function drawDetailTrack(coords) {
  if (!detailMapReady || !coords?.length) return;
  
  // ⭐ 추가: 기존 폴리라인과 마커 삭제
  if (detailPolyline) detailPolyline.setMap(null);
  if (detailStartMarker) detailStartMarker.setMap(null);
  if (detailEndMarker) detailEndMarker.setMap(null);

  const path = coords.map(c => new kakao.maps.LatLng(c.lat, c.lon));

  // ⭐ 폴리라인 객체 새로 생성
  detailPolyline = new kakao.maps.Polyline({
    map: detailMap,
    path,
    strokeWeight: 4,
    strokeOpacity: 1,
    strokeColor: '#06B6D4'
  });

  // ⭐ 추가: 시작 마커
  const startPos = path[0];
  const startImageSrc = 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/red_b.png';
  const startImageSize = new kakao.maps.Size(24, 35);
  const startMarkerImage = new kakao.maps.MarkerImage(startImageSrc, startImageSize);
  detailStartMarker = new kakao.maps.Marker({
    map: detailMap,
    position: startPos,
    image: startMarkerImage,
  });

  // ⭐ 추가: 종료 마커
  const endPos = path[path.length - 1];
  const endImageSrc = 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/blue_b.png';
  const endImageSize = new kakao.maps.Size(24, 35);
  const endMarkerImage = new kakao.maps.MarkerImage(endImageSrc, endImageSize);
  detailEndMarker = new kakao.maps.Marker({
    map: detailMap,
    position: endPos,
    image: endMarkerImage,
  });

  const bounds = new kakao.maps.LatLngBounds();
  path.forEach(p => bounds.extend(p));
  detailMap.setBounds(bounds);
}

// === Course Preview Map (in Courses tab modal) [GLOBAL] ===
window.cpMap = null;
window.cpPolyline = null;
window.cpMapReady = false;
window.cpStartMarker = null;
window.cpEndMarker = null;

window.initCoursePreviewMap = function(){
  const el = document.getElementById('coursePreviewMap');
  if (!el) return;

  // 모달 안에서 매번 새로 생성
  window.cpMap = new kakao.maps.Map(el, {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 5
  });
  window.cpMap.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  window.cpMapReady = true;

  // 시트 오픈 직후 리사이즈 반영
  setTimeout(()=> kakao.maps.event.trigger(window.cpMap, 'resize'), 50);
};

window.drawCoursePreviewTrack = function(coords){
  if (!window.cpMapReady || !coords?.length) return;

  if (window.cpPolyline) window.cpPolyline.setMap(null);
  if (window.cpStartMarker) window.cpStartMarker.setMap(null);
  if (window.cpEndMarker) window.cpEndMarker.setMap(null);

  const path = coords.map(c => new kakao.maps.LatLng(c.lat, c.lon));
  window.cpPolyline = new kakao.maps.Polyline({
    map: window.cpMap,
    path,
    strokeWeight: 4,
    strokeOpacity: 1,
    strokeColor: '#06B6D4'
  });

  const startPos = path[0];
  const endPos   = path[path.length-1];

  window.cpStartMarker = new kakao.maps.Marker({
    map: window.cpMap,
    position: startPos,
    image: new kakao.maps.MarkerImage(
      'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/red_b.png',
      new kakao.maps.Size(24, 35)
    )
  });

  window.cpEndMarker = new kakao.maps.Marker({
    map: window.cpMap,
    position: endPos,
    image: new kakao.maps.MarkerImage(
      'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/blue_b.png',
      new kakao.maps.Size(24, 35)
    )
  });

  const bounds = new kakao.maps.LatLngBounds();
  path.forEach(p => bounds.extend(p));
  window.cpMap.setBounds(bounds);
};




// 서버에서 단일 활동의 좌표만 로드
async function fetchActivityCoordsFromCloud(id){
  const { data, error } = await sb
    .from('activities')
    .select('coords_json')
    .eq('id', id)
    .single();
  if (error) { console.error('좌표 로드 실패:', error.message); return []; }
  return data?.coords_json || [];
}

// === Social feed helpers ===

// 내가 팔로우한 사용자 id + 내 id
async function fetchFollowedIds(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { followingSet = new Set(); return []; }
  const { data, error } = await sb
    .from('follows')
    .select('followee_id')
    .eq('follower_id', session.user.id);
  if (error) { console.error('팔로우 로드 실패:', error.message); followingSet = new Set(); return [session.user.id]; }
  const onlyFollowees = Array.from(new Set(data.map(r=>r.followee_id)));
  followingSet = new Set(onlyFollowees);        // ★ 전역 갱신
  return Array.from(new Set([session.user.id, ...onlyFollowees]));
}

async function followUser(userId){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { alert('로그인이 필요합니다'); return; }
  if (session.user.id === userId) return; // 자기 자신 금지
  await sb.from('follows').upsert({ follower_id: session.user.id, followee_id: userId });
  followingSet.add(userId);
  // 피드 갱신
  await fetchSocialFeedFromCloud(); 
  renderFeed();
}

async function unfollowUser(userId){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { alert('로그인이 필요합니다'); return; }
  await sb.from('follows')
    .delete()
    .eq('follower_id', session.user.id)
    .eq('followee_id', userId);
  followingSet.delete(userId);
  await fetchSocialFeedFromCloud(); 
  renderFeed();
}

async function toggleFollow(userId){
  if (followingSet.has(userId)) {
    await unfollowUser(userId);
  } else {
    await followUser(userId);
  }
  // 검색 패널/피드 모두 즉시 갱신
  await refreshNetworkPanels();
  renderFeed();
}

async function searchUsersByName(q){
  const { data: { session } } = await sb.auth.getSession();
  const me = session?.user?.id;
  if (!q || q.trim().length < 2) return []; // 2글자 이상일 때만
  const { data, error } = await sb
    .from('profiles')
    .select('id, display_name')
    .ilike('display_name', `%${q.trim()}%`)
    .limit(20);
  if (error) { console.error('검색 실패:', error.message); return []; }
  // 내 계정은 제외
  return (data || []).filter(u => u.id !== me);
}

// 내 팔로잉/팔로워 id 가져오기
async function getFollowingIds(uid){
  const { data, error } = await sb.from('follows')
    .select('followee_id')
    .eq('follower_id', uid);
  if (error) { console.error(error.message); return []; }
  return (data||[]).map(r=>r.followee_id);
}
async function getFollowerIds(uid){
  const { data, error } = await sb.from('follows')
    .select('follower_id')
    .eq('followee_id', uid);
  if (error) { console.error(error.message); return []; }
  return (data||[]).map(r=>r.follower_id);
}

// 팔로잉 패널
async function renderFollowingPanel(){
  const listEl = document.getElementById('followingList');
  if (!listEl) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { listEl.innerHTML = '<div class="muted">로그인이 필요합니다</div>'; return; }

  // 최신 상태 반영
  await fetchFollowedIds(); // followingSet 갱신

  const ids = await getFollowingIds(session.user.id);
  if (!ids.length){ listEl.innerHTML = '<div class="muted">아직 팔로잉이 없습니다</div>'; return; }

  const nameMap = await fetchProfilesMap(ids);
  listEl.innerHTML = ids.map(uid=>{
    const name = nameMap[uid] || 'Runner';
    return `
      <div class="row between card" style="padding:10px">
        <div>${name}</div>
        <button class="btn sm" data-follow="${uid}">UnFollow</button>
      </div>
    `;
  }).join('');

  // 언팔 버튼
  listEl.querySelectorAll('[data-follow]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.getAttribute('data-follow');
      await toggleFollow(id);        // 언팔
    });
  });
}

// 팔로워 패널
async function renderFollowersPanel(){
  const listEl = document.getElementById('followersList');
  if (!listEl) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { listEl.innerHTML = '<div class="muted">로그인이 필요합니다</div>'; return; }

  await fetchFollowedIds(); // followingSet 갱신

  const ids = await getFollowerIds(session.user.id);
  if (!ids.length){ listEl.innerHTML = '<div class="muted">아직 팔로워가 없습니다</div>'; return; }

  const nameMap = await fetchProfilesMap(ids);
  listEl.innerHTML = ids.map(uid=>{
    const name = nameMap[uid] || 'Runner';
    const isF = followingSet.has(uid);
    const label = isF ? 'UnFollow' : 'Follow';
    return `
      <div class="row between card" style="padding:10px">
        <div>${name}</div>
        <button class="btn sm" data-follow="${uid}">${label}</button>
      </div>
    `;
  }).join('');

  // 팔로우/언팔
  listEl.querySelectorAll('[data-follow]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.getAttribute('data-follow');
      await toggleFollow(id);
    });
  });
}

// 검색 패널 전체 새로고침
async function refreshNetworkPanels(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const f1 = document.getElementById('followingList');
    const f2 = document.getElementById('followersList');
    if (f1) f1.innerHTML = '<div class="muted">로그인이 필요합니다</div>';
    if (f2) f2.innerHTML = '<div class="muted">로그인이 필요합니다</div>';
    return;
  }
  // 팔로잉/팔로워
  await Promise.all([ renderFollowingPanel(), renderFollowersPanel() ]);

  // 검색창에 값이 있으면 결과 버튼 라벨도 최신 상태로
  const inp = document.getElementById('searchInput');
  if (inp && inp.value.trim().length >= 2) {
    const list = await searchUsersByName(inp.value);
    renderUserSearchResults(list);
  }
}

function renderUserSearchResults(list){
  const box = document.getElementById('searchResults');
  if (!box) return;
  if (!list.length){
    box.innerHTML = '<div class="muted">검색 결과 없음</div>';
    return;
  }
  box.innerHTML = list.map(u=>{
    const isF = followingSet.has(u.id);
    const label = isF ? 'UnFollow' : 'Follow';
    return `
      <div class="row between card" style="padding:10px">
        <div><strong>${u.display_name || 'Runner'}</strong></div>
        <button class="btn sm" data-follow-user="${u.id}">${label}</button>
      </div>
    `;
  }).join('');

  // 버튼 이벤트
  box.querySelectorAll('[data-follow-user]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.getAttribute('data-follow-user');
      await toggleFollow(id);                      // 서버 처리 + 상태 반영
      // 상태 반영 후 버튼 라벨 즉시 업데이트
      const nowFollow = followingSet.has(id);
      btn.textContent = nowFollow ? 'UnFollow' : 'Follow';
    });
  });
}

// 여러 사용자 프로필을 한번에 받아서 {id: display_name} 맵으로
async function fetchProfilesMap(userIds){
  if (!userIds.length) return {};
  const { data, error } = await sb
    .from('profiles')
    .select('id, display_name')
    .in('id', userIds);
  if (error) { console.error('프로필 로드 실패:', error.message); return {}; }
  const map = {};
  (data || []).forEach(p => { map[p.id] = p.display_name || 'Runner'; });
  return map;
}

// (신규) id -> {name, avatar} 맵을 한 번에 가져오기
async function fetchProfilesInfo(userIds){
  if (!userIds?.length) return { nameMap:{}, avatarMap:{} };
  const { data, error } = await sb
    .from('profiles')
    .select('id, display_name, avatar_url')
    .in('id', userIds);
  if (error) { console.error('프로필 로드 실패:', error.message); return { nameMap:{}, avatarMap:{} }; }
  const nameMap = {}, avatarMap = {};
  (data||[]).forEach(p => {
    nameMap[p.id]  = p.display_name || 'Runner';
    avatarMap[p.id]= p.avatar_url   || '';
  });
  return { nameMap, avatarMap };
}


// 좋아요 정보(총개수/내가 눌렀는지)
async function fetchLikesInfo(activityIds){
  if (!activityIds.length) return { counts:{}, mySet: new Set() };
  const { data: { session } } = await sb.auth.getSession();

  const [allLikesRes, myLikesRes] = await Promise.all([
    sb.from('activity_likes').select('activity_id').in('activity_id', activityIds),
    session
      ? sb.from('activity_likes').select('activity_id')
          .eq('user_id', session.user.id).in('activity_id', activityIds)
      : Promise.resolve({ data: [] })
  ]);

  const counts = {};
  (allLikesRes.data || []).forEach(r => { counts[r.activity_id] = (counts[r.activity_id] || 0) + 1; });
  const mySet = new Set((myLikesRes.data || []).map(r => r.activity_id));
  return { counts, mySet };
}

// 팔로우 + 내 활동으로 피드 구성
async function fetchSocialFeedFromCloud(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    clearFeedCacheOnLogout();
    return;
  }

  const ids = await fetchFollowedIds();
  if (!ids.length) {
    clearFeedCacheOnLogout();
    return;
  }
  const { data, error } = await sb
    .from('activities')
    .select('id,title,sport,distance_km,duration_s,started_at,user_id,images_json,notes')
    .in('user_id', ids)
    .order('started_at', { ascending: false })
    .limit(100);

  if (error) { console.error('피드 로드 실패:', error.message); return; }

  const userIds = Array.from(new Set(data.map(a => a.user_id)));
  const { nameMap: profileMap, avatarMap } = await fetchProfilesInfo(userIds);
  const actIds = data.map(a => a.id);
  const { counts, mySet } = await fetchLikesInfo(actIds);
   const commentCounts = await fetchCommentCounts(actIds);

  const mapped = data.map(a => ({
    id: a.id,
    title: a.title || '활동',
    sport: normalizeSport(a.sport || 'running'),
    distance: Number(a.distance_km ?? 0),
    duration: a.duration_s ?? 0,
    date: new Date(a.started_at).getTime(),
    coords: [],
    user_id: a.user_id,
    authorName: profileMap[a.user_id] || 'Runner',
    authorAvatar: avatarMap[a.user_id] || '',
    likesCount: counts[a.id] || 0,
    likedByMe: mySet.has(a.id),
    commentsCount: commentCounts[a.id] || 0,
    images: Array.isArray(a.images_json) ? a.images_json : [], // ★ 이미지 URL 배열
    notes: a.notes || ''                                     // ★ 메모
  }));

  localStorage.setItem('activities', JSON.stringify(mapped)); // 오프라인용
  mockActivities = mapped; // ★ 화면 데이터 갱신
}

async function toggleLike(activityId){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { alert('로그인이 필요합니다'); return; }

  const idx = mockActivities.findIndex(a => a.id === activityId);
  if (idx < 0) return;
  const a = mockActivities[idx];

  if (a.likedByMe){
    await sb.from('activity_likes')
      .delete()
      .eq('activity_id', activityId)
      .eq('user_id', session.user.id);
    a.likedByMe = false;
    a.likesCount = Math.max(0, (a.likesCount || 0) - 1);
  } else {
    await sb.from('activity_likes').upsert({ activity_id: activityId, user_id: session.user.id });
    a.likedByMe = true;
    a.likesCount = (a.likesCount || 0) + 1;
  }
  renderFeed(); // 즉시 UI 반영
}

// 활동 삭제
async function deleteActivity(id){
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id) { alert('로그인이 필요합니다'); return; }
  if (!confirm('정말 삭제할까요?')) return;

  const { error } = await sb.from('activities')
    .delete()
    .eq('id', id).eq('user_id', session.user.id);
  if (error) { alert('삭제 실패: ' + error.message); return; }

  mockActivities = mockActivities.filter(x=>x.id !== id);
  localStorage.setItem('activities', JSON.stringify(mockActivities));
  renderFeed();
}

// 이미지 업로드 헬퍼
async function uploadImagesForActivity(activityId, files){
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id || !files?.length) return [];
  const bucket = sb.storage.from('activity-images');
  const urls = [];
  for (const f of files){
    const path = `${session.user.id}/${activityId}/${Date.now()}_${f.name}`;
    const { error } = await bucket.upload(path, f, { upsert:true, contentType: f.type });
    if (error) { console.error(error); throw error; }
    const { data } = bucket.getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

// 편집 저장
document.getElementById('btnSaveEdit')?.addEventListener('click', async ()=>{
  const a = currentActivity;
  if (!a) return;

  const title = document.getElementById('editTitle').value.trim() || '활동';
  const notes = document.getElementById('editNotes').value.trim();
  const files = [...(document.getElementById('editFiles').files||[])];

  let newUrls = [];
  if (files.length){
    try {
      newUrls = await uploadImagesForActivity(a.id, files);
    } catch(err){
      alert('이미지 업로드 실패: ' + (err?.message||err));
      return;
    }
  }
  const mergedImages = [...(a.images||[]), ...newUrls];

  // DB 업데이트
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id) { alert('로그인이 필요합니다'); return; }
  const { error } = await sb.from('activities')
    .update({ title, notes, images_json: mergedImages })
    .eq('id', a.id).eq('user_id', session.user.id);
  if (error) { alert('저장 실패: ' + error.message); return; }

  // 로컬 반영
  a.title = title;
  a.notes = notes;
  a.images = mergedImages;
  localStorage.setItem('activities', JSON.stringify(mockActivities));

  document.getElementById('editPanel').classList.remove('show');
  renderFeed();
});

// === Pace series & chart ===

// 좌표 → (시간, 페이스) 시리즈 계산 (이동 평균으로 약간 스무딩)
function computePaceSeries(coords){
  const series = [];
  if (!coords || coords.length < 2) return series;
  const startT = coords[0].time || Date.now();

  let prev = coords[0];
  let prevT = prev.time || startT;

  for (let i=1;i<coords.length;i++){
    const cur = coords[i];
    const dt = Math.max(1, Math.floor((cur.time - prevT)/1000));       // sec
    const d  = haversine({lat:prev.lat, lon:prev.lon},{lat:cur.lat, lon:cur.lon}); // m
    const v  = d / dt;                               // m/s
    const pace = v > 0 ? 1000 / v : Infinity;        // sec/km
    const tSec = Math.max(0, Math.floor((cur.time - startT)/1000));
    series.push({ t: tSec, pace });
    prev = cur; prevT = cur.time || prevT + dt*1000;
  }

  // 간단한 이동 평균(최근 5포인트)
  const w=5;
  return series.map((p,idx,arr)=>{
    const from = Math.max(0, idx - w + 1);
    const slice = arr.slice(from, idx+1);
    const avg = slice.reduce((s,x)=>s + x.pace, 0) / slice.length;
    return { t: p.t, pace: avg };
  });
}

// 캔버스에 라인 차트 렌더링
function drawPaceChart(canvas, series, durationSec){
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // 데이터가 없을 경우
  if (!series || series.length === 0){
    canvas.style.height = '0'; // 캔버스 높이를 0으로 설정
    canvas.width = 0; // 물리적 크기 초기화
    canvas.height = 0;
    return;
  }
  
  // 데이터가 있을 경우 원래 높이로 복원
  canvas.style.height = '80px'; 
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 80; // 복원된 높이 사용
  if (!cssW || !cssH) return;

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  // 3:00~15:00/km 범위로 클램프
  const clamp = s => Math.min(900, Math.max(180, s));
  const vals = series.map(p => clamp(p.pace));
  const minV = Math.min(...vals), maxV = Math.max(...vals);

  const left=36, right=cssW-10, top=10, bottom=cssH-22;

  // 가이드라인
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  for (let i=0;i<=3;i++){
    const y = top + (bottom-top)*i/3;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  }

  // 축 라벨
  const fmt=(s)=>{ if(!isFinite(s)) return '--:--'; const m=Math.floor(s/60); const sec=String(Math.round(s%60)).padStart(2,'0'); return `${m}:${sec}`; };
  ctx.fillStyle='#9ca3af'; ctx.font='11px system-ui';
  ctx.fillText(`${fmt(maxV)}/km`, 4, bottom);
  ctx.fillText(`${fmt(minV)}/km`, 4, top+10);

  // 라인
  ctx.strokeStyle = '#06B6D4'; ctx.lineWidth = 2; ctx.beginPath();
  const dur = Math.max(1, durationSec || series[series.length-1].t);
  series.forEach((p,i)=>{
    const x = left + (right-left) * (p.t / dur);
    const y = top + (bottom-top) * ((clamp(p.pace) - minV) / Math.max(1, (maxV - minV)));
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}

// === Real-time pace sparkline ===
function drawPaceSpark(canvas, series, durationSec){
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || parseInt(canvas.getAttribute('height') || '60', 10);
  if (!cssW || !cssH) return;

  canvas.width  = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  if (!series || series.length === 0) return;

  // 3:00~15:00/km 범위로 클램프
  const clamp = s => Math.min(900, Math.max(180, s));
  const vals = series.map(p => clamp(p.pace));
  const minV = Math.min(...vals), maxV = Math.max(...vals);

  const left=4, right=cssW-4, top=4, bottom=cssH-4;

  ctx.beginPath();
  const dur = Math.max(1, durationSec || series[series.length-1].t);
  series.forEach((p,i)=>{
    const x = left + (right-left) * (p.t / dur);
    const y = top + (bottom-top) * ((clamp(p.pace) - minV) / Math.max(1,(maxV-minV)));
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#06B6D4';
  ctx.stroke();
}

// 스파크라인 업데이트(라벨 포함)
function updateSparkline(){
  const canvas = document.getElementById('paceSpark');
  if (!canvas || !startedAt) return;
  const series = computePaceSeries(track);
  drawPaceSpark(canvas, series, Math.floor((Date.now()-startedAt)/1000));
  const last = series[series.length-1];
  const secPerKm = last ? last.pace : Infinity;
  document.getElementById('sparkPaceLabel').textContent =
    isFinite(secPerKm) ? `${paceStr(secPerKm)}/km` : `--'--"/km`;
}

// 캔버스 지우기 유틸(정지 시 초기화용)
function clearCanvas(canvas){
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = parseInt(canvas.getAttribute('height') || '60', 10);
  canvas.width  = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);
}

async function openActivity(id) {
  // 1) 로컬(피드 캐시)에서 먼저 찾기
  let a = mockActivities.find(x => x.id === id);

  // 2) 없으면 Supabase에서 단건 조회(fallback)
  if (!a) {
    try {
      const { data, error } = await sb
        .from('activities')
        .select('id,title,sport,distance_km,duration_s,started_at,user_id,images_json,notes,coords_json')
        .eq('id', id)
        .single();
      if (error || !data) { alert('활동을 찾을 수 없습니다'); return; }

      // 작성자 이름 맵
      const nameMap = await fetchProfilesMap([data.user_id]);

      // 피드에서 쓰는 로컬 구조로 매핑
      a = {
        id: data.id,
        title: data.title || '활동',
        sport: normalizeSport(data.sport || 'running'),
        distance: Number(data.distance_km ?? 0),
        duration: data.duration_s ?? 0,
        date: new Date(data.started_at).getTime(),
        user_id: data.user_id,
        authorName: nameMap[data.user_id] || '러너',
        images: Array.isArray(data.images_json) ? data.images_json : [],
        notes: data.notes || '',
        coords: Array.isArray(data.coords_json) ? data.coords_json : []
      };

      // 캐시에 넣어 재방문시 빠르게
      mockActivities.push(a);
      localStorage.setItem('activities', JSON.stringify(mockActivities));
    } catch (e) {
      console.error(e);
      alert('활동을 불러오지 못했습니다');
      return;
    }
  }

  // 3) 전역 현재 활동 설정
  currentActivity = a;

  // 4) 상세 화면 UI 채우기
  const chartCard        = document.getElementById('paceChartCard');
  const canvas           = document.getElementById('paceChart');
  const paceSummaryEl    = document.getElementById('paceSummary');
  const paceChartTitleEl = chartCard.querySelector('strong');

  document.getElementById('actTitle').textContent = a.title;
  document.getElementById('actSport').textContent = prettySport(a.sport);
  document.getElementById('actDate').textContent  = new Date(a.date).toLocaleString();
  document.getElementById('actDist').textContent  = a.distance.toFixed(2);
  document.getElementById('actTime').textContent  = fmtMMSS(a.duration);
  const paceSec = a.distance > 0 ? a.duration / a.distance : 0;
  document.getElementById('actPace').textContent  = a.distance > 0 ? paceStr(paceSec) : `--'--"`;

  renderActivityMedia();

  // 5) 화면 전환 + 지도 초기화
  show('activity');
  initDetailMap();

  // 좌표가 비어있으면 서버에서 한 번 더(구버전 데이터 대비)
  if (!a.coords || a.coords.length === 0) {
    a.coords = await fetchActivityCoordsFromCloud(a.id);
  }

  // 지도 그리기
  if (a.coords && a.coords.length) {
    drawDetailTrack(a.coords);
  }

  // 6) 페이스 차트
  const series = (a.coords && a.coords.length) ? computePaceSeries(a.coords) : [];
  if (series.length > 0) {
    chartCard.style.display = 'block';
    chartCard.style.padding = '16px';
    paceChartTitleEl.style.display = 'block';
    drawPaceChart(canvas, series, a.duration);

    const avgPaceSec = a.distance > 0 ? a.duration / a.distance : 0;
    paceSummaryEl.textContent = a.distance > 0 ? `${paceStr(avgPaceSec)}/km` : '--';
  } else {
    chartCard.style.display = 'block';
    chartCard.style.padding = '8px 16px';
    paceChartTitleEl.style.display = 'none';
    paceSummaryEl.textContent = '데이터가 부족합니다';
    drawPaceChart(canvas, null, 0); // 캔버스 높이 0 처리
  }

  // 7) 내 글일 때만 …(수정/삭제) 버튼 노출
  const mine = window._myUid && a.user_id === window._myUid;
  if (btnActMore) btnActMore.hidden = !mine;
}

// 뒤로가기
document.getElementById('btnBackHome')?.addEventListener('click', () => show('home'));

// GPX 내보내기
function exportGPX(activity) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="FitRoute" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${activity.title}</name><trkseg>\n`;
  const seg = activity.coords.map(p => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.time).toISOString()}</time></trkpt>`).join('\n');
  const footer = `\n</trkseg></trk>\n</gpx>`;
  const blob = new Blob([header, seg, footer], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${activity.title.replace(/\s+/g, '_')}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}
document.getElementById('btnExportGPX')?.addEventListener('click', () => {
  if (currentActivity) exportGPX(currentActivity);
});

function show(route){
  screens.forEach(s=>s.classList.toggle('active', s.dataset.route===route));
  tabs.forEach(t=>t.classList.toggle('active', t.dataset.link===route));
  location.hash = route;

  // ★ 활동 상세일 때만 상단 공용 헤더 숨김
  const appbar = document.querySelector('header.appbar');
  appbar?.classList.toggle('hidden', route !== 'home');

  // 화면별 초기화
  if (route === 'record') {
    initKakaoMap();
    if (window.kakao && kakao.maps && kakaoMap) {
      kakao.maps.event.trigger(kakaoMap, 'resize');
    }
    if (startedAt) updateSparkline(); // ★ 실행 중이면 즉시 스파크라인 갱신
  }
  if (route === 'activity') {
    initDetailMap();
    if (currentActivity && currentActivity.coords) {
      drawDetailTrack(currentActivity.coords);

      // 차트도 함께 갱신
      const canvas = document.getElementById('paceChart');
      const series = computePaceSeries(currentActivity.coords);
      drawPaceChart(canvas, series, currentActivity.duration);

      const avgPaceSec = currentActivity.distance > 0 ? currentActivity.duration / currentActivity.distance : 0;
      document.getElementById('paceSummary').textContent =
        currentActivity.distance > 0 ? `${paceStr(avgPaceSec)}/km` : '--';
    }
    if (window.kakao && kakao.maps && detailMap) {
      kakao.maps.event.trigger(detailMap, 'resize');
    }    
  }
  if (route === 'clubs') { refreshClubs(); }
  if (route === 'profile') { 
    if (window._myUid) {
    initStatsCalendar();
    renderGoalProgress();
    }  // ← 프로필 화면 열릴 때 캘린더 갱신
  }
  if (route === 'courses') {
    initCoursesScreen();
  }
}

window.addEventListener('hashchange', () => {
  const route = location.hash.replace('#','') || 'home';
  show(route);
});

document.addEventListener('DOMContentLoaded', () => {
  renderActivityMedia();   // 노트와 사진 카드 갱신
  loadProfile();
  const route = location.hash.replace('#','') || 'home';
  show(route);
  if (route === 'record') {
    initKakaoMap();
    kakao.maps.event.trigger(kakaoMap, 'resize');
  }
  if (route === 'activity') {
    initDetailMap();
    if (currentActivity && currentActivity.coords) {
      drawDetailTrack(currentActivity.coords);
    }
  }

// === Search overlay bindings ===
const panelSearch   = document.getElementById('searchPanel');
const btnOpenSearch = document.getElementById('btnSearch');
const btnCloseSearch= document.getElementById('btnCloseSearch');
const btnSearchGo   = document.getElementById('btnSearchGo');
const inpSearch     = document.getElementById('searchInput');

function openSearchPanel(){
  panelSearch?.classList.add('active');
  setTimeout(()=> inpSearch?.focus(), 50);
  refreshNetworkPanels().then(()=> switchNetworkTab(currentNetworkTab)); // ← 렌더 후 탭 상태 유지
}

function switchNetworkTab(which){
  const root = document.getElementById('searchPanel');
  if (!root) return;
  root.querySelectorAll('.ntab')
    .forEach(b => b.classList.toggle('active', b.dataset.ntab === which));
  root.querySelectorAll('.npanel')
    .forEach(p => p.classList.toggle('active', p.dataset.ntab === which));
  currentNetworkTab = which;
}

// 탭 클릭
document.getElementById('tabFollowing')?.addEventListener('click', ()=>{
  switchNetworkTab('following');
});
document.getElementById('tabFollowers')?.addEventListener('click', ()=>{
  switchNetworkTab('followers');
});

function closeSearchPanel(){
  panelSearch?.classList.remove('active');
}

btnOpenSearch?.addEventListener('click', openSearchPanel);
btnCloseSearch?.addEventListener('click', closeSearchPanel);
// 배경 탭하면 닫힘
panelSearch?.addEventListener('click', (e)=>{
  if(e.target===panelSearch) closeSearchPanel();
});

// 검색 실행
async function runUserSearch(){
  const q = inpSearch?.value || '';
  const list = await searchUsersByName(q);
  renderUserSearchResults(list);       // 버튼 라벨은 내부에서 팔로우 상태에 맞춰 표시
}
btnSearchGo?.addEventListener('click', runUserSearch);
inpSearch?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') runUserSearch(); });

// … 버튼 -> 액션시트
btnActMore?.addEventListener('click', (e)=>{
  e.stopPropagation();
  if (!currentActivity) return;
  openSheet(actionSheet);
});

// 액션시트 버튼
asCancel?.addEventListener('click', ()=> closeSheet(actionSheet));
actionSheet?.addEventListener('click', (e)=>{
  if (e.target === actionSheet) closeSheet(actionSheet);  // 바깥 터치 닫기
});

// 수정 버튼 → 에디터 시트 열기(값 채우기)
asEdit?.addEventListener('click', () => {
  closeSheet(actionSheet);
  if (!currentActivity) return;

  // 폼 값 채우기
  editTitle.value = currentActivity.title || '';
  editNotes.value = currentActivity.notes || '';

  // ✅ 선택 상태 초기화
  edit_pendingFiles = [];
  edit_removedExisting = new Set();
  if (editFiles) editFiles.value = '';   // 같은 파일 다시 선택 가능하도록 인풋도 비움

  // ✅ 상태 기반으로 갤러리 1번만 렌더
  renderEditGallery();

  // 마지막에 시트 열기
  openSheet(editSheet);
});

// 에디터 취소/저장
document.getElementById('btnEditCancel')?.addEventListener('click', ()=> closeSheet(editSheet));

// 파일 선택 미리보기
editFiles?.addEventListener('change', ()=>{
  // 새로 선택한 파일 미리보기 추가(기존 이미지는 유지)
  renderEditGallery(currentActivity.images || [], Array.from(editFiles.files || []));
});

editGallery?.addEventListener('click', (e)=>{
  const btn = e.target.closest('.del');
  if (!btn) return;
  const type = btn.getAttribute('data-remove');
  if (type === 'existing'){
    edit_removedExisting.add(btn.getAttribute('data-url'));
  }else if (type === 'new'){
    const i = Number(btn.getAttribute('data-index'));
    edit_pendingFiles.splice(i,1);
  }
  renderEditGallery();
});

function renderEditGallery(){
  const gallery = document.getElementById('editGallery');
  if (!gallery || !currentActivity) return;

  const existing = (currentActivity.images || []).filter(u => !edit_removedExisting.has(u));
  let html = '';

  // 기존 이미지
  existing.forEach(u=>{
    const safe = u.replace(/"/g,'&quot;');
    html += `<div class="thumb" style="background-image:url('${safe}')">
               <button class="del" data-remove="existing" data-url="${safe}">✕</button>
             </div>`;
  });

  // 새로 선택한 파일 미리보기
  edit_pendingFiles.forEach((f,idx)=>{
    const url = URL.createObjectURL(f);
    html += `<div class="thumb" style="background-image:url('${url}')">
               <button class="del" data-remove="new" data-index="${idx}">✕</button>
             </div>`;
  });

  gallery.innerHTML = html || '<div class="muted">선택된 사진이 없습니다</div>';
}

// 저장 처리
document.getElementById('btnEditSave')?.addEventListener('click', async ()=>{
  if (!currentActivity) return;
  const title = (editTitle.value || '활동').trim();
  const notes = (editNotes.value || '').trim();

  try{
      // 1) 기존 중에서 삭제 표시되지 않은 것만 유지
      const keepExisting = (currentActivity.images || []).filter(u => !edit_removedExisting.has(u));

      // 2) 새 파일 업로드
      const { data: { session } } = await sb.auth.getSession();
      const uid = session?.user?.id;
      let newUrls = [];
      if (uid && edit_pendingFiles.length){
        newUrls = await uploadImages(uid, currentActivity.id, edit_pendingFiles);
      }

      // 3) 합치고 DB 저장
      const images = [...keepExisting, ...newUrls];

      const { error } = await sb.from('activities')
        .update({ title, notes, images_json: images })
        .eq('id', currentActivity.id);
      if (error) throw error;

      // 4) 로컬 상태 반영
      currentActivity.title  = title;
      currentActivity.notes  = notes;
      currentActivity.images = images;
      const i = mockActivities.findIndex(a => a.id === currentActivity.id);
      if (i > -1) mockActivities[i] = { ...mockActivities[i], title, images, notes };
      localStorage.setItem('activities', JSON.stringify(mockActivities));

      // 5) 화면 갱신
      renderActivityMedia();   // 상세 카드 즉시 업데이트
      renderFeed();
      closeSheet(editSheet);
      alert('수정되었습니다');
  }catch(e){
    console.error(e);
    alert('수정 실패: ' + (e.message || e));
  }
});

// 스토리지 업로드 유틸
async function uploadImages(uid, activityId, files){
  const bucket = sb.storage.from('activity-images');
  const urls = [];
  for (const file of files){
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${uid}/${activityId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await bucket.upload(path, file, { upsert:true, contentType: file.type });
    if (error) throw error;
    const { data } = bucket.getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

// === Avatar upload (Supabase Storage: avatars) ===
async function uploadAvatarFile(file){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) throw new Error('로그인이 필요합니다');

  // 간단 용량 제한 (5MB)
  if (file.size > 5 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (최대 5MB)');

  const bucket = sb.storage.from('avatars');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${uid}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await bucket.upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;

  const { data } = bucket.getPublicUrl(path);
  return data.publicUrl; // 업로드된 파일의 퍼블릭 URL
}


asDelete?.addEventListener('click', async ()=>{
  closeSheet(actionSheet);
  if (!currentActivity) return;
  if (!confirm('정말 삭제할까요?')) return;

  try{
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;

    // 1) 활동 삭제
    await sb.from('activities').delete().eq('id', currentActivity.id);

    // 2) 이미지 폴더 정리(있다면)
    if (uid){
      const base = `${uid}/${currentActivity.id}`;
      const bucket = sb.storage.from('activity-images');
      const { data: list } = await bucket.list(base);
      if (Array.isArray(list) && list.length){
        await bucket.remove(list.map(it => `${base}/${it.name}`));
      }
    }

    // 3) 로컬/화면 갱신
    mockActivities = mockActivities.filter(a => a.id !== currentActivity.id);
    localStorage.setItem('activities', JSON.stringify(mockActivities));
    renderFeed();
    show('home');
    alert('삭제되었습니다');
  }catch(e){
    console.error(e);
    alert('삭제 실패: ' + (e.message || e));
  }
});

asAddMedia?.addEventListener('click', ()=>{
  closeSheet(actionSheet);
  if (!currentActivity) return;
  editTitle.value = currentActivity.title || '';
  editNotes.value = currentActivity.notes || '';
  renderEditGallery(currentActivity.images || []);
  openSheet(editSheet);
  setTimeout(()=> editFiles?.click(), 50); // 파일 선택창 바로 띄우기(선택)
});


document.getElementById('btnPickPhotos')?.addEventListener('click', ()=> editFiles?.click());
document.getElementById('btnClearNew')?.addEventListener('click', ()=>{
  edit_pendingFiles = [];
  renderEditGallery();
});
editFiles?.addEventListener('change', ()=>{
  const files = Array.from(editFiles.files || []);
  if (files.length) edit_pendingFiles.push(...files);
  editFiles.value = ''; // 같은 파일 다시 선택 가능하게
  renderEditGallery();
});

document.getElementById('btnShareActivity')?.addEventListener('click', async () => {
  // 공유용 URL (필요시 활동 ID로 커스텀 구성 가능)
  const url = location.href;

  if (navigator.share) {
    try { await navigator.share({ title: 'FitRoute', url }); }
    catch(e){ /* 사용자가 취소했을 수 있음 */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    alert('링크가 복사되었습니다');
  } else {
    prompt('아래 링크를 복사하세요', url);
  }
});
refreshClubs();

// ▼ Clubs 탭 상단 All/My 탭 전환
document.getElementById('tabClubsAll')?.addEventListener('click', ()=>{
  clubsTab = 'all';
  document.getElementById('tabClubsAll')?.classList.remove('ghost');
  document.getElementById('tabClubsAll')?.classList.add('active');
  document.getElementById('tabClubsMy') ?.classList.add('ghost');
  document.getElementById('tabClubsMy') ?.classList.remove('active');
  refreshClubs('all');
});

document.getElementById('tabClubsMy')?.addEventListener('click', ()=>{
  clubsTab = 'my';
  document.getElementById('tabClubsMy') ?.classList.remove('ghost');
  document.getElementById('tabClubsMy') ?.classList.add('active');
  document.getElementById('tabClubsAll')?.classList.add('ghost');
  document.getElementById('tabClubsAll')?.classList.remove('active');
  refreshClubs('my');
});

// === 프로필 탭: 로그인/로그아웃 바인딩 ===
document.getElementById('btnLoginGoogle')?.addEventListener('click', ()=> loginWithOAuth('google'));
document.getElementById('btnLoginKakao') ?.addEventListener('click', ()=> loginWithOAuth('kakao'));
document.getElementById('authHint') ?.addEventListener('click', loginWithEmail);
document.getElementById('btnLogout')     ?.addEventListener('click', async ()=>{
  await sb.auth.signOut();
  alert('로그아웃 되었습니다');
  // 헤더/프로필 섹션 토글은 onAuthStateChange에서 자동 처리
});
  nickname?.setAttribute('maxlength', String(MAX_NICK));

// 아바타 시트 열기/닫기/저장
document.getElementById('btnChangeAvatar')?.addEventListener('click', openAvatarSheet);
document.getElementById('btnCancelAvatar')?.addEventListener('click', ()=> closeSheet(document.getElementById('avatarSheet')));
document.getElementById('btnSaveAvatar')  ?.addEventListener('click', async ()=>{
  if (!_avatarTempSel) { alert('이미지를 선택하세요'); return; }
  await updateProfileAvatar(_avatarTempSel);
});

// 내 사진에서 선택 → 파일 선택창 열기
document.getElementById('btnPickAvatar')?.addEventListener('click', ()=>{
  document.getElementById('avatarFile')?.click();
});

// 파일 선택 시 업로드 → 그리드에 즉시 선택 표시
document.getElementById('avatarFile')?.addEventListener('change', async (e)=>{
  const f = e.target.files?.[0];
  if (!f) return;
  try{
    // 업로드 먼저 수행
    const url = await uploadAvatarFile(f);
    _avatarTempSel = url;
    // 그리드에 '내 사진' 타일 추가/하이라이트
    markAvatarSelection(url);
  }catch(err){
    alert('업로드 실패: ' + (err?.message || err));
  }finally{
    e.target.value = '';
  }
});


});

tabs.forEach(t=>t.addEventListener('click',()=>show(t.dataset.link)));

function fmtTime(sec){
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  return [h,m,s].map(v=>String(v).padStart(2,'0')).join(':');
}

// 서버의 "내 활동"을 내려받아 로컬 구조로 저장(로그인시에만 동작)
async function fetchMyActivitiesFromCloud(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;

  const { data, error } = await sb
    .from('activities')
    .select('id,title,sport,distance_km,duration_s,started_at')
    .eq('user_id', session.user.id)
    .order('started_at', { ascending: false });

  if (error) { console.error('피드 로드 실패:', error.message); return; }

  // 로컬 구조로 매핑
  const mapped = data.map(a => ({
    id: a.id,
    title: a.title || '활동',
    sport: normalizeSport(a.sport || 'running'),
    distance: Number(a.distance_km ?? 0),
    duration: a.duration_s ?? 0,
    date: new Date(a.started_at).getTime(),
    coords: [] // 상세 좌표는 필요 시 별도 로드
  }));

  localStorage.setItem('activities', JSON.stringify(mapped));
  mockActivities = mapped; // ★ 메모리 상 배열도 갱신
}

function renderFeed(){
  const arr = (Array.isArray(mockActivities)?mockActivities:[])
    .slice().sort((a,b)=>b.date - a.date);

const items = arr.map(a => {
  const isLoggedIn  = Boolean(window._myUid);
  const isMe        = isLoggedIn && (a.user_id === window._myUid);
  const isFollowing = followingSet.has(a.user_id);
  const showFollowBtn = isLoggedIn && !isMe && !!a.user_id && !isFollowing;

  // ★ 사진이 있으면 첫 번째 사진, 없으면 작성자 아바타(없으면 빈 배경)
  const thumb = (a.images && a.images[0]) ? a.images[0] : (a.authorAvatar || '');
  const thumbStyle = thumb ? `background-image:url('${thumb}')` : '';

  return `
    <div class="card activity" data-id="${a.id}">
      <div class="thumb" style="${thumbStyle}"></div>
      <div class="col" style="gap:6px">
        <div class="row between">
          <strong>${a.title}</strong>
          <span class="chip">${prettySport(a.sport)}</span>
        </div>
        <div class="muted">${a.authorName || '나'} · ${a.distance.toFixed(2)} km · ${fmtTime(a.duration)}</div>
        ${a.notes ? `<div class="muted note-preview">${a.notes}</div>` : ''}
        <div class="row between">
          <div class="muted">${new Date(a.date).toLocaleString()}</div>
          <div class="row" style="gap:6px">
            ${showFollowBtn ? `<button class="btn sm" data-follow="${a.user_id}">Follow</button>` : ``}
            <button class="btn" data-comment="${a.id}" aria-label="댓글">💬 ${a.commentsCount ?? 0}</button>
            <button class="btn" data-like="${a.id}" aria-label="좋아요">${a.likedByMe ? '❤️' : '🤍'} ${a.likesCount ?? 0}</button>
          </div>
        </div>
      </div>
    </div>`;
}).join('');
 if (!window._myUid) {
   feedEl.innerHTML = '<div class="card">로그인하면 친구들의 피드를 볼 수 있어요.</div>';
 } else {
   feedEl.innerHTML = items || '<div class="card">첫 활동을 기록해보세요!</div>';
 }


  // Summary (오늘 기준)
  const start = new Date(); 
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const todayActs = (mockActivities || []).filter(a => 
    a.date >= start.getTime() && a.date < end.getTime()
  );

  const sumKm = todayActs.reduce((n,a)=> n + (a.distance || 0), 0);
  const sumSec = todayActs.reduce((n,a)=> n + (a.duration || 0), 0);

  document.getElementById('sumDistance').textContent = sumKm.toFixed(1);
  document.getElementById('sumTime').textContent = fmtTime(sumSec);
  

  // 카드 클릭 → 상세 화면 이동
  document.querySelectorAll('.activity[data-id]').forEach(el => {
  el.addEventListener('click', () => openActivity(el.getAttribute('data-id')));
});

// 팔로우/언팔로우
document.querySelectorAll('button[data-follow]').forEach(btn=>{
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    toggleFollow(btn.getAttribute('data-follow'));
  });
});

// 좋아요 클릭(버튼 클릭 시 상세로 가지 않게 stopPropagation)
document.querySelectorAll('button[data-like]').forEach(btn=>{
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    toggleLike(btn.getAttribute('data-like'));
  });
});
  // 댓글 버튼 바인딩 (상세 진입 막기 위해 stopPropagation)
  document.querySelectorAll('button[data-comment]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      openCommentSheet(btn.getAttribute('data-comment'));
    });
  });
}

fetchSocialFeedFromCloud().then(renderFeed);


let commentTargetId = null;

function closeCommentSheet(){ closeSheet(document.getElementById('commentSheet')); }

async function openCommentSheet(activityId){
  commentTargetId = activityId;
  // 피드 캐시에서 이 활동의 작성자(오너) id 가져오기
  const act = mockActivities.find(a => a.id === activityId);
  const ownerId = act?.user_id || (currentActivity?.id === activityId ? currentActivity.user_id : null);

  await renderComments(activityId, ownerId);
  openSheet(document.getElementById('commentSheet'));
}

// 댓글 목록 렌더링 (내가 쓴 댓글 || 활동 오너이면 삭제 버튼 노출)
async function renderComments(activityId, activityOwnerId = null){
  const listEl = document.getElementById('commentList');
  if (!listEl) return;

  const { data, error } = await sb
    .from('activity_comments')
    .select('id, user_id, content, created_at')
    .eq('activity_id', activityId)
    .order('created_at', { ascending: true });

  if (error) {
    listEl.innerHTML = `<div class="muted">댓글 로드 실패: ${error.message}</div>`;
    return;
  }

  // 현재 로그인 사용자
  const { data: { session } } = await sb.auth.getSession();
  const myUid = session?.user?.id || window._myUid || null;

  // activityOwnerId가 비어있으면(예: 상세화면에서 열린 경우) currentActivity로 보완
  if (!activityOwnerId && currentActivity?.id === activityId) {
    activityOwnerId = currentActivity.user_id;
  }

  const rows = data || [];
  const nameMap = await fetchProfilesMap(Array.from(new Set(rows.map(c => c.user_id))));

  if (!rows.length){
    listEl.innerHTML = `<div class="muted">아직 댓글이 없습니다. 첫 댓글을 남겨보세요!</div>`;
    return;
  }

  listEl.innerHTML = rows.map(c => {
    const name = nameMap[c.user_id] || '러너';
    const time = new Date(c.created_at).toLocaleString();
    // 삭제 권한: 내가 쓴 댓글이거나, 내가 이 활동의 주인(작성자)인 경우
    const canDelete = !!myUid && (c.user_id === myUid || activityOwnerId === myUid);
    return `
      <div class="card row between" style="padding:10px" data-cmt="${c.id}">
        <div class="col" style="gap:4px; max-width: calc(100% - 64px)">
          <div class="row between" style="gap:8px">
            <strong class="uname">${escapeHtml(name)}</strong>
            <span class="muted" style="font-size:11px">${time}</span>
          </div>
          <div style="font-size:14px; line-height:1.45; white-space:pre-wrap; word-break:break-word">
            ${escapeHtml(c.content || '')}
          </div>
        </div>
        ${canDelete ? `<button class="btn sm danger" data-delcmt="${c.id}">삭제</button>` : ``}
      </div>
    `;
  }).join('');
}

// 댓글 삭제(내가 쓴 댓글 || 내 활동의 댓글)
async function deleteComment(commentId){
  const { data: { session } } = await sb.auth.getSession();
  if (!session){ alert('로그인이 필요합니다'); return; }
  if (!confirm('댓글을 삭제할까요?')) return;

  const { error } = await sb
    .from('activity_comments')
    .delete()
    .eq('id', commentId);

  if (error){
    alert('삭제 실패: ' + error.message);
    return;
  }

  // 목록 다시 불러오기 (ownerId는 openCommentSheet에서 넘겼으므로 생략)
  await renderComments(commentTargetId);

  // 피드 카드의 댓글 수 -1 (로컬 상태도 맞춰줌)
  const idx = mockActivities.findIndex(a => a.id === commentTargetId);
  if (idx > -1){
    const now = Math.max(0, (mockActivities[idx].commentsCount || 1) - 1);
    mockActivities[idx].commentsCount = now;
    renderFeed();
  }
}


// 간단 XSS 방지
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

document.getElementById('commentSheet')?.addEventListener('click', (e)=>{
  if (e.target.id === 'commentSheet') closeCommentSheet(); // 배경 탭으로 닫기
});

document.getElementById('btnSendComment')?.addEventListener('click', sendComment);
document.getElementById('commentInput')?.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter') sendComment();
});

// 댓글 리스트에서 삭제 버튼 클릭 처리(이벤트 위임)
document.getElementById('commentList')?.addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-delcmt]');
  if (!btn) return;
  e.stopPropagation();
  const cid = btn.getAttribute('data-delcmt');
  await deleteComment(cid);
});



async function sendComment(){
  const inp = document.getElementById('commentInput');
  const content = (inp?.value || '').trim();
  if (!content) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id){ alert('로그인이 필요합니다'); return; }

  try{
    const payload = {
      activity_id: commentTargetId,
      user_id: session.user.id,
      content
    };
    const { error } = await sb.from('activity_comments').insert(payload);
    if (error) throw error;

    inp.value = '';
    await renderComments(commentTargetId);

    // 로컬 피드의 댓글 수 즉시 +1
    const idx = mockActivities.findIndex(a => a.id === commentTargetId);
    if (idx > -1){
      mockActivities[idx].commentsCount = (mockActivities[idx].commentsCount || 0) + 1;
      renderFeed();
    }
  }catch(e){
    alert('등록 실패: ' + (e.message || e));
  }
}


function renderActivityMedia(){
  if (!currentActivity) return;
  const mediaCard = document.getElementById('actMediaCard');
  const notesEl   = document.getElementById('actNotes');
  const imgsEl    = document.getElementById('actImages');

  if (!mediaCard) return;

  const images = Array.isArray(currentActivity.images) ? currentActivity.images : [];
  const hasNotes = Boolean((currentActivity.notes || '').trim());
  const hasImages = images.length > 0;

  if (notesEl) notesEl.textContent = hasNotes ? currentActivity.notes : '';
  if (imgsEl)  imgsEl.innerHTML = hasImages
      ? images.map(u => `<img src="${u}" alt="">`).join('')
      : '';

  // 둘 다 없으면 카드 감추기
  mediaCard.style.display = (hasNotes || hasImages) ? '' : 'none';
}

// === Photo Viewer ===
function openPhotoViewer(src){
  const pv = document.getElementById('photoViewer');
  const img = document.getElementById('pvImg');
  if (!pv || !img) return;
  img.src = src;
  pv.classList.add('show');
  pv.style.display = 'block';
}

function closePhotoViewer(){
  const pv = document.getElementById('photoViewer');
  if (!pv) return;
  pv.classList.remove('show');
  pv.style.display = 'none';
}

// 이미지 클릭으로 열기 + X/배경 클릭, ESC로 닫기
document.addEventListener('click', (e) => {
  const img = e.target.closest('#actImages img');
  if (img) { e.stopPropagation(); openPhotoViewer(img.src); return; }
  if (e.target.closest('[data-pv-close]')) { closePhotoViewer(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhotoViewer(); });


function setupImageViewer(){
  const viewer = document.getElementById('imageViewer');
  const ivImg  = document.getElementById('ivImg');
  const close  = () => viewer.classList.remove('show');

  document.getElementById('ivClose')?.addEventListener('click', close);
  viewer?.addEventListener('click', (e)=>{ if(e.target===viewer) close(); });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });

  // 상세 이미지 컨테이너에서 위임
  document.getElementById('actImages')?.addEventListener('click', (e)=>{
    const img = e.target.closest('img');
    if(!img) return;
    ivImg.src = img.src;
    viewer.classList.add('show');
  });
}


const courseList=document.getElementById('courseList');
// 🔍 검색 상태 & 엘리먼트
let courseSearchTerm = '';
const courseFilterEl  = document.getElementById('courseFilter');
const courseSearchEl  = document.getElementById('courseSearch');

// ---- Clubs (static) ----
// ---- Clubs (Supabase) ----
let currentClub = null; // 상세에서 활용
let clubsTab = 'all'; // 'all' | 'my'

const clubList = document.getElementById('clubList');
const btnOpenCreateClub = document.getElementById('btnOpenCreateClub');

// 생성 시트 엘리먼트
const createClubSheet   = document.getElementById('createClubSheet');
const clubNameInput     = document.getElementById('clubName');
const clubSportSelect   = document.getElementById('clubSport');
const clubDescInput     = document.getElementById('clubDesc');
const clubCoverFile     = document.getElementById('clubCoverFile');
const clubCoverPreview  = document.getElementById('clubCoverPreview');

function openCreateClub() { createClubSheet?.classList.add('show'); }
function closeCreateClub(){ createClubSheet?.classList.remove('show'); }

btnOpenCreateClub?.addEventListener('click', async ()=>{
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id || window._myUid;  // onAuthStateChange에서 넣어둔 값도 백업으로 사용
  if (!uid) { alert('로그인이 필요합니다'); return; }
  openCreateClub();
});

document.getElementById('btnCancelCreateClub')?.addEventListener('click', closeCreateClub);
document.getElementById('btnPickClubCover')?.addEventListener('click', ()=> clubCoverFile?.click());
document.getElementById('btnClearClubCover')?.addEventListener('click', ()=>{
  if (clubCoverFile) clubCoverFile.value = '';
  if (clubCoverPreview) clubCoverPreview.innerHTML = '미리보기 없음';
});
clubCoverFile?.addEventListener('change', ()=>{
  const f = clubCoverFile.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  clubCoverPreview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
});

// 스토리지 업로드 (커버)
async function uploadClubCover(file){
  if (!file) return null;
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return null;

  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();

  // RLS 정책을 'clubs/{uid}/...' 기준으로 잡았을 때를 맞춰줍니다.
  // (정책이 bucket 체크만 있고 path 조건이 없다면 이 경로여도 문제없습니다.)
  const path = `clubs/${uid}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

  const bucket = sb.storage.from('club-covers');
  const { error } = await bucket.upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data } = bucket.getPublicUrl(path);
  return data.publicUrl;
}

// 클럽 생성
document.getElementById('btnCreateClub')?.addEventListener('click', async ()=>{
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  const name = (clubNameInput.value || '').trim();
  if (!name) { alert('클럽 이름을 입력하세요'); return; }
  const sport = clubSportSelect.value || 'running';
  const desc  = (clubDescInput.value || '').trim();
  const coverFile = clubCoverFile.files?.[0] || null;

  try {
    const cover_url = await uploadClubCover(coverFile);

    // 1) clubs insert
    const { data: club, error } = await sb.from('clubs')
      .insert({ name, sport, description: desc, cover_url, owner_id: uid })
      .select('*')
      .single();
    if (error) throw error;

    // 2) 본인 멤버십(owner) 추가
    await sb.from('club_members').insert({ club_id: club.id, user_id: uid, role: 'owner' });

    // 3) UI 초기화 & 목록 새로고침
    clubNameInput.value = '';
    clubDescInput.value = '';
    clubSportSelect.value = 'running';
    if (clubCoverFile) clubCoverFile.value = '';
    clubCoverPreview.innerHTML = '미리보기 없음';

    closeCreateClub();
    await refreshClubs();
    alert('클럽이 생성되었습니다');
  } catch (e) {
    console.error(e);
    alert('생성 실패: ' + (e.message || e));
  }
});

// 1. 클럽 상세 정보와 관련 데이터를 모두 가져오는 함수
async function fetchClubData(id) {
  const { data: { session } } = await sb.auth.getSession();
  const me = session?.user?.id || null;

  // 1) 클럽 단건
  const { data: club, error: cErr } = await sb
    .from('clubs')
    .select('*')
    .eq('id', id)
    .single();
  if (cErr || !club) throw new Error('클럽 정보를 찾을 수 없습니다.');

  // 2) 멤버 로드 (임베드 없이)
  const { data: memberRows, error: mErr } = await sb
    .from('club_members')
    .select('user_id, role')
    .eq('club_id', id);
  if (mErr) console.warn('멤버 로드 실패:', mErr.message);

  const membersRaw = memberRows || [];
  const memberIds  = membersRaw.map(m => m.user_id);

  // 3) 멤버들의 활동 로드 (임베드 없이)
  let activities = [];
  if (memberIds.length) {
    const { data: acts, error: aErr } = await sb
      .from('activities')
      .select('id, user_id, title, sport, distance_km, duration_s, started_at, notes, images_json')
      .in('user_id', memberIds)
      .order('started_at', { ascending: false })
      .limit(200);
    if (aErr) console.warn('활동 로드 실패:', aErr.message);
    activities = acts || [];
  }

  // 4) 이름 맵 구성 (멤버 + 활동 작성자)
  const needNames = Array.from(new Set([...memberIds, ...activities.map(a => a.user_id)]));
  const { nameMap, avatarMap } = await fetchProfilesInfo(needNames); // { userId: display_name }

  // 5) 멤버 매핑 (role 보정 + 이름 포함)
  const members = membersRaw.map(m => {
    const isOwner = m.user_id === club.owner_id;
    const role    = m.role || (isOwner ? 'owner' : 'member');
    const display = nameMap[m.user_id] || '러너';
    return {
      user_id: m.user_id,
      role,
      name: display,
      // 렌더러 하위 호환(기존 m.profiles?.display_name 접근을 고려)
      profiles: { display_name: display }
    };
  })
  // 리더 먼저 보이도록 정렬(원하면 유지)
  .sort((a,b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0));

  // 6) 활동 매핑 (작성자 이름 포함 + 하위 호환)
  const activitiesMapped = activities.map(a => {
    const display = nameMap[a.user_id]  || '러너';
    const avatar  = avatarMap[a.user_id] || '';   
    return {
      ...a,
      authorName: display,
      authorAvatar: avatar,                       
      profiles: { display_name: display }
    };
  });

  // 7) 가입/권한
  const joined  = memberIds.includes(me || '');
  const isOwner = club.owner_id === me;

  // 8) 통계
  const totalDist = activities.reduce((sum, a) => sum + (a.distance_km || 0), 0);
  const totalTime = activities.reduce((sum, a) => sum + (a.duration_s || 0), 0);
  const actCount  = activities.length;

  // 9) 리더보드(멤버 기준 거리 합산)
  const board = {};
  members.forEach(m => { board[m.user_id] = { user_id: m.user_id, name: m.name, dist: 0 }; });
  activities.forEach(a => { if (board[a.user_id]) board[a.user_id].dist += (a.distance_km || 0); });
  const leaderboard = Object.values(board).sort((a, b) => b.dist - a.dist);

  console.log('[fetchClubData]', {
    clubId: id,
    membersCount: members.length,
    activitiesCount: activities.length
  });

  return {
    club,
    members,                   // [{ user_id, role, name, profiles:{display_name} }]
    activities: activitiesMapped,
    joined,
    isOwner,
    totalDist,
    totalTime,
    actCount,
    leaderboard               // [{ user_id, name, dist }]
  };
}


// 2. 클럽 상세 화면 열기
async function openClubDetail(id) {
  show('club');
  try {
    const data = await fetchClubData(id);
    currentClub = data.club;

    document.getElementById('clubTitle').textContent = data.club.name;
    document.getElementById('clubSportChip').textContent = prettySport(data.club.sport);
    document.getElementById('clubDescText').textContent = data.club.description || '';
    document.getElementById('clubCover').style.backgroundImage =
      data.club.cover_url ? `url('${data.club.cover_url}')` : 'none';

    document.getElementById('clubTotalDist').textContent = data.totalDist.toFixed(1);
    document.getElementById('clubTotalTime').textContent = fmtTime(data.totalTime);
    document.getElementById('clubActCount').textContent = data.actCount;

    const btnJoin   = document.getElementById('btnJoinClub');
    const btnLeave  = document.getElementById('btnLeaveClub');
    const btnEdit   = document.getElementById('btnEditClub');
    const btnDelete = document.getElementById('btnDeleteClub');

    // ✅ 오너면 가입/탈퇴 숨기고, 수정/삭제만 보이기
    if (data.isOwner) {
      btnJoin.style.display = 'none';
      btnLeave.style.display = 'none';
      btnEdit.style.display = 'inline-flex';
      btnDelete.style.display = 'inline-flex';
    } else {
      btnEdit.style.display = 'none';
      btnDelete.style.display = 'none';
      btnJoin.style.display  = data.joined ? 'none'       : 'inline-flex';
      btnLeave.style.display = data.joined ? 'inline-flex': 'none';
    }

    btnJoin.onclick   = async () => { await joinClub(data.club.id);  await openClubDetail(data.club.id); refreshClubs(); };
    btnLeave.onclick  = async () => { await leaveClub(data.club.id); await openClubDetail(data.club.id); refreshClubs(); };
    btnDelete.onclick = async () => { await deleteClub(data.club.id); };

    // ✅ 리더면 '신청' 탭 보이기 + 데이터 로드
    const reqTab = document.querySelector('.screen[data-route="club"] [data-tab="requests"]');
    if (reqTab) reqTab.style.display = data.isOwner ? 'inline-flex' : 'none';
    if (data.isOwner) await loadClubRequests(data.club.id);

    // 탭 전환
    document.querySelectorAll('.screen[data-route="club"] [data-tab]').forEach(btn => {
      btn.onclick = () => switchClubTab(btn.dataset.tab, data);
    });
    switchClubTab('feed', data);
  } catch (e) {
    alert(e.message);
    show('clubs');
  }
}


async function deleteClub(clubId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  // 권한 확인
  const { data: club, error } = await sb.from('clubs').select('owner_id').eq('id', clubId).single();
  if (error || !club) { alert('클럽을 찾을 수 없습니다'); return; }
  if (club.owner_id !== uid) { alert('삭제 권한이 없습니다'); return; }

  if (!confirm('클럽을 삭제할까요? (멤버십이 모두 해제됩니다)')) return;

  try{
    // CASCADE가 없다면 멤버십 선삭제
    await sb.from('club_members').delete().eq('club_id', clubId);

    const { error: delErr } = await sb.from('clubs').delete().eq('id', clubId);
    if (delErr) throw delErr;

    alert('클럽이 삭제되었습니다.');
    show('clubs');
    refreshClubs();
  }catch(e){
    console.error(e);
    alert('삭제 실패: ' + (e.message || e));
  }
}

// 3. 탭별 렌더링 함수
async function switchClubTab(tabName, data) {
  // 클럽 화면 루트만 대상으로
  const root = document.querySelector('.screen[data-route="club"]');
  if (!root) return;

  // 탭 버튼 active 토글
  root.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // 패널 active 토글
  root.querySelectorAll('.npanel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tab === tabName);
  });

  // 실제 내용 렌더
  if (tabName === 'feed') {
    renderClubFeed(data.activities);
  } else if (tabName === 'leaderboard') {
    renderClubLeaderboard(data.leaderboard);
  } else if (tabName === 'members') {
    renderClubMembers(data.members);
  } else if (tabName === 'requests' && data.isOwner) {
    const listEl = root?.querySelector('.npanel[data-tab="requests"] #clubReqList');
    if (listEl) listEl.innerHTML = '<div class="card muted" style="text-align:center">불러오는 중…</div>';
  await loadClubRequests(data.club.id);
  }
}


// 신청 목록 로드 + 렌더
async function loadClubRequests(clubId){
  const { data, error } = await sb
    .from('club_join_requests')
    .select('id, user_id, created_at, status')
    .eq('club_id', clubId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { console.warn(error.message); return; }
  const ids = (data||[]).map(r=>r.user_id);
  const { nameMap, avatarMap } = await fetchProfilesInfo(ids);
  renderClubRequests(data||[], nameMap, avatarMap);
}

function renderClubRequests(rows, nameMap, avatarMap){
  const root   = document.querySelector('.screen[data-route="club"] .npanel[data-tab="requests"]');
  const listEl = root?.querySelector('#clubReqList') || document.getElementById('clubReqList');
  if (!listEl) { console.warn('[renderClubRequests] #clubReqList not found'); return; }
  if (!rows.length){
    listEl.innerHTML = '<div class="card muted" style="text-align:center">대기 중인 신청이 없습니다.</div>';
    return;
  }
  listEl.innerHTML = rows.map(r => {
    const name = nameMap[r.user_id] || '러너';
    const av   = avatarMap[r.user_id] || '';
    const when = new Date(r.created_at).toLocaleString();
    return `
      <div class="row between card" style="padding:10px" data-req="${r.id}">
        <div class="row" style="gap:8px; align-items:center">
          <div style="width:28px;height:28px;border-radius:50%;background:#eee;
                      background-size:cover;background-position:center;${av?`background-image:url('${av}')`:''}">
          </div>
          <div>
            <strong>${name}</strong>
            <div class="muted" style="font-size:12px">${when}</div>
          </div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn sm" data-accept="${r.id}" data-user="${r.user_id}">수락</button>
          <button class="btn sm ghost" data-reject="${r.id}">거절</button>
        </div>
      </div>`;
  }).join('');

  // 이벤트 바인딩
  listEl.querySelectorAll('[data-accept]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const reqId = b.getAttribute('data-accept');
      const uid   = b.getAttribute('data-user');
      await approveJoinRequest(reqId, uid, currentClub.id);
      await loadClubRequests(currentClub.id);
      await openClubDetail(currentClub.id); // 통계/멤버 수 갱신
      await refreshClubs();
    });
  });
  listEl.querySelectorAll('[data-reject]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const reqId = b.getAttribute('data-reject');
      await rejectJoinRequest(reqId);
      await loadClubRequests(currentClub.id);
    });
  });
}

async function approveJoinRequest(reqId, userId, clubId){
  const { error: uErr } = await sb.from('club_join_requests')
    .update({ status:'approved', decided_at: new Date().toISOString() })
    .eq('id', reqId);
  if (uErr) { alert('수락 실패: ' + uErr.message); return; }

  // 멤버십 부여
  const { error: mErr } = await sb.from('club_members')
    .upsert({ club_id: clubId, user_id: userId, role: 'member' });
  if (mErr) { alert('멤버 추가 실패: ' + mErr.message); return; }

  alert('가입을 승인했습니다.');
}

async function rejectJoinRequest(reqId){
  const { error } = await sb.from('club_join_requests')
    .update({ status:'rejected', decided_at: new Date().toISOString() })
    .eq('id', reqId);
  if (error) alert('거절 실패: ' + error.message);
  else alert('거절했습니다.');
}

function renderClubFeed(activities) {
  const clubFeedEl = document.getElementById('clubFeed');
  if (!clubFeedEl) return;
  if (!activities.length) {
    clubFeedEl.innerHTML = '<div class="card muted" style="text-align:center">아직 활동이 없습니다.</div>';
    return;
  }

  clubFeedEl.innerHTML = activities.map(a => {
    // ★ 사진 없으면 authorAvatar 사용 (없으면 빈 문자열)
    const thumb = (a.images_json?.[0]) || a.authorAvatar || '';
    return `
      <div class="card activity" data-id="${a.id}">
        <div class="thumb" style="${thumb ? `background-image:url('${thumb}')` : ''}"></div>
        <div class="col" style="gap:6px">
          <div class="row between">
            <strong>${a.title || '활동'}</strong>
            <span class="chip">${prettySport(a.sport)}</span>
          </div>
          <div class="muted">${a.authorName} · ${(a.distance_km ?? 0).toFixed(2)} km · ${fmtTime(a.duration_s || 0)}</div>
          ${a.notes ? `<div class="muted note-preview">${a.notes}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // 카드 클릭 → 상세 열기
  clubFeedEl.querySelectorAll('.activity').forEach(el => {
    el.addEventListener('click', () => openActivity(el.dataset.id));
  });
}

function renderClubLeaderboard(leaderboard) {
  const clubLeaderboardEl = document.getElementById('clubLeaderboard');
  if (!clubLeaderboardEl) return;
  if (!leaderboard.length) {
    clubLeaderboardEl.innerHTML = '<div class="card muted" style="text-align:center">아직 랭킹 데이터가 없습니다.</div>';
    return;
  }
  clubLeaderboardEl.innerHTML = leaderboard.map((m, i) => `
    <div class="card" style="padding:12px">
      <div class="row between">
        <div class="row" style="gap:12px">
          <strong>${i + 1}</strong>
          <div>${m.name}</div>
        </div>
        <div class="row" style="gap:8px">
          <span class="muted">${m.dist.toFixed(1)} km</span>
        </div>
      </div>
    </div>
  `).join('');
}

function renderClubMembers(members) {
  const listEl = document.getElementById('clubMembers');
  if (!listEl) return;

  document.getElementById('clubMemberCount').textContent = members.length;
  if (!members.length) {
    listEl.innerHTML = '<div class="muted">아직 멤버가 없습니다.</div>';
    return;
  }

  const me = window._myUid || null;
  const ownerId = currentClub?.owner_id;

  listEl.innerHTML = members.map(m => {
    const isOwner = (m.role === 'owner') || (m.user_id === ownerId);
    const name = (m.profiles?.display_name || '러너') + (m.user_id === me ? ' (나)' : '');
    const badge = isOwner ? '👑 리더' : '멤버';
    const canKick = (ownerId === me) && (m.user_id !== ownerId);
    return `
      <div class="row between card" style="padding:10px">
        <div>${name}</div>
        <div class="row" style="gap:6px; align-items:center">
          <span class="chip" style="font-size:10px">${badge}</span>
          ${canKick ? `<button class="btn sm danger" data-kick="${m.user_id}">탈퇴</button>` : ``}
        </div>
      </div>
    `;
  }).join('');

  // 리더: 멤버 추방
  listEl.querySelectorAll('[data-kick]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if (!confirm('정말 이 멤버를 탈퇴시키겠어요?')) return;
      await kickMember(currentClub.id, btn.getAttribute('data-kick'));
      await openClubDetail(currentClub.id);
    });
  });

}

async function kickMember(clubId, userId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  // 리더 확인
  const { data: c } = await sb.from('clubs').select('owner_id').eq('id', clubId).single();
  if (c?.owner_id !== uid) { alert('리더만 가능합니다'); return; }

  const { error } = await sb.from('club_members')
    .delete().eq('club_id', clubId).eq('user_id', userId);
  if (error) { alert('탈퇴 실패: ' + error.message); return; }
  alert('멤버를 탈퇴시켰습니다.');
}


// 4. 클럽 수정 기능
const editClubSheet = document.getElementById('editClubSheet');
const editClubName = document.getElementById('editClubName');
const editClubDesc = document.getElementById('editClubDesc');
const editClubCoverFile = document.getElementById('editClubCoverFile');
const editClubCoverPreview = document.getElementById('editClubCoverPreview');

document.getElementById('btnEditClub')?.addEventListener('click', () => {
  if (!currentClub) return;
  editClubName.value = currentClub.name;
  editClubDesc.value = currentClub.description;
  editClubCoverPreview.innerHTML = currentClub.cover_url ? `<img src="${currentClub.cover_url}" alt="클럽 커버">` : '미리보기 없음';
  editClubCoverFile.value = '';
  openSheet(editClubSheet);
});

document.getElementById('btnCancelEditClub')?.addEventListener('click', () => closeSheet(editClubSheet));
document.getElementById('btnPickEditCover')?.addEventListener('click', () => editClubCoverFile.click());
editClubCoverFile.addEventListener('change', () => {
  const file = editClubCoverFile.files[0];
  if (file) {
    const url = URL.createObjectURL(file);
    editClubCoverPreview.innerHTML = `<img src="${url}" alt="클럽 커버">`;
  } else {
    editClubCoverPreview.innerHTML = '미리보기 없음';
  }
});

document.getElementById('btnSaveEditClub')?.addEventListener('click', async () => {
  if (!currentClub) return;
  const newName = editClubName.value.trim();
  const newDesc = editClubDesc.value.trim();
  const newFile = editClubCoverFile.files[0];

  try {
    let coverUrl = currentClub.cover_url;
    if (newFile) {
      coverUrl = await uploadClubCover(newFile);
    }
    const { error } = await sb.from('clubs')
      .update({ name: newName, description: newDesc, cover_url: coverUrl })
      .eq('id', currentClub.id);
    if (error) throw error;

    alert('클럽 정보가 수정되었습니다.');
    closeSheet(editClubSheet);
    openClubDetail(currentClub.id); // 상세 페이지 새로고침
    refreshClubs(); // 목록 페이지 새로고침
  } catch (e) {
    console.error(e);
    alert('수정 실패: ' + (e.message || e));
  }
});


// 클럽 목록 가져오기 (멤버수 포함)
async function fetchClubs(){
  // club_members(count) 집계 사용 (FK 있어야 동작)
  const { data, error } = await sb
    .from('clubs')
    .select('id,name,sport,description,cover_url,owner_id,created_at, club_members(count)')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return []; }

  // 현재 로그인 사용자
  const { data: { session } } = await sb.auth.getSession();
  const me = session?.user?.id || null;

  // 내가 '대기중'인 신청 set
  let pendingSet = new Set();
  if (me) {
    const { data: pend } = await sb
      .from('club_join_requests')
      .select('club_id')
      .eq('user_id', me)
      .eq('status', 'pending');
    pendingSet = new Set((pend || []).map(r => r.club_id));
  }

  // 내가 가입한 클럽 set
  let myClubSet = new Set();
  if (me) {
    const { data: rows } = await sb.from('club_members')
      .select('club_id').eq('user_id', me);
    myClubSet = new Set((rows||[]).map(r=>r.club_id));
  }

  return (data||[]).map(row => ({
    id: row.id,
    name: row.name,
    sport: normalizeSport(row.sport),
    description: row.description || '',
    cover_url: row.cover_url || '',
    member_count: row.club_members?.[0]?.count || 0,
    joined: myClubSet.has(row.id),
    pending: pendingSet.has(row.id)
  }));

}

async function refreshClubs(filter = clubsTab){
  const list = await fetchClubs();
  const filtered = (filter === 'my')
    ? list.filter(c => c.joined || c.pending)  // 내가 가입했거나 대기중인 것만
    : list;                                    // 전체
  renderClubs(filtered);
}

function renderClubs(list){
  if (!clubList) return;
  if (!list.length){
    clubList.innerHTML = '<div class="card">아직 클럽이 없습니다. “클럽 만들기”를 눌러보세요.</div>';
    return;
  }

  clubList.innerHTML = list.map(c => `
    <div class="card club-card" data-club="${c.id}">
      <div class="row between">
        <div class="col">
          <strong>${c.name}</strong>
          <div class="meta">${prettySport(c.sport)} · ${c.member_count}명</div>
        </div>
        <div class="row" style="gap:8px">
          ${c.pending
            ? `<button class="btn ghost" disabled>대기중</button>`
            : (c.joined
                ? `<button class="btn" data-my="${c.id}">내 클럽</button>`
                : `<button class="btn" data-joinreq="${c.id}">가입 신청</button>`
              )
          }
        </div>
      </div>
      ${c.description ? `<div class="muted" style="margin-top:6px">${c.description}</div>` : ''}
    </div>
  `).join('');

  // 카드 클릭 → 상세
  clubList.querySelectorAll('[data-club]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const id = el.getAttribute('data-club');
      await gateAndOpenClubDetail(id);
    });
  });


  // ★ 상세 진입 게이트: 멤버/리더만 입장, 아니면 신청 유도
async function gateAndOpenClubDetail(clubId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  // 리더면 바로 통과
  const { data: club } = await sb.from('clubs').select('owner_id').eq('id', clubId).single();
  if (club?.owner_id === uid) { await openClubDetail(clubId); return; }

  // 멤버 여부 확인
  const { data: mem } = await sb.from('club_members')
    .select('user_id').eq('club_id', clubId).eq('user_id', uid).limit(1);
  if (Array.isArray(mem) && mem.length) { await openClubDetail(clubId); return; }

  // 대기중 여부 확인
  const { data: req } = await sb.from('club_join_requests')
    .select('id').eq('club_id', clubId).eq('user_id', uid).eq('status','pending').limit(1);
  if (Array.isArray(req) && req.length) { alert('가입 신청이 대기중입니다. 승인 후 입장할 수 있어요.'); return; }

  if (confirm('이 클럽은 멤버만 볼 수 있어요. 가입 신청할까요?')) {
    await requestJoinClub(clubId);
    await refreshClubs();
  }
}
  // 가입/탈퇴 (버튼은 이벤트 버블링 막기)
  clubList.querySelectorAll('[data-joinreq]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      await requestJoinClub(btn.getAttribute('data-joinreq'));
      await refreshClubs();
    });
  });

  // 내 클럽 → 상세로 이동 (게이트 적용)
  clubList.querySelectorAll('[data-my]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.getAttribute('data-my');
      await gateAndOpenClubDetail(id);
    });
  });

}

// ★ 가입 신청 생성
async function requestJoinClub(clubId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }

  const { data: exist } = await sb.from('club_join_requests')
    .select('id').eq('club_id', clubId).eq('user_id', uid).eq('status','pending').limit(1);
  if (exist?.length) { alert('이미 대기중입니다.'); return; }

  const { error } = await sb.from('club_join_requests')
    .insert({ club_id: clubId, user_id: uid, status: 'pending' });
  if (error) { alert('신청 실패: ' + error.message); return; }
  alert('가입 신청이 접수되었습니다.');
}



// 가입/탈퇴
async function joinClub(clubId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }
  await sb.from('club_members').insert({ club_id: clubId, user_id: uid });
}

async function leaveClub(clubId){
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) { alert('로그인이 필요합니다'); return; }
  await sb.from('club_members').delete().eq('club_id', clubId).eq('user_id', uid);
}

document.getElementById('btnBackClubs')?.addEventListener('click', ()=> show('clubs'));

// 최초 로드/탭 전환 시 새로고침
async function maybeRefreshClubsOnRoute(){
  const route = location.hash.replace('#','') || 'home';
  if (route === 'clubs') await refreshClubs();
}

// === Profile Stats Calendar ===
let _cal = {
  y: null, m: null, // 0-index month
  dataMap: {},       // {'YYYY-MM-DD': {dist: number, time: number, list:[...]}}
  selKey: null
};

function ymdKey(d){ // Date -> 'YYYY-MM-DD'
  const y=d.getFullYear(), m=d.getMonth()+1, day=d.getDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// 해당 월의 내 활동 로드 후 dataMap 구성
async function loadMyMonthly(y, m){
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id) { _cal.dataMap={}; return; }

  const start = new Date(y, m, 1, 0,0,0,0);
  const end   = new Date(y, m+1, 0, 23,59,59,999);

  const { data, error } = await sb
    .from('activities')
    .select('id,title,sport,distance_km,duration_s,started_at')
    .eq('user_id', session.user.id)
    .gte('started_at', start.toISOString())
    .lte('started_at', end.toISOString())
    .order('started_at', { ascending: true });

  if (error) { console.warn('월간 활동 로드 실패:', error.message); _cal.dataMap={}; return; }

  const map = {};
  (data||[]).forEach(a=>{
    const d = new Date(a.started_at);
    const key = ymdKey(d);
    map[key] = map[key] || { dist:0, time:0, list:[] };
    map[key].dist += Number(a.distance_km || 0);
    map[key].time += Number(a.duration_s || 0);
    map[key].list.push({
      id:a.id, title:a.title||'활동', sport:normalizeSport(a.sport||'running'),
      dist:Number(a.distance_km||0), time:Number(a.duration_s||0), date:d
    });
  });
  _cal.dataMap = map;
}

// 캘린더 렌더
function renderCalendar(){
  const label = document.getElementById('calMonthLabel');
  const grid  = document.getElementById('calGrid');
  if (!label || !grid) return;

  label.textContent = `${_cal.y}.${String(_cal.m+1).padStart(2,'0')}`;

  // 6행*7열 그리드 (앞뒤 공백 포함)
  const first = new Date(_cal.y, _cal.m, 1);
  const last  = new Date(_cal.y, _cal.m+1, 0);
  const firstWeekday = first.getDay(); // 0=일
  const days = last.getDate();
  const cells = [];

  // 한 칸 크기
  const cellCss = 'width:calc((100% - 36px)/7); aspect-ratio:1/1; border-radius:8px; display:flex; align-items:center; justify-content:center; position:relative;';

  // 앞쪽 비우기
  for(let i=0;i<firstWeekday;i++) cells.push(`<div style="${cellCss} opacity:.2"></div>`);

  // 날짜 채우기
  for(let d=1; d<=days; d++){
    const key = `${_cal.y}-${String(_cal.m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const has = !!_cal.dataMap[key];
    const today = (function(){
      const now = new Date();
      return (now.getFullYear()===_cal.y && now.getMonth()===_cal.m && now.getDate()===d);
    })();

    cells.push(`
      <button class="btn ghost" data-calday="${key}" style="${cellCss}; ${today?'outline:2px solid rgba(6,182,212,.8);':''}">
        <span style="position:absolute; top:6px; right:6px; font-size:11px; opacity:.7">${d}</span>
        ${has ? `<span style="font-size:18px">🏅</span>` : ``}
      </button>
    `);
  }

  // 뒤쪽 비우기 (총 셀 42 맞추기)
  while(cells.length % 7 !== 0) cells.push(`<div style="${cellCss} opacity:.2"></div>`);

  grid.innerHTML = cells.join('');

  // 날짜 클릭 → 상세 표시
  grid.querySelectorAll('[data-calday]').forEach(btn=>{
    btn.addEventListener('click', ()=> showDayDetail(btn.getAttribute('data-calday')));
  });
}

// 날짜 상세
function showDayDetail(key){
  _cal.selKey = key;
  const box = document.getElementById('calDetail');
  if (!box) return;

  const rec = _cal.dataMap[key];
  if (!rec){
    box.innerHTML = `<div class="muted">이 날에는 활동이 없어요.</div>`;
    return;
  }

  const total = `<div class="row between" style="margin-bottom:8px">
    <strong>${key} 요약</strong>
    <span class="muted">${rec.dist.toFixed(2)} km · ${fmtTime(rec.time)}</span>
  </div>`;

  const list = rec.list.map(a=>`
    <div class="row between card" style="padding:8px; margin-top:6px">
      <div>
        <div><strong>${a.title}</strong> <span class="chip" style="margin-left:6px">${prettySport(a.sport)}</span></div>
        <div class="muted" style="font-size:12px">${a.dist.toFixed(2)} km · ${fmtTime(a.time)}</div>
      </div>
      <button class="btn sm" data-open-activity="${a.id}">보기</button>
    </div>
  `).join('');

  box.innerHTML = total + list;

  // 보기 버튼 → 활동 상세
  box.querySelectorAll('[data-open-activity]').forEach(b=>{
    b.addEventListener('click', ()=> openActivity(b.getAttribute('data-open-activity')));
  });
}

// === Weekly Goal Progress ===
function getThisWeekRange(){
  // 월요일 00:00 ~ 다음주 월요일 00:00 기준
  const now = new Date();
  const dow = now.getDay(); // 0=일
  const diffToMon = (dow + 6) % 7; // 월(1) 기준
  const start = new Date(now);
  start.setHours(0,0,0,0);
  start.setDate(start.getDate() - diffToMon);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

async function computeMyWeeklyKm(){
  const { data: { session } } = await sb.auth.getSession();
  const me = session?.user?.id || null;
  const { start, end } = getThisWeekRange();

  if (me){
    const { data, error } = await sb
      .from('activities')
      .select('distance_km, started_at')
      .eq('user_id', me)
      .gte('started_at', start.toISOString())
      .lt('started_at', end.toISOString());
    if (error) { console.warn('주간 합산 실패:', error.message); return 0; }
    return (data||[]).reduce((n,a)=> n + Number(a.distance_km||0), 0);
  }else{
    // 비로그인 fallback: 로컬 캐시 중 내 것만(있다면)
    return (mockActivities||[])
      .filter(a => a.user_id === window._myUid && a.date >= start.getTime() && a.date < end.getTime())
      .reduce((n,a)=> n + Number(a.distance||0), 0);
  }
}

async function renderGoalProgress(){
  const box = document.getElementById('goalProgress');
  const goalEl = document.getElementById('goal');
  if (!box || !goalEl) return;
  const goalVal = Number(goalEl.value || 0);

  if (!goalVal || goalVal <= 0){
    box.style.display = 'none';
    box.textContent = '';
    return;
  }

  const done = await computeMyWeeklyKm();
  const pct = Math.min(100, Math.round((done / goalVal) * 100));

  const msg =
    pct >= 100 ? '목표 달성! 최고예요 🏅' :
    pct >= 75  ? '거의 다 왔어요! 조금만 더 💪' :
    pct >= 50  ? '절반 돌파! 탄력 받았어요 🙌' :
    pct >= 25  ? '좋아요, 계속 가볼까요? 😄' :
                 '이제 출발해볼까요? 🚀';

  box.textContent = `이번 주 ${done.toFixed(1)} / ${goalVal.toFixed(1)} km · ${pct}% — ${msg}`;
  box.style.display = '';
}


// 초기화(프로필 화면 들어올 때 호출)
async function initStatsCalendar(){
  const { data: { session } } = await sb.auth.getSession();
  const statsCard = document.getElementById('statsCard');
  if (!statsCard) return;

  if (!session?.user?.id){
    // 비로그인 상태 안내
    document.getElementById('calMonthLabel').textContent = '로그인이 필요합니다';
    document.getElementById('calGrid').innerHTML = '';
    document.getElementById('calDetail').innerHTML = '<div class="muted">로그인 후 캘린더 통계를 볼 수 있어요.</div>';
    return;
  }

  const now = new Date();
  _cal.y = now.getFullYear();
  _cal.m = now.getMonth();

  await loadMyMonthly(_cal.y, _cal.m);
  renderCalendar();
  showDayDetail(ymdKey(now)); // 오늘 상세 기본 표시(데이터 있으면)
}

// 이전/다음 달
async function moveMonth(delta){
  const d = new Date(_cal.y, _cal.m + delta, 1);
  _cal.y = d.getFullYear(); _cal.m = d.getMonth();
  await loadMyMonthly(_cal.y, _cal.m);
  renderCalendar();
  // 선택일 초기화
  document.getElementById('calDetail').innerHTML = '<div class="muted">날짜를 누르면 해당 날의 거리/시간/활동을 보여줍니다.</div>';
}

const nickname=document.getElementById('nickname');
const goal=document.getElementById('goal');
function loadProfile(){
  const p = JSON.parse(localStorage.getItem('profile')||'{}');
  if(p.nickname) nickname.value = p.nickname;
  if(p.goal) goal.value = p.goal;
  if(p.avatarUrl) setProfileAvatarUI(p.avatarUrl); else setProfileAvatarUI(null);
  setSportPickerUI(getDefaultSport()); // 표준값으로 UI 반영
}

document.addEventListener('click', (e)=>{
  const btn = e.target.closest('#sportPicker .chip.select');
  if(!btn) return;
  setSportPickerUI(btn.dataset.sport);  // 소문자 키
});

document.getElementById('btnSaveProfile')?.addEventListener('click', async () => {
  const active = document.querySelector('#sportPicker .chip.select.active');
  const defaultSport = normalizeSport(active ? active.dataset.sport : getDefaultSport());
  let nick = sanitizeNick(nickname.value);

  if (!nick) { alert('닉네임을 입력하세요'); return; }
  if (nick.length > MAX_NICK) { alert(`닉네임은 최대 ${MAX_NICK}자입니다`); return; }

  // 1) 로컬 저장
const prev = JSON.parse(localStorage.getItem('profile')||'{}');
localStorage.setItem('profile', JSON.stringify({
  ...prev,
  nickname: nick,
  goal: Number(goal.value) || 0,
  defaultSport
}));

  // 2) 서버 동기화 (중복/유니크 처리)
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user?.id) {
      // 빠른 클라이언트측 중복 확인 (대소문자 무시)
      if (await isNickTaken(nick, session.user.id)) {
        alert('이미 사용 중인 닉네임입니다');
        return;
      }
      const { error } = await sb.from('profiles')
        .update({ display_name: nick })
        .eq('id', session.user.id);
      if (error) {
        // DB 유니크 인덱스가 막은 경우(동시성 등)
        if (error.code === '23505') {
          alert('이미 사용 중인 닉네임입니다');
          return;
        }
        throw error;
      }
    }
  } catch (e) {
    console.error('프로필 동기화 실패:', e);
    alert('프로필 저장 중 문제가 발생했어요.');
    return;
  }

  // 3) 피드/화면 반영
  await fetchSocialFeedFromCloud();
  renderFeed();
  await renderGoalProgress();
  alert('저장되었습니다');
});


// ---- Onboarding ----
const sheet=document.getElementById('sheet');
if(!localStorage.getItem('onboarded')) sheet.classList.add('show');
document.getElementById('btnFinishOnboarding')?.addEventListener('click',()=>{
  localStorage.setItem('prefSport', document.getElementById('prefSport').value);
  localStorage.setItem('onboarded','1');
  sheet.classList.remove('show');
});

// ---- Quick Start ----
const btnQuickStart=document.getElementById('btnQuickStart');
btnQuickStart?.addEventListener('click', ()=>{ show('record') });

// ---- Geolocation-based recorder (simple) ----
let watchId=null, startedAt=null, elapsedInt=null;
let track=[]; // [{lat,lon,time}]
const mDist=document.getElementById('mDist');
const mTime=document.getElementById('mTime');
const mPace=document.getElementById('mPace');

function haversine(a,b){
  const R=6371e3; // meters
  const toRad = x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function calcDistance(){
  let d=0; for(let i=1;i<track.length;i++){ d+=haversine(track[i-1], track[i]); }
  return d; // meters
}
function updateMetrics(){
  const sec = Math.floor((Date.now()-startedAt)/1000);
  const km = calcDistance()/1000;
  mDist.textContent = km.toFixed(2);
  mTime.textContent = fmtMMSS(sec);
  mPace.textContent = km>0? paceStr(sec/km) : "--'--\"";
  updateSparkline(); // ★ 실시간 스파크라인 갱신
}
function fmtMMSS(sec){const m=Math.floor(sec/60), s=sec%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function paceStr(secPerKm){const m=Math.floor(secPerKm/60), s=Math.round(secPerKm%60);return `${m}'${String(s).padStart(2,'0')}"`}

const btnMain = document.getElementById('btnMain');
const btnPause = document.getElementById('btnPause');

let isRunning = false;

btnPause?.addEventListener('click', ()=>{
  if (watchId) {
    // 일시정지
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    btnPause.textContent = '재개';
  } else {
    // 재개: 좌표 들어올 때마다 선도 같이 갱신
    watchId = navigator.geolocation.watchPosition(p => {
      const { latitude: lat, longitude: lon } = p.coords;
      track.push({ lat, lon, time: Date.now() });
      drawTrackOnMap(track);   // ★ 재개 후에도 매 샘플마다 갱신
    }, err => console.warn(err), { enableHighAccuracy: true, maximumAge: 1000 });
    btnPause.textContent = '일시정지';
  }
  // 버튼 누른 직후에도 한 번 갱신(선택 사항)
  drawTrackOnMap(track);
});

function setMainButtonRunning(running){
  isRunning = running;
  if (running){
    btnMain.textContent = 'STOP';
    btnMain.classList.remove('cta-start');
    btnMain.classList.add('cta-stop');
    btnPause.disabled = false;
  } else {
    btnMain.textContent = 'START';
    btnMain.classList.remove('cta-stop');
    btnMain.classList.add('cta-start');
    btnPause.disabled = true;
  }
}

async function startRun(){
  if(!('geolocation' in navigator)) { alert('이 기기에서 위치를 사용할 수 없습니다'); return; }
  setMainButtonRunning(true);
  btnPause.textContent = '일시정지'; // ★ 라벨 초기화


  startedAt = Date.now();
  track = [];
  document.getElementById('sparkPaceLabel').textContent = `--'--"/km`;
  updateSparkline();

  elapsedInt = setInterval(updateMetrics, 1000);
  watchId = navigator.geolocation.watchPosition(pos=>{
    const {latitude:lat, longitude:lon} = pos.coords;
    track.push({lat,lon,time:Date.now()});
    if (track.length === 1) centerTo(lat, lon);
    drawTrackOnMap(track);
  }, err=>{
    console.warn(err); alert('위치 권한을 허용해주세요');
  }, {enableHighAccuracy:true, maximumAge:1000});
}

// === Cloud Sync ===
// 로컬 activity 객체를 Supabase activities 테이블로 업로드
async function uploadActivityToCloud(activity){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { console.warn('로그인 상태 아님: 로컬에만 저장'); return; }

  const payload = {
    id: activity.id,
    user_id: session.user.id,
    title: activity.title,
    sport: activity.sport,
    distance_km: activity.distance,
    duration_s: activity.duration,
    started_at: new Date(activity.date).toISOString(),
    visibility: 'public',
    coords_json: activity.coords,
    images_json: Array.isArray(activity.images) ? activity.images : [],
    notes: activity.notes || ''
  };

  const { error } = await sb.from('activities').upsert(payload);
  if (error) console.error('활동 업로드 실패:', error.message);
}

// DB에서 단일 활동을 읽어 상세 화면 열기
async function openActivityFromCloud(id){
  const { data, error } = await sb
    .from('activities')
    .select('id,user_id,title,sport,distance_km,duration_s,started_at,coords_json,images_json,notes')
    .eq('id', id).single();
  if (error || !data){ alert('활동을 찾을 수 없습니다'); return; }

  // 로컬 구조로 변환해서 mockActivities에도 넣고 기존 openActivity 재사용
  const a = {
    id: data.id,
    user_id: data.user_id,
    title: data.title || '활동',
    sport: normalizeSport(data.sport || 'running'),
    distance: Number(data.distance_km || 0),
    duration: data.duration_s || 0,
    date: new Date(data.started_at).getTime(),
    coords: Array.isArray(data.coords_json) ? data.coords_json : [],
    images: Array.isArray(data.images_json) ? data.images_json : [],
    notes: data.notes || ''
  };

  const idx = mockActivities.findIndex(x => x.id === a.id);
  if (idx >= 0) mockActivities[idx] = { ...mockActivities[idx], ...a };
  else mockActivities.push(a);
  localStorage.setItem('activities', JSON.stringify(mockActivities));

  openActivity(a.id);
}

// 댓글 개수 모으기 (MVP: rows를 받아 클라에서 카운트)
async function fetchCommentCounts(activityIds){
  if (!activityIds?.length) return {};
  const { data, error } = await sb
    .from('activity_comments')
    .select('activity_id')
    .in('activity_id', activityIds);
  if (error) { console.warn('댓글 카운트 실패:', error.message); return {}; }
  const counts = {};
  (data||[]).forEach(r => { counts[r.activity_id] = (counts[r.activity_id]||0) + 1; });
  return counts;
}

async function stopRun(){
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  clearInterval(elapsedInt);

  const duration = Math.floor((Date.now() - startedAt) / 1000);
  const distance = calcDistance() / 1000;

  
  // ★ 코스 선택 보강: 전역/지역 어디에 있든 우선적으로 코스 정보 사용
  const c = selectedCourse || window.selectedCourse || null;
  const finalTitle = (c && c.name) ? c.name : '자유 운동';
  const finalSport = normalizeSport((c && c.sport) ? c.sport : getDefaultSport());

  // ★ 로컬 프로필에서 즉시 표시용 닉네임/아바타 가져오기
  const prof     = JSON.parse(localStorage.getItem('profile') || '{}');
  const myName   = prof.nickname  || '나';
  const myAvatar = prof.avatarUrl || '';

  const activity = {
    id: crypto.randomUUID(),
    title: finalTitle,                     // ← 확정된 제목
    sport: finalSport,                     // ← 확정된 종목
    distance: Number(distance.toFixed(2)),
    duration,
    date: Date.now(),
    coords: track,
    user_id: window._myUid || null,
    // ★ 추가: 피드 썸네일이 즉시 보이게
    authorName: myName,
    authorAvatar: myAvatar,
    images: [],
    notes: ''
  };

  // 로컬에 먼저 반영
  mockActivities.push(activity);
  localStorage.setItem('activities', JSON.stringify(mockActivities));

  // 서버 업로드 후 피드 갱신(성공/실패와 무관하게 UI는 이미 보임)
  try {
    await uploadActivityToCloud(activity);
    await fetchSocialFeedFromCloud(); // 서버 기준으로 최신화(댓글/좋아요 카운트 등)
  } catch (_) {}

  // UI 리셋
  startedAt = null; track = [];
  mDist.textContent='0.00'; mTime.textContent='00:00'; mPace.textContent="--'--\"";
  clearCanvas(document.getElementById('paceSpark'));
  document.getElementById('sparkPaceLabel').textContent = `--'--"/km`;
  if (kakaoPolyline) { kakaoPolyline.setPath([]); }
  setMainButtonRunning(false);
  alert('활동이 저장되었습니다');

  renderFeed();
  show('home');
  btnPause.textContent = '일시정지';
}

// btnChooseRoute 클릭 시 코스 탭으로 이동
document.getElementById('btnChooseRoute')?.addEventListener('click', () => {
  // 기록이 진행 중일 때는 동작하지 않도록 처리
  if (isRunning) {
    alert('활동 기록 중에는 코스를 변경할 수 없습니다.');
    return;
  }
  show('courses');
});

// 메인 버튼: 토글
btnMain?.addEventListener('click', ()=>{
  if (!isRunning) startRun();
  else stopRun();
});

// ---- PWA (service worker placeholder) ----
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  })
}

// Install prompt handling
let deferredPrompt; 
const btnInstall=document.getElementById('btnInstallPWA');

window.addEventListener('beforeinstallprompt',(e)=>{
  e.preventDefault();
  deferredPrompt=e;
  btnInstall?.removeAttribute('hidden');
});

btnInstall?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  await deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  btnInstall?.setAttribute('hidden', ''); // 다시 숨김
  deferredPrompt = null;
});

window.selectCourse = (id) => {
  selectedCourse = courseSeed.find(c => c.id === id) || null;
  alert('선택된 코스: ' + selectedCourse.name);
  show('record');
  initKakaoMap();
  // 실제로는 코스의 시작 좌표를 써야 함(더미로 서울시청)
  centerTo(37.5665, 126.9780);
};

window.addEventListener('resize', ()=>{
  const route = location.hash.replace('#','') || 'home';
  if (route === 'activity' && currentActivity){
    const canvas = document.getElementById('paceChart');
    const series = computePaceSeries(currentActivity.coords);
    drawPaceChart(canvas, series, currentActivity.duration);
  }
  if (route === 'record' && startedAt){
    updateSparkline();
  }
});

// iOS Safari 핀치 제스처 방지(가능한 경우에만)
['gesturestart','gesturechange','gestureend'].forEach(evt=>{
  document.addEventListener(evt, e => { if (e.cancelable) e.preventDefault(); }, { passive:false });
});

// iOS 더블탭 확대 방지
let __lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  if (!e.cancelable) return;          // ✅ 스크롤 중이면 그냥 무시(콘솔 경고 방지)
  const now = Date.now();
  if (now - __lastTouchEnd <= 300) {
    e.preventDefault();
  }
  __lastTouchEnd = now;
}, { passive:false });
