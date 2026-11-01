'use strict';
/* THE SENTENCE LAB — Phase 1 MVP (정적 사이트 + Vercel 서버리스 /api/analyze) */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDate = t => new Date(t).toLocaleString('ko-KR');
const MAX_AI_CHARS = 6000;
const ITEMS = ['핵심 진단','문장 리듬과 호흡','문법적 구조와 정보 배열','시점과 서술 방식','단어 선택과 어휘의 정밀도','비유, 상징, 이미지와 반복','긴장감 및 정보 공개 방식','감정의 직접 진술과 간접 묘사','문학적 강점','개선이 필요한 부분','대안적 해석','수정 방향과 예상 효과'];

/* ---------- 저장 계층 (나중에 Supabase 구현으로 교체) ---------- */
const KEY = 'sentencelab.v1';
const Store = {
  empty: () => ({ version: 1, projects: [], analyses: [], settings: { theme: 'dark', font: 18 } }),
  valid: d => d && d.version === 1 && Array.isArray(d.projects) && Array.isArray(d.analyses) && d.settings && typeof d.settings === 'object',
  load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); if (!raw) return Store.empty(); const d = JSON.parse(raw); if (Store.valid(d)) return d; } catch {}
    try { localStorage.setItem(KEY + '.broken', raw || ''); } catch {}
    setTimeout(() => toast('저장된 데이터가 손상되어 새로 시작합니다. 원본은 별도 키(.broken)에 보관했습니다.'), 300);
    return Store.empty();
  },
  save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); return true; } catch { return false; } }
};
let db = Store.load();
let view = 'dashboard', pid = null, cid = null, cur = null, aiBusy = false, timer = null;

function commit() { const ok = Store.save(db); setStatus(ok ? 'saved' : 'fail'); if (!ok) toast('저장에 실패했습니다. 저장 공간을 확인하고 데이터를 내보내세요.'); return ok; }
function setStatus(s) { const e = $('#status'); if (!e) return; e.className = 'status ' + s; e.textContent = { saving: '저장 중…', saved: '저장됨', fail: '저장 실패' }[s]; }
function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500); }
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 500); }
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('복사했습니다.'); } catch { toast('복사에 실패했습니다.'); } }

