/* 테스트용 가짜 구글 시트 — 연결 주소에 'mock', 'mock2' … 를 넣었을 때만 쓰임.
   apps-script/Code.js 의 handleSync_ 를 그대로 부르고, 시트 대신 이 브라우저의 localStorage 에 저장한다.
   주소마다 따로 저장돼서 'mock'(우리 가족), 'mock2'(다른 가족)처럼 여러 가족 시트를 흉내 낼 수 있음.
   같은 브라우저의 여러 '테스트 기기'(?dev=a, ?dev=b)가 같은 가짜 시트를 함께 씀. */
'use strict';
(function () {
  const keyOf = url => url === 'mock' ? 'mock-sheet-v1' : `mock-sheet-v1:${url}`;
  const empty = code => ({ props: { FAMILY_CODE: code, REV: '0' }, tables: { entries: [], settings: [] } });
  const load = url => { try { return JSON.parse(localStorage.getItem(keyOf(url))) || null; } catch { return null; } };
  window.mockSheet = {
    reset(url = 'mock', code = 'test1234') { localStorage.setItem(keyOf(url), JSON.stringify(empty(code))); },
    dump: (url = 'mock') => load(url) || empty('test1234'),
    async post(bodyText, url = 'mock') {
      await new Promise(r => setTimeout(r, 150));   // 네트워크 흉내
      const d = load(url) || empty('test1234');
      const store = {
        read: name => JSON.parse(JSON.stringify(d.tables[name] || [])),
        update: (name, i, row) => { d.tables[name][i] = row; },
        append: (name, rows) => { d.tables[name].push(...rows); },
        getProp: k => d.props[k] ?? null,
        setProp: (k, v) => { d.props[k] = String(v); }
      };
      const res = handleSync_(JSON.parse(bodyText), store);   // eslint-disable-line no-undef
      localStorage.setItem(keyOf(url), JSON.stringify(d));
      return JSON.parse(JSON.stringify(res));
    }
  };
})();