/* ---------- 텍스트 통계 (코드로 계산) ---------- */
function stats(t) {
  const nospace = t.replace(/\s/g, '').length;
  const words = (t.match(/\S+/g) || []).length;
  const sents = t.match(/[^.!?…。？！\n]+[.!?…。？！]*["”’']?/g)?.map(s => s.trim()).filter(s => /[\p{L}\p{N}]/u.test(s)) || [];
  const lens = sents.map(s => s.replace(/\s/g, '').length);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const buckets = [['20자 이하', 0], ['21–40자', 0], ['41–80자', 0], ['81자 이상', 0]];
  lens.forEach(n => buckets[n <= 20 ? 0 : n <= 40 ? 1 : n <= 80 ? 2 : 3][1]++);
  const freq = {};
  (t.match(/[\p{L}\p{N}]{2,}/gu) || []).forEach(w => freq[w] = (freq[w] || 0) + 1);
  const repeats = Object.entries(freq).filter(e => e[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const punct = {}; for (const c of ',.?!…“”"\'—-:;()') { const n = t.split(c).length - 1; if (n) punct[c] = n; }
  const dlg = (t.match(/“[^”]*”|"[^"]*"/g) || []).reduce((a, s) => a + s.replace(/\s/g, '').length, 0);
  const paras = t.split(/\n\s*\n/).map(p => p.replace(/\s/g, '').length).filter(Boolean);
  return { chars: t.length, nospace, words, sentences: sents.length, avg: +avg.toFixed(1), buckets, repeats, punct, dialogue: nospace ? +(dlg / nospace * 100).toFixed(1) : 0, paras };
}
function statsHTML(s) {
  const max = Math.max(1, ...s.buckets.map(b => b[1]));
  return `<table><tr><th>글자(공백 포함)</th><td>${s.chars}</td><th>글자(공백 제외)</th><td>${s.nospace}</td></tr>
  <tr><th>어절</th><td>${s.words}</td><th>문장</th><td>${s.sentences}</td></tr>
  <tr><th>평균 문장 길이</th><td>${s.avg}자</td><th>대화문 비율</th><td>${s.dialogue}%</td></tr></table>
  <h3 style="margin-top:.8rem">문장 길이 분포</h3><table>${s.buckets.map(b => `<tr><td>${b[0]}</td><td><span class="bar" style="width:${b[1] / max * 120}px"></span> ${b[1]}</td></tr>`).join('')}</table>
  <h3 style="margin-top:.8rem">반복 어휘(3회 이상)</h3><p>${s.repeats.length ? s.repeats.map(r => `${esc(r[0])} <span class="tag">${r[1]}</span>`).join(' ') : '<span class="mute">없음</span>'}</p>
  <h3>문장 부호</h3><p>${Object.entries(s.punct).map(e => `${esc(e[0])} <span class="tag">${e[1]}</span>`).join(' ') || '<span class="mute">없음</span>'}</p>
  <h3>문단별 길이(공백 제외)</h3><p>${s.paras.join(', ') || '-'}</p>
  <p class="mute">측정 한계: 문장은 마침표·물음표·느낌표·줄바꿈 기준으로 나누며 약어·말줄임·인용 내부 부호로 오차가 날 수 있습니다. 반복 어휘는 조사를 분리하지 않은 어절 단위입니다. 대화문은 큰따옴표 안의 글자만 계산합니다.</p>`;
}

/* ---------- AI 호출 (서버 라우트 경유) ---------- */
async function callAI(text, items) {
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, items }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || '요청에 실패했습니다.'), { code: j.error });
  if (!Array.isArray(j.items) || !j.items.length || !j.items.every(i => i && typeof i.name === 'string' && typeof i.analysis === 'string')) throw new Error('AI 응답 형식이 올바르지 않습니다. 다시 시도하세요.');
  return j.items;
}
function aiHTML(items) {
  return items.map(i => `<div class="ai-item"><h3>${esc(i.name)}</h3>
  <p><b>근거</b> ${esc(i.evidence || '-')} ${i.verified === false ? '<span class="tag" style="color:var(--danger)">원문과 정확히 일치하지 않음</span>' : ''}</p>
  <p><b>효과</b> ${esc(i.effect || '-')}</p><p><b>분석</b> ${esc(i.analysis)}</p>
  <p><b>제안</b> ${esc(i.suggestion || '-')}</p><p><b>확실성·한계</b> ${esc(i.certainty || '-')}</p></div>`).join('');
}
function toMD(a) {
  let m = `# 문장 분석\n\n> ${a.text.replace(/\n/g, '\n> ')}\n\n## 통계\n- 글자 ${a.stats.chars} / 어절 ${a.stats.words} / 문장 ${a.stats.sentences} / 평균 문장 ${a.stats.avg}자\n`;
  if (a.ai) m += '\n## AI 분석 (AI의 해석이며 측정값이 아님)\n' + a.ai.map(i => `\n### ${i.name}\n- 근거: ${i.evidence || '-'}\n- 효과: ${i.effect || '-'}\n- 분석: ${i.analysis}\n- 제안: ${i.suggestion || '-'}\n- 확실성: ${i.certainty || '-'}`).join('\n');
  else m += '\nAI 분석은 수행하지 않았습니다.\n';
  return m;
}

/* ---------- 화면 ---------- */
const V = {};
function render() {
  document.querySelectorAll('.nav button').forEach(b => { b.classList.toggle('on', b.dataset.v === view); b.setAttribute('aria-current', b.dataset.v === view ? 'page' : 'false'); });
  document.documentElement.dataset.theme = db.settings.theme;
  document.documentElement.style.setProperty('--fs', db.settings.font + 'px');
  $('#view').innerHTML = V[view]();
  const f = $('#view')['bind_' + view]; (V['bind_' + view] || (() => {}))();
}

V.dashboard = () => {
  const ps = [...db.projects].sort((a, b) => b.updatedAt - a.updatedAt), an = [...db.analyses].sort((a, b) => b.createdAt - a.createdAt);
  if (!ps.length && !an.length) return `<h1>문장 연구소에 오신 것을 환영합니다</h1><p class="mute">문장을 해부하고, 문체를 단련한다.</p>
  <div class="grid g3"><div class="card"><h2>1. 문장 해부실</h2><p>문장이나 문단을 붙여 넣으면 글자 수, 문장 길이, 반복 어휘 같은 통계를 즉시 계산합니다. AI 키를 설정하면 12개 항목의 문학 분석도 요청할 수 있습니다.</p><button class="b" data-go="lab">분석 시작</button></div>
  <div class="card"><h2>2. 장편소설 작업실</h2><p>작품을 만들고 장 단위로 원고를 씁니다. 입력할 때마다 자동 저장되고 저장 결과가 화면에 표시됩니다.</p><button class="b" data-go="novel">작품 만들기</button></div>
  <div class="card"><h2>3. 데이터는 이 브라우저에 저장됩니다</h2><p>브라우저 데이터를 지우거나 다른 기기를 쓰면 데이터가 보이지 않습니다. 설정에서 JSON으로 내보내 백업하세요.</p><button class="b alt" data-go="settings">설정으로</button></div></div>`;
  const p = ps[0], ch = p && [...p.chapters].sort((a, b) => b.updatedAt - a.updatedAt)[0], a = an[0];
  return `<h1>대시보드</h1><div class="grid g3">
  <div class="card"><h2>최근 작품</h2>${p ? `<p>${esc(p.title)}</p><p class="mute">${fmtDate(p.updatedAt)}</p><button class="b" data-open="${p.id}">이어 쓰기</button>` : '<p class="mute">작품이 없습니다.</p><button class="b" data-go="novel">작품 만들기</button>'}</div>
  <div class="card"><h2>최근 원고</h2>${ch ? `<p>${esc(ch.title)}</p><p class="mute">${ch.text.length}자 · ${fmtDate(ch.updatedAt)}</p>` : '<p class="mute">작성한 원고가 없습니다.</p>'}</div>
  <div class="card"><h2>마지막 문장 분석</h2>${a ? `<p>${esc(a.text.slice(0, 60))}…</p><p class="mute">${fmtDate(a.createdAt)} · ${a.ai ? 'AI 분석 포함' : '통계만'}</p><button class="b alt" data-go="lab">해부실로</button>` : '<p class="mute">저장된 분석이 없습니다.</p>'}</div>
  <div class="card"><h2>데이터 저장 상태</h2><p>작품 ${db.projects.length}개 · 저장된 분석 ${db.analyses.length}개</p><p class="mute">이 브라우저의 로컬 저장소 (다른 기기와 공유되지 않음)</p></div></div>
  <p class="mute">작가 훈련실, 문체 연구소, 인물·세계관·복선·연표는 아직 구현되지 않았습니다(Phase 2~4).</p>`;
};
V.bind_dashboard = () => {
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { pid = b.dataset.open; cid = null; go('novel'); });
};

V.lab = () => {
  const hist = [...db.analyses].sort((a, b) => b.createdAt - a.createdAt);
  return `<h1>문장 해부실</h1><div class="grid g2"><div>
  <label class="f" for="src">분석할 문장·문단</label><textarea id="src" placeholder="여기에 문장이나 여러 문단을 입력하세요">${esc(cur?.text || '')}</textarea>
  <p class="mute" id="cnt"></p>
  <details class="card"><summary>AI 분석 항목 선택 (기본: 전체)</summary>${ITEMS.map((n, i) => `<label style="display:block"><input type="checkbox" class="it" value="${esc(n)}" checked> ${esc(n)}</label>`).join('')}</details>
  <div class="row"><button class="b" id="run">기본 분석</button><button class="b alt" id="ai">AI 분석 (최대 ${MAX_AI_CHARS}자)</button><button class="b alt" id="save">결과 저장</button></div></div>
  <div><div class="card" id="out"><p class="mute">분석 결과가 여기에 표시됩니다. AI 분석을 수행하기 전에는 AI 결과가 없습니다.</p></div></div></div>
  <h2>저장된 분석</h2>${hist.length ? hist.map(a => `<div class="card row sp"><span>${esc(a.text.slice(0, 50))}… <span class="mute">${fmtDate(a.createdAt)} · ${a.ai ? 'AI 포함' : '통계만'}</span></span><span class="row"><button class="b alt sm" data-o="${a.id}">열기</button><button class="b alt sm" data-m="${a.id}">Markdown</button><button class="b del sm" data-d="${a.id}">삭제</button></span></div>`).join('') : '<p class="mute">저장된 분석이 없습니다.</p>'}`;
};
function showOut(err) {
  if (!cur) return;
  $('#out').innerHTML = `<h2>통계 (코드로 계산한 값)</h2>${statsHTML(cur.stats)}` +
    (aiBusy ? '<p>AI 분석 중…</p>' : err ? `<div class="warn">${esc(err.message)} ${err.code === 'AI_DISABLED' ? '' : '<button class="b alt sm" id="retry">재시도</button>'}</div>` : '') +
    (cur.ai ? `<h2 style="margin-top:1rem">AI 분석 <span class="tag">AI의 해석이며 측정값이 아님</span></h2>${aiHTML(cur.ai)}<div class="row" style="margin-top:.8rem"><button class="b alt sm" id="cp">복사</button><button class="b alt sm" id="md">Markdown 내보내기</button></div>` : '');
  $('#retry') && ($('#retry').onclick = doAI);
  $('#cp') && ($('#cp').onclick = () => copy(toMD(cur)));
  $('#md') && ($('#md').onclick = () => download('analysis.md', toMD(cur), 'text/markdown'));
}
function doBasic() {
  const t = $('#src').value;
  if (!t.trim()) return toast('분석할 텍스트를 입력하세요.');
  cur = { id: uid(), text: t, stats: stats(t), ai: null, createdAt: Date.now() }; showOut();
}
async function doAI() {
  const t = $('#src').value;
  if (!t.trim()) return toast('분석할 텍스트를 입력하세요.');
  if (t.length > MAX_AI_CHARS) return toast(`AI 분석은 ${MAX_AI_CHARS}자까지입니다. 현재 ${t.length}자입니다. 범위를 줄여 주세요.`);
  if (aiBusy) return;
  const items = [...document.querySelectorAll('.it:checked')].map(i => i.value);
  if (!items.length) return toast('분석 항목을 하나 이상 선택하세요.');
  cur = { id: uid(), text: t, stats: stats(t), ai: null, createdAt: Date.now() }; aiBusy = true; $('#ai').disabled = true; showOut();
  try { cur.ai = await callAI(t, items); aiBusy = false; showOut(); }
  catch (e) { aiBusy = false; showOut(e); }
  finally { aiBusy = false; const b = $('#ai'); if (b) b.disabled = false; }
}
V.bind_lab = () => {
  const src = $('#src'), upd = () => { const s = stats(src.value); $('#cnt').textContent = `${s.chars}자 · 문장 ${s.sentences}개`; };
  src.oninput = upd; upd(); if (cur) showOut();
  $('#run').onclick = doBasic; $('#ai').onclick = doAI;
  $('#save').onclick = () => { if (!cur) return toast('먼저 분석을 실행하세요.'); db.analyses.push({ ...cur, id: uid() }); if (commit()) { toast('저장했습니다.'); render(); } };
  document.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { cur = db.analyses.find(a => a.id === b.dataset.o); $('#src').value = cur.text; upd(); showOut(); });
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => download('analysis.md', toMD(db.analyses.find(a => a.id === b.dataset.m)), 'text/markdown'));
  document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { if (confirm('이 분석을 삭제할까요? 되돌릴 수 없습니다.')) { db.analyses = db.analyses.filter(a => a.id !== b.dataset.d); commit(); render(); } });
};

const proj = () => db.projects.find(p => p.id === pid);
V.novel = () => {
  const p = proj();
  if (!p) return `<h1>장편소설 작업실</h1><div class="card"><label class="f" for="pt">새 작품 제목</label><input type="text" id="pt"><label class="f" for="pl">한 줄 소개</label><input type="text" id="pl"><label class="f" for="pg">장르</label><input type="text" id="pg"><p><button class="b" id="mk">작품 만들기</button></p></div>
  ${db.projects.map(x => `<div class="card row sp"><span>${esc(x.title)} <span class="mute">${esc(x.genre)} · ${x.chapters.reduce((a, c) => a + c.text.length, 0)}자</span></span><button class="b alt sm" data-p="${x.id}">열기</button></div>`).join('') || '<p class="mute">아직 작품이 없습니다. 위에서 첫 작품을 만드세요.</p>'}`;
  const c = p.chapters.find(x => x.id === cid) || p.chapters[0]; if (c) cid = c.id;
  const total = p.chapters.reduce((a, x) => a + x.text.length, 0);
  return `<div class="row sp"><h1>${esc(p.title)}</h1><span class="row"><button class="b alt sm" id="back">작품 목록</button><button class="b alt sm" id="exp">Markdown</button><button class="b del sm" id="dp">작품 삭제</button></span></div>
  <p class="mute">${esc(p.logline)} · ${esc(p.genre)} · 총 ${total}자</p>
  <div class="editor"><div><div class="row sp"><h2>장·절</h2><button class="b sm" id="ac">추가</button></div>
  <ul class="chs">${p.chapters.map((x, i) => `<li class="${x.id === cid ? 'on' : ''}"><button class="t" data-c="${x.id}">${esc(x.title)}</button><button class="b alt sm" data-u="${i}" aria-label="위로" ${i ? '' : 'disabled'}>↑</button><button class="b alt sm" data-w="${i}" aria-label="아래로" ${i < p.chapters.length - 1 ? '' : 'disabled'}>↓</button><button class="b alt sm" data-r="${x.id}" aria-label="이름 변경">✎</button><button class="b del sm" data-x="${x.id}" aria-label="삭제">✕</button></li>`).join('') || '<li class="mute">장을 추가하세요.</li>'}</ul>
  <label class="f" for="sq">원고 검색</label><input type="text" id="sq"><div id="sr" class="mute"></div></div>
  <div>${c ? `<div class="row sp"><h2>${esc(c.title)}</h2><span class="mute"><span id="status" class="status saved">저장됨</span> · <span id="wc"></span></span></div>
  <label class="f" for="ms">원고</label><textarea id="ms">${esc(c.text)}</textarea>` : '<p class="mute">왼쪽에서 장을 추가하면 원고를 쓸 수 있습니다.</p>'}</div></div>
  ${c ? `<div class="card"><h2>버전</h2><button class="b sm" id="vs">현재 버전 저장</button>${(c.versions || []).map(v => `<div class="row sp"><span class="mute">${fmtDate(v.at)} · ${v.text.length}자</span><span class="row"><button class="b alt sm" data-vc="${v.id}">현재와 비교</button><button class="b alt sm" data-vr="${v.id}">복원</button><button class="b del sm" data-vd="${v.id}">삭제</button></span></div>`).join('') || '<p class="mute">저장된 버전이 없습니다.</p>'}<div id="vdiff"></div></div>` : ''}
  <p class="mute">삭제는 되돌릴 수 없으니 백업을 내보내 두세요.</p>`;
};
V.bind_novel = () => {
  const p = proj();
  if (!p) {
    $('#mk') && ($('#mk').onclick = () => { const t = $('#pt').value.trim(); if (!t) return toast('제목을 입력하세요.'); const n = Date.now(); const np = { id: uid(), title: t, logline: $('#pl').value.trim(), genre: $('#pg').value.trim(), chapters: [{ id: uid(), title: '1장', text: '', updatedAt: n }], createdAt: n, updatedAt: n }; db.projects.push(np); if (commit()) { pid = np.id; cid = null; render(); } });
    document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { pid = b.dataset.p; cid = null; render(); });
    return;
  }
  const touch = () => { p.updatedAt = Date.now(); return commit(); };
  $('#back').onclick = () => { pid = null; render(); };
  $('#exp').onclick = () => download(p.title + '.md', `# ${p.title}\n\n` + p.chapters.map(c => `## ${c.title}\n\n${c.text}`).join('\n\n'), 'text/markdown');
  $('#dp').onclick = () => { if (confirm(`'${p.title}' 작품과 모든 원고를 삭제할까요? 되돌릴 수 없습니다.`)) { db.projects = db.projects.filter(x => x.id !== p.id); pid = null; commit(); render(); } };
  $('#ac').onclick = () => { p.chapters.push({ id: uid(), title: `${p.chapters.length + 1}장`, text: '', updatedAt: Date.now() }); cid = p.chapters.at(-1).id; touch(); render(); };
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { cid = b.dataset.c; render(); });
  const mv = (i, d) => { [p.chapters[i], p.chapters[i + d]] = [p.chapters[i + d], p.chapters[i]]; touch(); render(); };
  document.querySelectorAll('[data-u]').forEach(b => b.onclick = () => mv(+b.dataset.u, -1));
  document.querySelectorAll('[data-w]').forEach(b => b.onclick = () => mv(+b.dataset.w, 1));
  document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const c = p.chapters.find(x => x.id === b.dataset.r), n = prompt('새 이름', c.title); if (n && n.trim()) { c.title = n.trim(); touch(); render(); } });
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { const c = p.chapters.find(x => x.id === b.dataset.x); if (confirm(`'${c.title}'(${c.text.length}자)을 삭제할까요? 되돌릴 수 없습니다.`)) { p.chapters = p.chapters.filter(x => x !== c); cid = null; touch(); render(); } });
  const ms = $('#ms'), c = p.chapters.find(x => x.id === cid);
  if (ms && c) {
    const wc = () => { $('#wc').textContent = `${ms.value.length}자 · ${(ms.value.match(/\S+/g) || []).length}어절`; }; wc();
    ms.oninput = () => { setStatus('saving'); wc(); clearTimeout(timer); timer = setTimeout(() => { c.text = ms.value; c.updatedAt = Date.now(); touch(); }, 500); };
    ms.onblur = () => { if (c.text !== ms.value) { clearTimeout(timer); c.text = ms.value; c.updatedAt = Date.now(); touch(); } };
  }
  if (c) {
    const flush = () => { if ($('#ms')) { c.text = $('#ms').value; c.updatedAt = Date.now(); } };
    const ver = id => (c.versions || []).find(v => v.id === id);
    const snap = () => { flush(); c.versions = c.versions || []; c.versions.push({ id: uid(), at: Date.now(), text: c.text }); if (c.versions.length > 20) c.versions.shift(); };
    $('#vs').onclick = () => { snap(); if (commit()) { toast('버전을 저장했습니다.'); render(); } };
    document.querySelectorAll('[data-vc]').forEach(b => b.onclick = () => { flush(); const d = diffLines(ver(b.dataset.vc).text, c.text); $('#vdiff').innerHTML = d ? '<p class="mute">줄(문단) 단위 비교: 삭제는 취소선, 추가는 강조</p>' + d.map(([t, s]) => t === '-' ? `<p><del>${esc(s)}</del></p>` : t === '+' ? `<p><mark>${esc(s)}</mark></p>` : `<p class="mute">${esc(s)}</p>`).join('') : '<p class="warn">텍스트가 너무 길어 비교할 수 없습니다.</p>'; });
    document.querySelectorAll('[data-vr]').forEach(b => b.onclick = () => { if (confirm('이 버전으로 복원할까요? 현재 내용은 새 버전으로 먼저 저장됩니다.')) { const v = ver(b.dataset.vr); snap(); c.text = v.text; c.updatedAt = Date.now(); if (commit()) render(); } });
    document.querySelectorAll('[data-vd]').forEach(b => b.onclick = () => { if (confirm('이 버전을 삭제할까요?')) { c.versions = c.versions.filter(v => v.id !== b.dataset.vd); commit(); render(); } });
  }
  $('#sq').oninput = e => { const q = e.target.value.trim(); $('#sr').innerHTML = q ? (p.chapters.flatMap(c => { const i = c.text.indexOf(q); return i < 0 ? [] : [`${esc(c.title)}: …${esc(c.text.slice(Math.max(0, i - 15), i + q.length + 15))}…`]; }).join('<br>') || '결과 없음') : ''; };
};

V.settings = () => `<h1>설정·데이터</h1>
<div class="card"><h2>화면</h2><label class="f" for="th">테마</label><select id="th"><option value="dark">어두운 테마</option><option value="light">밝은 테마</option></select>
<label class="f" for="fz">글자 크기: <span id="fv">${db.settings.font}</span>px</label><input type="range" id="fz" min="14" max="24" value="${db.settings.font}"></div>
<div class="card"><h2>데이터</h2><p>작품 ${db.projects.length}개 · 분석 ${db.analyses.length}개. 데이터는 이 브라우저의 로컬 저장소에만 있으며, 브라우저 데이터를 지우거나 다른 기기를 쓰면 보이지 않습니다. 정기적으로 내보내세요.</p>
<div class="row"><button class="b" id="ex">모든 데이터 내보내기(JSON)</button><label class="b alt" for="im">JSON 가져오기</label><input type="file" id="im" accept=".json,application/json" hidden><button class="b del" id="cl">모든 데이터 삭제</button></div></div>`;
V.bind_settings = () => {
  $('#th').value = db.settings.theme;
  $('#th').onchange = e => { db.settings.theme = e.target.value; commit(); render(); };
  $('#fz').oninput = e => { db.settings.font = +e.target.value; $('#fv').textContent = e.target.value; document.documentElement.style.setProperty('--fs', e.target.value + 'px'); };
  $('#fz').onchange = commit;
  $('#ex').onclick = () => download(`sentence-lab-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 2), 'application/json');
  $('#im').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!Store.valid(d)) throw 0; if (!confirm('현재 데이터를 가져온 파일로 덮어씁니다. 계속할까요? (먼저 내보내기를 권장합니다)')) return; db = d; commit(); toast('가져왔습니다.'); render(); }
    catch { toast('올바른 문장 연구소 JSON 파일이 아닙니다. 기존 데이터는 변경되지 않았습니다.'); }
    e.target.value = '';
  };
  $('#cl').onclick = () => { if (confirm('모든 작품과 분석을 삭제할까요? 되돌릴 수 없습니다.') && confirm('정말 삭제합니다. 백업을 내보내셨나요?')) { db = Store.empty(); pid = cid = cur = null; commit(); render(); } };
};

function go(v) { view = v; render(); $('#view').focus(); }
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => go(b.dataset.v));
window.addEventListener('beforeunload', () => { if ($('#ms') && timer) { const p = proj(), c = p?.chapters.find(x => x.id === cid); if (c) { c.text = $('#ms').value; Store.save(db); } } });
render();

/* ================= Phase 2~4 추가 모듈 ================= */
const EX = [
 ['문장 압축','세 문장을 한 문장으로','불필요한 수식을 걷어내고 핵심 정보만 남기는 연습','아침에 일어나 창밖을 보는 장면을 80자 이내 한 문장으로. 형용사는 2개까지.','80자 이내',1],
 ['간접 묘사','슬프다고 쓰지 않고 슬픔 쓰기','감정 단어 없이 사물·행동으로 감정을 전달','"슬프다·외롭다" 등 감정어 금지. 물건 하나를 반드시 사용.','200~300자',2],
 ['감정 표현','직접과 간접의 균형','직접 진술과 간접 묘사를 한 장면에서 섞어 쓰기','분노를 직접 진술 한 번, 간접 묘사 두 번으로 표현.','300자 내외',2],
 ['비유와 상징','하나의 이미지로 끌고 가기','한 이미지를 반복해 의미를 쌓기','비 오는 날의 대기실. 같은 이미지를 3번 변주하되 설명하지 않기.','300~400자',3],
 ['문장 리듬','긴 문장과 짧은 문장','길이 변화로 호흡을 조절하기','달리는 장면. 40자 이상 문장 2개와 10자 이하 문장 3개를 포함.','250~350자',2],
 ['시점 전환','같은 장면, 두 시점','시점에 따라 달라지는 정보와 어조 구분','같은 다툼을 1인칭과 3인칭 제한 시점으로 각각 150자.','300자',3],
 ['의식의 흐름','끊기지 않는 생각','쉼표와 연결어로 생각의 이동을 따라가기','마침표 없이 한 문단. 시작과 끝의 주제가 달라야 함.','300~500자',4],
 ['인물의 말과 행동','행동이 말을 배신하다','말과 행동의 불일치로 인물을 드러내기','"괜찮아"라고 말하는 인물이 괜찮지 않음을 행동으로만 보여주기.','250자 내외',2],
 ['대화와 침묵','말하지 않는 대화','대사의 생략과 침묵을 장면 장치로 쓰기','두 사람의 대화. 핵심 주제는 대사에서 한 번도 언급하지 않기.','대사 6줄 이내',3],
 ['서술과 장면 구성','장면의 첫 문장','장면을 여는 정보 선택 연습','장소·시간·인물 중 두 가지만 첫 문단에 드러내기.','200~300자',2],
 ['긴장감 조절','정보를 늦게 주기','공개 순서로 긴장 만들기','문 뒤의 소리. 그 정체는 마지막 문장에서만 밝히기.','300자',3],
 ['철학적 주제 표현','추상을 구체로','관념어 없이 주제를 장면으로 번역하기','"시간"을 다루되 단어 "시간"과 "세월"은 쓰지 않기.','300~400자',4]];
db.submissions = db.submissions || [];
let tx = null;
const subOf = i => db.submissions.find(s => s.exId === i);
const sm = t => { const s = stats(t); return `${s.nospace}자 · 문장 ${s.sentences} · 평균 ${s.avg}자`; };
V.train = () => {
  if (tx === null) return `<h1>작가 훈련실</h1><p class="mute">과제를 고르면 조건만 보입니다. 예시 답안은 제공하지 않습니다.</p>
  <div class="grid g3">${EX.map((e, i) => { const s = subOf(i); return `<div class="card"><h3>${esc(e[1])}</h3><p class="mute">${esc(e[0])} · 난이도 ${'★'.repeat(e[5])} · ${esc(e[4])}</p><p>${s ? (s.done ? '<span class="tag">완료</span>' : '<span class="tag">진행 중</span>') : ''}</p><button class="b alt sm" data-t="${i}">${s ? '이어서' : '시작'}</button></div>`; }).join('')}</div>
  <h2>AI 맞춤 훈련 제안</h2>${db.submissions.some(s => s.feedback) ? `<button class="b alt sm" id="nx" ${nxt.busy ? 'disabled' : ''}>피드백 기록으로 제안 받기</button>` : '<p class="mute">AI 피드백 기록이 없어 제안할 수 없습니다. 과제를 제출하고 AI 피드백을 받으면 활성화됩니다.</p>'}${nxt.busy ? '<p>AI 분석 중…</p>' : ''}${nxt.err ? `<div class="warn">${esc(nxt.err.message)}</div>` : ''}${nxt.items.map(i => `<div class="card"><b>${esc(i.category)}</b><p>${esc(i.reason)}</p><button class="b sm" data-ts="${esc(i.category)}">이 훈련 시작</button></div>`).join('')}<h2>훈련 기록</h2>${db.submissions.length ? db.submissions.map(s => `<p>${esc(EX[s.exId][1])} <span class="mute">${fmtDate(s.updatedAt)} · ${s.done ? '완료' : '진행 중'}</span></p>`).join('') : '<p class="mute">아직 기록이 없습니다.</p>'}
  `;
  const e = EX[tx], s = subOf(tx);
  return `<button class="b alt sm" id="tb">← 목록</button><h1>${esc(e[1])}</h1>
  <div class="card"><p><b>목표</b> ${esc(e[2])}</p><p><b>조건</b> ${esc(e[3])}</p><p class="mute">권장 분량 ${esc(e[4])} · 난이도 ${'★'.repeat(e[5])}</p></div>
  <label class="f" for="dr">초안</label><textarea id="dr" style="min-height:20vh" ${s ? 'readonly' : ''}>${esc(s?.draft || '')}</textarea><p class="mute" id="dc"></p>
  ${s ? `<label class="f" for="rv">수정본(재작성)</label><textarea id="rv" style="min-height:20vh">${esc(s.revision || s.draft)}</textarea>
  <div class="card"><h3>초안 ↔ 수정본 (수치 비교)</h3><p>초안: ${sm(s.draft)}</p><p>수정본: ${sm(s.revision || s.draft)}</p></div>` : ''}
  ${s?.feedback ? fbHTML(s.feedback) : ''}${fbBusy ? '<p>AI 평가 중…</p>' : ''}${fbErr ? `<div class="warn">${esc(fbErr.message)}</div>` : ''}<div class="row"><button class="b" id="sb">${s ? '수정본 저장' : '초안 제출'}</button>${s ? `<button class="b alt" id="fb" ${fbBusy ? 'disabled' : ''}>AI 피드백 요청</button>` : ''}${s ? `<button class="b alt" id="dn">${s.done ? '완료 취소' : '완료로 기록'}</button><button class="b del" id="ds">기록 삭제</button>` : ''}</div>`;
};
V.bind_train = () => {
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tx = +b.dataset.t; fbErr = null; render(); });
  $('#nx') && ($('#nx').onclick = async () => {
    const sum = db.submissions.filter(s => s.feedback).map(s => `과제 ${EX[s.exId][0]}: 개선할 점 ${s.feedback.improve || '-'} / 한계 ${s.feedback.limits || '-'}`).join('\n').slice(0, MAX_AI_CHARS);
    nxt = { items: [], busy: true, err: null }; render();
    try { const j = await callAPI({ mode: 'nextex', text: sum }); if (!Array.isArray(j.items)) throw new Error('AI 응답 형식이 올바르지 않습니다.'); nxt.items = j.items.filter(i => i && EX.some(e => e[0] === i.category)); if (!nxt.items.length) throw new Error('유효한 제안을 받지 못했습니다. 다시 시도하세요.'); } catch (e) { nxt.err = e; }
    nxt.busy = false; render();
  });
  document.querySelectorAll('[data-ts]').forEach(b => b.onclick = () => { tx = EX.findIndex(e => e[0] === b.dataset.ts); render(); });
  if (tx === null) return;
  $('#tb').onclick = () => { tx = null; render(); };
  const s = subOf(tx), dr = $('#dr'); dr.oninput = () => $('#dc').textContent = sm(dr.value); dr.oninput();
  $('#sb').onclick = () => {
    if (!s) { if (!dr.value.trim()) return toast('내용을 입력하세요.'); db.submissions.push({ id: uid(), exId: tx, draft: dr.value, revision: '', done: false, createdAt: Date.now(), updatedAt: Date.now() }); }
    else { s.revision = $('#rv').value; s.updatedAt = Date.now(); }
    if (commit()) { toast('저장했습니다.'); render(); }
  };
  if (s) {
    $('#fb').onclick = () => { s.revision = $('#rv').value; doFeedback(s); };
    $('#dn').onclick = () => { s.done = !s.done; s.updatedAt = Date.now(); commit(); render(); };
    $('#ds').onclick = () => { if (confirm('이 과제의 기록을 삭제할까요?')) { db.submissions = db.submissions.filter(x => x !== s); commit(); render(); } };
  }
};

/* ---- 설정집: 인물·세계관·복선·연표 (작품별) ---- */
const KINDS = {
 characters: ['인물', [['name', '이름·별칭'], ['look', '외모·특징', 't'], ['trait', '성격', 't'], ['desire', '목표와 욕망', 't'], ['fear', '두려움·약점', 't'], ['secret', '비밀', 't'], ['arc', '변화 과정', 't'], ['rel', '관계 (유형: 설명)', 't'], ['first', '처음 등장하는 장·절'], ['memo', '메모', 't']]],
 world: ['세계관', [['name', '항목명'], ['cat', '분류', 's:장소,세력·조직,역사적 사건,사회 구조,세계관 규칙,과학·초자연,용어'], ['desc', '설명', 't'], ['memo', '메모', 't']]],
 foreshadow: ['복선', [['name', '제목'], ['desc', '설명', 't'], ['first', '최초 등장 위치'], ['rel', '관련 인물·설정'], ['payoff', '예상 회수 위치'], ['status', '상태', 's:계획됨,등장함,회수됨,보류됨'], ['reader', '독자에게 공개된 정보', 't'], ['author', '작가만 아는 정보', 't'], ['memo', '메모', 't']]],
 timeline: ['연표', [['name', '사건 제목'], ['when', '작품 내 시점 (정렬 기준)'], ['who', '관련 인물'], ['where', '관련 장소'], ['desc', '설명', 't'], ['prev', '선행 사건'], ['next', '후속 사건']]]
};
let ctab = 'characters', ce = null;
V.codex = () => {
  const p = proj();
  if (!p) return `<h1>설정집</h1><p class="mute">작품을 선택하세요. 설정은 작품마다 분리됩니다.</p>${db.projects.map(x => `<div class="card row sp"><span>${esc(x.title)}</span><button class="b alt sm" data-p="${x.id}">선택</button></div>`).join('') || '<p class="mute">먼저 장편소설 작업실에서 작품을 만드세요.</p>'}`;
  p.codex = p.codex || {};
  const [lab, fields] = KINDS[ctab]; let list = p.codex[ctab] || [];
  if (ctab === 'timeline') list = [...list].sort((a, b) => (a.when || '').localeCompare(b.when || '', 'ko', { numeric: true }));
  const ed = ce === 'new' ? {} : list.find(x => x.id === ce);
  const form = ed ? `<div class="card"><h2>${ce === 'new' ? lab + ' 추가' : lab + ' 편집'}</h2>${fields.map(([k, l, t]) => `<label class="f" for="f_${k}">${l}</label>${t === 't' ? `<textarea id="f_${k}" style="min-height:4rem">${esc(ed[k] || '')}</textarea>` : t ? `<select id="f_${k}">${t.slice(2).split(',').map(o => `<option ${ed[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>` : `<input type="text" id="f_${k}" value="${esc(ed[k] || '')}">`}`).join('')}<div class="row" style="margin-top:.8rem"><button class="b" id="fs">저장</button><button class="b alt" id="fc">취소</button></div></div>` : '';
  return `<h1>설정집 — ${esc(p.title)}</h1><div class="row">${Object.entries(KINDS).map(([k, v]) => `<button class="b ${k === ctab ? '' : 'alt'} sm" data-k="${k}">${v[0]}</button>`).join('')}<button class="b alt sm" id="sw">작품 변경</button></div><br>
  ${form}${ed ? '' : `<button class="b" id="fa">${lab} 추가</button>`}
  ${list.map(x => `<div class="card"><div class="row sp"><h3>${esc(x.name)} ${(x.status ? `<span class="tag">${esc(x.status)}</span>` : '') + (x.origin === 'ai' ? '<span class="tag">AI 후보에서 등록</span>' : '')}</h3><span class="row"><button class="b alt sm" data-e="${x.id}">편집</button><button class="b del sm" data-x="${x.id}">삭제</button></span></div>${fields.slice(1).filter(f => x[f[0]]).map(f => `<p><span class="mute">${f[1]}</span> ${esc(x[f[0]])}</p>`).join('')}</div>`).join('') || `<p class="mute">등록된 ${lab}이(가) 없습니다.</p>`}
  <div class="card"><h2>AI 검사</h2><label class="f" for="cs">검사할 장</label><select id="cs">${p.chapters.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select><div class="row" style="margin-top:.6rem"><button class="b alt sm" id="aic">설정 충돌 검사</button><button class="b alt sm" id="aif">복선 후보 추정</button></div><div id="aio"></div><p class="mute">AI는 설정이나 복선을 자동으로 바꾸거나 확정하지 않습니다. 직접 등록한 항목과 AI 후보를 구분해 표시합니다.</p></div>`;
};
V.bind_codex = () => {
  const p = proj();
  document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { pid = b.dataset.p; render(); });
  if (!p) return;
  $('#sw').onclick = () => { pid = null; ce = null; render(); };
  const run = async (mode, fn) => {
    const c = p.chapters.find(x => x.id === $('#cs').value); if (!c || !c.text.trim()) return toast('검사할 장에 원고가 없습니다.');
    const cod = Object.entries(KINDS).map(([k, v]) => (p.codex[k] || []).map(x => `[소스: ${v[0]} ${x.name}]\n` + v[1].filter(f => x[f[0]]).map(f => `${f[1]}: ${x[f[0]]}`).join('\n')).join('\n\n')).filter(Boolean).join('\n\n').slice(0, 2500);
    const room = MAX_AI_CHARS - (mode === 'consistency' ? cod.length : 0) - 40;
    const text = (mode === 'consistency' && cod ? cod + '\n\n' : '') + `[소스: ${c.title}]\n` + c.text.slice(0, room);
    if (c.text.length > room) toast(`분량 제한으로 앞 ${room}자만 검사합니다.`);
    $('#aio').innerHTML = '<p>AI 검사 중…</p>';
    try { const j = await callAPI({ mode, text }); if (!Array.isArray(j.items)) throw new Error('AI 응답 형식이 올바르지 않습니다. 다시 시도하세요.'); fn(j.items, c); }
    catch (e) { $('#aio').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
  };
  $('#aic').onclick = () => run('consistency', items => { $('#aio').innerHTML = (items.length ? '' : '<p>발견된 충돌이 없습니다. (AI 검사의 한계로 누락될 수 있음)</p>') + items.map(i => `<div class="card"><p><span class="tag">${esc(i.severity || '?')}</span> ${esc(i.issue)} ${i.verified === false ? '<span class="tag" style="color:var(--danger)">근거 인용을 원문에서 확인하지 못함</span>' : ''}</p>${(Array.isArray(i.evidence) ? i.evidence : []).map(e => `<p class="mute">${esc(e.source)}: ${esc(e.quote)}</p>`).join('')}<p>${esc(i.note || '')}</p></div>`).join(''); });
  $('#aif').onclick = () => run('foreshadow', (items, c) => { $('#aio').innerHTML = items.map((i, n) => `<div class="card"><h3>${esc(i.title)} <span class="tag">AI 추정 후보</span></h3><p>${esc(i.desc)}</p><p class="mute">근거: ${esc(i.evidence)} ${i.verified === false ? '(원문과 불일치)' : ''}</p><p>${esc(i.reason)}</p><button class="b sm" data-reg="${n}">내 복선으로 등록</button></div>`).join('') || '<p>후보가 없습니다.</p>';
    document.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => { const i = items[+b.dataset.reg]; (p.codex.foreshadow = p.codex.foreshadow || []).push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), origin: 'ai', name: i.title, desc: i.desc, first: c.title, status: '등장함', memo: 'AI 후보: ' + i.reason }); p.updatedAt = Date.now(); b.disabled = true; if (commit()) toast('등록했습니다. 설정집에서 확인·수정하세요.'); }); });
  document.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { ctab = b.dataset.k; ce = null; render(); });
  $('#fa') && ($('#fa').onclick = () => { ce = 'new'; render(); });
  document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { ce = b.dataset.e; render(); });
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { if (confirm('삭제할까요? 되돌릴 수 없습니다.')) { p.codex[ctab] = p.codex[ctab].filter(x => x.id !== b.dataset.x); p.updatedAt = Date.now(); commit(); render(); } });
  if ($('#fc')) {
    $('#fc').onclick = () => { ce = null; render(); };
    $('#fs').onclick = () => {
      const o = {}; KINDS[ctab][1].forEach(([k]) => o[k] = $('#f_' + k).value.trim());
      if (!o.name) return toast('이름(제목)은 필수입니다.');
      const arr = p.codex[ctab] = p.codex[ctab] || [];
      if (ce === 'new') arr.push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), ...o });
      else Object.assign(arr.find(x => x.id === ce), o, { updatedAt: Date.now() });
      p.updatedAt = Date.now(); if (commit()) { ce = null; render(); }
    };
  }
};

/* ---- 문체 연구소: 통계 비교 (AI 해석 아님) ---- */
const srcs = () => [...db.projects.flatMap(p => [[`작품: ${p.title} (전체)`, p.chapters.map(c => c.text).join('\n\n')], ...p.chapters.map(c => [`${p.title} / ${c.title}`, c.text])]), ...db.analyses.map(a => ['저장된 분석: ' + a.text.slice(0, 20), a.text])];
V.style = () => { const s = srcs(); const opt = n => `<select id="${n}"><option value="">선택</option>${s.map((x, i) => `<option value="${i}">${esc(x[0])}</option>`).join('')}</select>`;
  return `<h1>문체 연구소</h1><p class="mute">아래 수치는 모두 코드로 계산한 값입니다. 문학적 경향의 AI 해석은 아직 구현되지 않았습니다.</p>
  ${s.length ? `<div class="grid g2"><div><label class="f" for="sa">A</label>${opt('sa')}</div><div><label class="f" for="sb2">B (비교, 선택)</label>${opt('sb2')}</div></div><br><button class="b" id="go">통계 계산</button><div id="res"></div><div class="row" style="margin-top:.6rem"><button class="b alt" id="sai">A의 AI 문학적 경향 분석</button></div><div id="sres"></div>` : '<p class="mute">비교할 원고나 저장된 분석이 없습니다. 먼저 원고를 쓰거나 문장 해부실에서 분석을 저장하세요.</p>'}`; };
V.bind_style = () => {
  $('#sai') && ($('#sai').onclick = async () => {
    const a = srcs()[$('#sa').value]; if (!a) return toast('A를 선택하세요.');
    if (a[1].length > MAX_AI_CHARS) return toast(`AI 분석은 ${MAX_AI_CHARS}자까지입니다. 장 단위로 선택하세요.`);
    $('#sai').disabled = true; $('#sres').innerHTML = '<p>AI 분석 중…</p>';
    try { const j = await callAPI({ mode: 'style', text: a[1] }); const f = j.feedback; if (!f || !Array.isArray(f.items) || !f.items.every(i => i && typeof i.name === 'string' && typeof i.comment === 'string')) throw new Error('AI 응답 형식이 올바르지 않습니다. 다시 시도하세요.'); $('#sres').innerHTML = fbHTML({ ...f, at: Date.now(), target: 'A 기준' }); }
    catch (e) { $('#sres').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
    $('#sai').disabled = false;
  });
  $('#go') && ($('#go').onclick = () => {
    const s = srcs(), a = s[$('#sa').value], b = s[$('#sb2').value];
    if (!a) return toast('A를 선택하세요.');
    const col = x => `<div class="card"><h3>${esc(x[0])}</h3>${x[1].trim() ? statsHTML(stats(x[1])) : '<p class="mute">내용이 비어 있습니다.</p>'}</div>`;
    const warn = a && b && Math.max(a[1].length, b[1].length) > 3 * Math.max(1, Math.min(a[1].length, b[1].length)) ? '<div class="warn">두 텍스트의 분량 차이가 3배 이상입니다. 비교 해석에 주의하세요. 장르가 다르면 수치 차이가 문체 차이가 아닐 수 있습니다.</div><br>' : '';
    $('#res').innerHTML = warn + `<div class="grid ${b ? 'g2' : ''}">${col(a)}${b ? col(b) : ''}</div>`;
  });
};
render();

/* ================= AI 훈련 피드백 + 문장 수술실 ================= */
async function callAPI(body) {
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || '요청에 실패했습니다.'), { code: j.error });
  return j;
}
let fbBusy = false, fbErr = null;
function fbHTML(f) {
  return `<div class="card"><h3>AI 피드백 <span class="tag">${esc(f.target)} 기준 · AI의 해석 · 점수 없음</span></h3>${f.items.map(i => `<div class="ai-item"><b>${esc(i.name)}</b><p>근거: ${esc(i.evidence || '-')} ${i.verified === false ? '<span class="tag" style="color:var(--danger)">원문과 정확히 일치하지 않음</span>' : ''}</p><p>${esc(i.comment)}</p></div>`).join('')}<p><b>개선할 점</b> ${esc(f.improve || '-')}</p><p class="mute">한계: ${esc(f.limits || '-')}</p><p class="mute">${fmtDate(f.at)}</p></div>`;
}
async function doFeedback(s) {
  if (fbBusy) return;
  const e = EX[s.exId], t = s.revision || s.draft;
  if (t.length > MAX_AI_CHARS) return toast(`AI 평가는 ${MAX_AI_CHARS}자까지입니다.`);
  fbBusy = true; fbErr = null; commit(); render();
  try {
    const j = await callAPI({ mode: 'evaluate', exercise: { title: e[1], goal: e[2], conditions: e[3], length: e[4] }, text: t });
    const f = j.feedback;
    if (!f || !Array.isArray(f.items) || !f.items.length || !f.items.every(i => i && typeof i.name === 'string' && typeof i.comment === 'string')) throw new Error('AI 응답 형식이 올바르지 않습니다. 다시 시도하세요.');
    s.feedback = { ...f, at: Date.now(), target: s.revision ? '수정본' : '초안' }; commit();
  } catch (x) { fbErr = x; }
  fbBusy = false; render();
}

let sx = { text: '', items: [], busy: false, err: null, target: '' };
db.revisions = db.revisions || [];
const chOpts = () => db.projects.flatMap(p => p.chapters.map(c => [p.id + '|' + c.id, p.title + ' / ' + c.title]));
const lastRev = () => [...db.revisions].reverse().find(r => !r.undone);
function syncTarget() {
  if (!sx.target) return; const [a, b] = sx.target.split('|');
  const p = db.projects.find(x => x.id === a), c = p?.chapters.find(x => x.id === b);
  if (c) { c.text = sx.text; c.updatedAt = p.updatedAt = Date.now(); }
}
V.surg = () => `<h1>문장 수술실</h1><p class="mute">AI가 수정안을 제안하고, 승인한 것만 반영됩니다. 의도된 반복과 파격은 건드리지 않도록 요청하지만 최종 판단은 작가의 몫입니다.</p>
<label class="f" for="stg">원고 불러오기 (선택 시 적용하면 해당 장에 저장됩니다)</label><select id="stg"><option value="">직접 입력</option>${chOpts().map(o => `<option value="${esc(o[0])}" ${sx.target === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>
<label class="f" for="sxt">수술 대상 텍스트 (최대 ${MAX_AI_CHARS}자)</label><textarea id="sxt" style="min-height:25vh">${esc(sx.text)}</textarea><p class="mute" id="sxc"></p>
<div class="row"><button class="b" id="sgo" ${sx.busy ? 'disabled' : ''}>문장 점검 요청</button><button class="b alt" id="sun" ${lastRev() ? '' : 'disabled'}>마지막 적용 취소</button></div>
${sx.busy ? '<p>AI 점검 중…</p>' : ''}${sx.err ? `<div class="warn">${esc(sx.err.message)}${sx.err.code === 'AI_DISABLED' ? '' : ' 다시 요청해 보세요.'}</div>` : ''}
${sx.items.map((i, n) => `<div class="card"><p><span class="tag">${esc(i.kind || '기타')}</span> ${i.verified === false ? '<span class="tag" style="color:var(--danger)">원문과 일치하지 않아 적용 불가</span>' : ''}</p><div class="grid g2"><div><p class="mute">원문</p><p><mark>${esc(i.original)}</mark></p></div><div><p class="mute">수정안</p><p><mark>${esc(i.revised)}</mark></p></div></div><p><b>수정 이유</b> ${esc(i.reason || '-')}</p><p><b>의미·분위기·리듬의 변화</b> ${esc(i.effect || '-')}</p><div class="row"><button class="b sm" data-ap="${n}" ${i.verified === false ? 'disabled' : ''}>적용</button><button class="b alt sm" data-ig="${n}">무시</button></div></div>`).join('')}
<h2>수정 이력</h2>${db.revisions.length ? [...db.revisions].reverse().slice(0, 15).map(r => `<p class="mute">${fmtDate(r.at)} · ${esc(r.original)} → ${esc(r.revised)} ${r.undone ? '(취소됨)' : ''}</p>`).join('') : '<p class="mute">적용한 수정이 없습니다.</p>'}`;
V.bind_surg = () => {
  const cnt = () => $('#sxc').textContent = `${$('#sxt').value.length}자`;
  const refresh = () => { sx.items.forEach(i => i.verified = !!i.original && sx.text.includes(i.original)); render(); };
  $('#sxt').oninput = e => { sx.text = e.target.value; cnt(); }; cnt();
  $('#stg').onchange = e => { sx.target = e.target.value; sx.items = []; if (sx.target) { const [a, b] = sx.target.split('|'); sx.text = db.projects.find(p => p.id === a)?.chapters.find(c => c.id === b)?.text || ''; } render(); };
  $('#sgo').onclick = async () => {
    if (!sx.text.trim()) return toast('텍스트를 입력하세요.');
    if (sx.text.length > MAX_AI_CHARS) return toast(`${MAX_AI_CHARS}자 이하로 줄여 주세요. 현재 ${sx.text.length}자입니다.`);
    sx.busy = true; sx.err = null; sx.items = []; render();
    try {
      const j = await callAPI({ mode: 'revise', text: sx.text });
      if (!Array.isArray(j.items) || !j.items.every(i => i && typeof i.original === 'string' && typeof i.revised === 'string')) throw new Error('AI 응답 형식이 올바르지 않습니다.');
      sx.items = j.items; if (!j.items.length) toast('수정 제안이 없습니다.');
    } catch (x) { sx.err = x; }
    sx.busy = false; render();
  };
  document.querySelectorAll('[data-ap]').forEach(b => b.onclick = () => {
    const [i] = sx.items.splice(+b.dataset.ap, 1);
    if (!sx.text.includes(i.original)) return toast('원문에서 해당 구절을 찾을 수 없습니다.');
    sx.text = sx.text.replace(i.original, () => i.revised); syncTarget();
    db.revisions.push({ id: uid(), at: Date.now(), original: i.original, revised: i.revised, reason: i.reason || '', undone: false, target: sx.target });
    if (commit()) toast('적용했습니다.'); refresh();
  });
  document.querySelectorAll('[data-ig]').forEach(b => b.onclick = () => { sx.items.splice(+b.dataset.ig, 1); render(); });
  $('#sun').onclick = () => {
    const r = lastRev(); if (!r) return;
    if (!sx.text.includes(r.revised)) return toast('현재 텍스트에서 수정된 구절을 찾을 수 없어 취소할 수 없습니다.');
    sx.text = sx.text.replace(r.revised, () => r.original); r.undone = true; syncTarget(); commit(); toast('취소했습니다.'); refresh();
  };
};

/* ---- 버전 비교용 줄 단위 diff, 훈련 제안 상태 ---- */
let nxt = { items: [], busy: false, err: null };
function diffLines(a, b) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  if (n * m > 250000) return null;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const o = []; let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { o.push([' ', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) o.push(['-', x[i++]]); else o.push(['+', y[j++]]); }
  while (i < n) o.push(['-', x[i++]]); while (j < m) o.push(['+', y[j++]]);
  return o;
}
