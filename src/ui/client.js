(() => {
  'use strict';

  const I18N = {
    en: {
      title: 'modelpace dashboard',
      tabQuota: 'Quota & Even Pace', tabSpeed: 'Speed Leaderboard', tabScores: 'Scores & Dispatch Audit',
      generated: 'Generated', noInstances: 'No usage snapshot available.',
      remaining: 'remaining', resetsIn: 'resets in', evenPace: 'Even Pace', pool: 'Pool', noReset: 'no reset time',
      creditCards: 'reset credit(s)', credit: 'reset credit', expires: 'expires', noCredits: 'no reset credits',
      paceSurplus: 'ahead of pace', paceBalanced: 'on pace', paceConserve: 'behind pace', paceUnknown: 'no pace data',
      speedHint: 'Median tok/s of requests with >=1000 output tokens, from local session logs.',
      rank: '#', model: 'Model', channel: 'Channel', rate: 'tok/s', short: 'Short s', requests: 'Requests',
      dispatchPass: 'Dispatch Pass', noSpeed: 'No local speed samples found.', lowSample: 'Low sample (<20 long requests)',
      showLow: 'Show {n} low-sample rows', hideLow: 'Hide low-sample rows', shareImage: 'Share Image',
      shareTitle: 'Share image', download: 'Download PNG', copy: 'Copy to clipboard', close: 'Close', copied: 'Copied',
      copyFailed: 'Copy not supported here', rows: 'Rows', noRows: 'Nothing to draw',
      scoresHint: 'Beta(1,1) pass rate with 90% interval, median task duration and nominal cost per run.',
      identity: 'Identity', task: 'Task', passRate: 'Pass rate', interval: '90% interval', n: 'n', duration: 'Median min',
      cost: 'Cost / run', noScores: 'No acceptance records.', trial: 'trial', audit: 'Latest dispatch decision',
      action: 'Action', candidate: 'Candidate', quota: 'Quota', quality: 'Quality', eligible: 'Eligible', speed: 'tok/s',
      pace: 'Pace', notes: 'Notes', noDecision: 'No dispatch decision available.', yes: 'yes', no: 'no',
      shareHeaderRate: 'tok/s', shareHeaderPass: 'Tasks passed',
      shareTitleText: 'Output Speed of the Models I Use',
      shareSubtitle: (period, omitted) => `Compiled from my local session logs · ${period} · median of requests with ≥1,000 output tokens${omitted}`,
      shareOmitted: (n, sparse) => ` · ${n} ${sparse ? 'low-sample ' : ''}model${n === 1 ? '' : 's'} not shown`,
      shareThin: 'Hatched: <20 speed samples', shareNoDispatch: 'no delegated tasks',
      shareNoteSpeed: 'Speed = output tokens (incl. thinking) ÷ request wall time (incl. time to first token, network and queueing). Real-world speed on my machine, not vendor-reported decode speed.',
      shareNotePass: 'Tasks passed = delegated tasks that were accepted with no false report, no scope violation, stopped when access was denied and at most one rework round, out of all delegated tasks (all-time).',
      shareNoteChannel: 'The tag under each name is the client the model ran through. Speed is measured separately per client.',
      shareBrand: 'Generated with modelpace', periodJoin: ' to ',
    },
    zh: {
      title: 'modelpace 仪表盘',
      tabQuota: '额度与 Even Pace', tabSpeed: '速度排行', tabScores: '验收评分与派发审计',
      generated: '生成于', noInstances: '没有可用的用量快照。',
      remaining: '剩余', resetsIn: '重置于', evenPace: 'Even Pace', pool: '池', noReset: '无重置时间',
      creditCards: '张重置卡', credit: '重置卡', expires: '到期', noCredits: '无重置卡',
      paceSurplus: '领先节奏', paceBalanced: '节奏正常', paceConserve: '落后节奏', paceUnknown: '无节奏数据',
      speedHint: '本机会话日志中输出 ≥1000 token 请求的 tok/s 中位数。',
      rank: '#', model: '模型', channel: '通道', rate: 'tok/s', short: '短请求秒', requests: '请求数',
      dispatchPass: '派发通过', noSpeed: '没有找到本地速度样本。', lowSample: '样本少（长请求 <20）',
      showLow: '展开 {n} 个样本少的行', hideLow: '收起样本少的行', shareImage: '分享图',
      shareTitle: '分享图', download: '下载 PNG', copy: '复制到剪贴板', close: '关闭', copied: '已复制',
      copyFailed: '当前环境不支持复制', rows: '行', noRows: '没有可画的行',
      scoresHint: 'Beta(1,1) 通过率及 90% 区间、任务耗时中位数与名义单次成本。',
      identity: '执行者', task: '任务', passRate: '通过率', interval: '90% 区间', n: '样本', duration: '耗时中位(分)',
      cost: '单次成本', noScores: '暂无验收记录。', trial: '试用', audit: '最近一次派发决策',
      action: '动作', candidate: '候选', quota: '额度', quality: '质量', eligible: '可用', speed: 'tok/s',
      pace: '节奏', notes: '说明', noDecision: '暂无派发决策。', yes: '是', no: '否',
      shareHeaderRate: '速率 tok/s', shareHeaderPass: '派发通过',
      shareTitleText: '我用过的模型 · 输出速率排行',
      shareSubtitle: (period, omitted) => `从本机会话日志汇总 · ${period} · 单次输出 ≥1000 token 的请求取中位数${omitted}`,
      shareOmitted: (n, sparse) => ` · 未列出 ${n} 个${sparse ? '样本 <20 次的' : ''}模型`,
      shareThin: '斜纹：速率样本 <20 次', shareNoDispatch: '没有派发记录',
      shareNoteSpeed: '速率 = 输出 token（含思考）÷ 单次请求耗时（含首字等待、网络与排队），是这台机器上的实际体验，不是厂商标称的纯生成速度。',
      shareNotePass: '派发通过 = 派发给该模型的任务中，复核通过、未虚报、未越界、遇授权拒绝即停、返工不超过 1 轮的次数 / 派发次数（全部历史）。',
      shareNoteChannel: '名称下方标签为调用通道（客户端），同一模型经不同通道调用时速率分开统计。',
      shareBrand: '由 modelpace 生成', periodJoin: ' 至 ',
    },
  };

  const VENDORS = {
    anthropic: { name: 'Anthropic', color: '#d95926' },
    google: { name: 'Google', color: '#4a90f0' },
    openai: { name: 'OpenAI', color: '#199e70' },
    deepseek: { name: 'DeepSeek', color: '#c060c0' },
    xai: { name: 'xAI', color: '#d4a017' },
    other: { name: 'Other', color: '#8a93a3' },
  };
  const VENDOR_ORDER = Object.values(VENDORS);
  const CHANNELS = {
    claude: ['Claude Code', VENDORS.anthropic.color], antigravity: ['Antigravity', VENDORS.google.color],
    codex: ['Codex', VENDORS.openai.color], grok: ['Grok CLI', VENDORS.xai.color], opencode: ['OpenCode', VENDORS.other.color],
  };
  const EM_DASH = '—';
  const KEY_LANG = 'modelpace:lang';
  const KEY_TAB = 'modelpace:tab';
  const KEY_ROWS = 'modelpace:share-rows:v1';

  const store = {
    get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* 无存储时只是不记忆 */ } },
  };

  let data = JSON.parse(document.getElementById('t3d-data').textContent);
  let lang = store.get(KEY_LANG) === 'zh' ? 'zh' : 'en';
  let tab = ['quota', 'speed', 'scores'].includes(store.get(KEY_TAB)) ? store.get(KEY_TAB) : 'quota';
  let showLow = false;
  let modal = null;

  const t = (key) => I18N[lang][key];
  const root = document.getElementById('t3d-root');

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') el.className = value;
      else if (name === 'style') el.setAttribute('style', value);
      else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // ---- 格式化 ----
  const pct = (value, digits = 0) => `${Number(value).toFixed(digits)}%`;
  const num = (value, digits = 1) => (value === null || value === undefined ? EM_DASH : Number(value).toFixed(digits));
  function duration(mins) {
    if (mins === null || mins === undefined) return t('noReset');
    if (mins <= 0) return '0m';
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = Math.floor(mins % 60);
    if (days) return `${days}d ${hours}h`;
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  const resetsInMins = (win) => (win.resetsAtMs === null ? null : (win.resetsAtMs - Date.now()) / 60000);

  // ---- 厂商与模型名 ----
  function vendorOf(model) {
    const id = model.slice(model.lastIndexOf('/') + 1).toLowerCase();
    if (id.startsWith('claude')) return VENDORS.anthropic;
    if (id.startsWith('gemini')) return VENDORS.google;
    if (id.startsWith('gpt') || id.startsWith('codex') || /^o\d/.test(id)) return VENDORS.openai;
    if (id.startsWith('deepseek')) return VENDORS.deepseek;
    if (id.startsWith('grok')) return VENDORS.xai;
    return VENDORS.other;
  }
  const channelOf = (provider) => {
    const [label, color] = CHANNELS[provider] ?? [provider, VENDORS.other.color];
    return { label, color };
  };
  function titleToken(token) {
    const lower = token.toLowerCase();
    if (lower === 'gpt') return 'GPT';
    if (lower === 'oss') return 'OSS';
    if (lower === 'deepseek') return 'DeepSeek';
    if (/^\d+[a-z]$/.test(lower)) return token.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
  }
  function displayName(model) {
    const id = model.slice(model.lastIndexOf('/') + 1).replace(/-\d{8}$/, '');
    const words = [];
    let digits = [];
    const flush = () => { if (digits.length) words.push(digits.join('.')); digits = []; };
    for (const token of id.split('-')) {
      if (/^\d+$/.test(token)) { digits.push(token); continue; }
      flush();
      words.push(titleToken(token));
    }
    flush();
    return words[0] === 'GPT' && words[1] && /^(\d|OSS$)/.test(words[1])
      ? [`GPT-${words[1]}`, ...words.slice(2)].join(' ')
      : words.join(' ');
  }
  const rowKey = (row) => JSON.stringify([row.provider, row.model, row.tier ?? null]);
  const rowName = (row) => `${displayName(row.model)}${row.tier ? ` (${row.tier})` : ''}`;
  const passText = (row) => (row.dispatch ? `${row.dispatch.successes}/${row.dispatch.total}` : EM_DASH);

  // ---- Tab 1：额度与 Even Pace ----
  const PACE_TEXT = { surplus: 'paceSurplus', balanced: 'paceBalanced', conserve: 'paceConserve', unknown: 'paceUnknown' };
  function windowBar(win) {
    const remaining = Math.max(0, Math.min(100, win.effectiveRemainingPercent));
    const mins = resetsInMins(win);
    return h('div', { class: 'win' },
      h('div', { class: 'win-head' },
        h('span', { class: 'win-label' }, win.label, win.pool ? h('span', { class: 'tag' }, `${t('pool')}: ${win.pool}`) : null),
        h('span', { class: 'win-meta' }, `${pct(remaining)} ${t('remaining')} · ${t('resetsIn')} ${duration(mins)}`)),
      h('div', { class: `bar pace-${win.pace}`, role: 'img', 'aria-label': `${win.label} ${pct(remaining)}` },
        h('div', { class: 'bar-fill', style: `width:${remaining}%` }),
        win.remainingTimePercent === null ? null
          : h('div', { class: 'even-pace', style: `left:${Math.max(0, Math.min(100, win.remainingTimePercent))}%`, title: `${t('evenPace')} ${pct(win.remainingTimePercent)}` })),
      h('div', { class: 'win-foot' },
        h('span', { class: `pace-text pace-${win.pace}` }, t(PACE_TEXT[win.pace] ?? 'paceUnknown')),
        win.remainingTimePercent === null ? null : h('span', null, `${t('evenPace')} ${pct(win.remainingTimePercent)}`)));
  }

  function creditLine(credits) {
    if (!credits || !credits.known) return null;
    if (!credits.availableCount) return h('div', { class: 'credits muted' }, t('noCredits'));
    return h('div', { class: 'credits' },
      `${credits.availableCount} ${t('creditCards')}`,
      credits.nextExpiresAt ? ` · ${t('expires')} ${credits.nextExpiresAt.slice(0, 10)}` : '');
  }

  function renderQuota() {
    const { instances, pools } = data.quota;
    if (!instances.length) return h('p', { class: 'empty' }, t('noInstances'));
    const cards = instances.map((inst) =>
      h('section', { class: 'card' },
        h('header', null, h('h3', null, inst.displayName), h('span', { class: `status status-${inst.status}` }, inst.status),
          inst.plan ? h('span', { class: 'muted' }, inst.plan) : null),
        inst.windows.length ? inst.windows.map(windowBar) : h('p', { class: 'muted' }, t('paceUnknown')),
        creditLine(inst.resetCredits)));
    const poolCards = pools.map((pool) =>
      h('section', { class: 'card' },
        h('header', null, h('h3', null, `${t('pool')}: ${pool.pool}`)),
        pool.windows.map((entry) => h('div', null, h('div', { class: 'muted small' }, entry.instance), windowBar(entry.window)))));
    return h('div', { class: 'grid' }, cards, poolCards);
  }

  // ---- Tab 2：速度排行 ----
  function renderSpeed() {
    const rows = data.speed.ranking;
    if (!rows.length) return h('p', { class: 'empty' }, t('noSpeed'));
    const solid = rows.filter((row) => !row.lowSample);
    const split = solid.length === 0 ? { solid: rows, sparse: [] } : { solid, sparse: rows.filter((row) => row.lowSample) };
    const visible = showLow ? [...split.solid, ...split.sparse] : split.solid;
    const max = Math.max(1, ...rows.map((row) => row.longRate ?? row.allRate ?? 0));
    const body = visible.map((row, index) => {
      const rate = row.longRate ?? row.allRate ?? 0;
      const color = vendorOf(row.model).color;
      const channel = channelOf(row.provider);
      return h('tr', null,
        h('td', { class: 'num muted' }, index + 1),
        h('td', null, h('div', null, rowName(row)), h('span', { class: 'chip', style: `color:${channel.color};border-color:${channel.color}` }, channel.label)),
        h('td', { class: 'bar-cell' }, h('div', { class: `speed-bar${row.lowSample ? ' hatched' : ''}`, style: `width:${(rate / max) * 100}%;--c:${color}`, title: row.lowSample ? t('lowSample') : null })),
        h('td', { class: 'num strong' }, num(row.longRate ?? row.allRate)),
        h('td', { class: 'num' }, num(row.shortSeconds, 2)),
        h('td', { class: 'num' }, `${row.longRequests}/${row.requests}`),
        h('td', { class: 'num' }, passText(row)));
    });
    const toggle = split.sparse.length
      ? h('button', { class: 'btn', onclick: () => { showLow = !showLow; render(); } },
          showLow ? t('hideLow') : t('showLow').replace('{n}', split.sparse.length))
      : null;
    return h('div', null,
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, t('speedHint')),
        h('button', { class: 'btn primary', onclick: openShare }, t('shareImage'))),
      h('table', null,
        h('thead', null, h('tr', null, [t('rank'), t('model'), '', t('rate'), t('short'), t('requests'), t('dispatchPass')].map((label, i) => h('th', { class: i > 2 ? 'num' : '' }, label)))),
        h('tbody', null, body)),
      toggle,
      data.speed.warnings.length ? h('ul', { class: 'muted small' }, data.speed.warnings.map((w) => h('li', null, w))) : null);
  }

  // ---- Tab 3：验收评分与派发审计 ----
  function renderScores() {
    const { cells, minSamples } = data.scores;
    const intervalBar = (cell) => (cell.interval90
      ? h('div', { class: 'ci' }, h('div', { class: 'ci-range', style: `left:${cell.interval90[0] * 100}%;width:${(cell.interval90[1] - cell.interval90[0]) * 100}%` }),
          h('div', { class: 'ci-dot', style: `left:${cell.passRate * 100}%` }))
      : h('span', { class: 'muted' }, t('trial')));
    const scoreRows = cells.map((cell) => h('tr', null,
      h('td', null, cell.identity), h('td', null, cell.task),
      h('td', { class: 'num strong' }, cell.passRate === null ? `${t('trial')} (<${minSamples})` : pct(cell.passRate * 100, 1)),
      h('td', { class: 'ci-cell' }, intervalBar(cell)),
      h('td', { class: 'num' }, `${cell.n} (${cell.s}/${cell.f})`),
      h('td', { class: 'num' }, num(cell.durationMedianMin)),
      h('td', { class: 'num' }, cell.costMedian === null ? EM_DASH : `${cell.costCurrency} ${cell.costMedian.toFixed(2)}`)));
    const scoresTable = cells.length
      ? h('table', null, h('thead', null, h('tr', null, [t('identity'), t('task'), t('passRate'), t('interval'), t('n'), t('duration'), t('cost')].map((l, i) => h('th', { class: i > 1 && i !== 3 ? 'num' : '' }, l)))), h('tbody', null, scoreRows))
      : h('p', { class: 'empty' }, t('noScores'));

    const decision = data.decision;
    const audit = decision
      ? h('div', null,
          h('p', null, h('strong', null, `${t('action')}: ${decision.action}`),
            decision.recommended ? ` → ${decision.recommended.instanceId} / ${decision.recommended.model}` : '',
            h('span', { class: 'muted' }, ` · slot=${decision.slot} task=${decision.task}${decision.tier ? ` tier=${decision.tier}` : ''}`)),
          h('table', null,
            h('thead', null, h('tr', null, [t('candidate'), t('quota'), t('quality'), t('eligible'), t('speed'), t('pace'), t('notes')].map((l, i) => h('th', { class: i > 3 && i < 6 ? 'num' : '' }, l)))),
            h('tbody', null, decision.candidates.map((c) => h('tr', { class: c.eligible ? '' : 'dim' },
              h('td', null, `${c.candidateId} (${c.instanceId}/${c.model})`), h('td', null, c.quotaState), h('td', null, c.qualityTier ?? EM_DASH),
              h('td', null, c.eligible ? t('yes') : t('no')), h('td', { class: 'num' }, num(c.speedLongRate)), h('td', { class: 'num' }, num(c.paceScore, 2)),
              h('td', { class: 'small' }, [...c.rejectionReasons, ...c.warnings].join('; ')))))))
      : h('p', { class: 'empty' }, t('noDecision'));
    return h('div', null, h('p', { class: 'muted' }, t('scoresHint')), scoresTable, h('h3', { class: 'section' }, t('audit')), audit);
  }

  // ---- 分享图 ----
  const shareDefaults = () => {
    const candidates = data.speed.ranking.filter((row) => row.longRate !== null);
    const solid = candidates.filter((row) => !row.lowSample);
    return new Set((solid.length ? solid : candidates).map(rowKey));
  };
  function readChoices() {
    try { return JSON.parse(store.get(KEY_ROWS) ?? '{}') ?? {}; } catch { return {}; }
  }
  function shareOptions() {
    const candidates = data.speed.ranking.filter((row) => row.longRate !== null);
    const defaults = shareDefaults();
    const choices = readChoices();
    const options = candidates.map((row) => ({ row, key: rowKey(row), checked: choices[rowKey(row)] ?? defaults.has(rowKey(row)) }));
    return options.some((o) => o.checked) ? options : options.map((o) => ({ ...o, checked: defaults.has(o.key) }));
  }
  function buildShare(options) {
    const chosen = options.filter((o) => o.checked).map((o) => o.row);
    const hidden = data.speed.ranking.filter((row) => !chosen.includes(row));
    const rows = chosen.map((row, index) => ({
      rank: index + 1, name: rowName(row), channel: channelOf(row.provider), color: vendorOf(row.model).color,
      rate: row.longRate, thin: row.lowSample, dispatch: row.dispatch ? passText(row) : null,
    }));
    const present = new Set(chosen.map((row) => vendorOf(row.model).name));
    const maxRate = Math.max(0, ...rows.map((row) => row.rate));
    const steps = [10, 20, 50, 100, 200, 500, 1000, 2000];
    const step = steps.find((s) => Math.ceil(maxRate / s) <= 5) ?? 2000;
    const max = Math.max(maxRate * 1.05, step);
    const ticks = [];
    for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
    const showDispatch = rows.some((row) => row.dispatch !== null);
    const period = `${data.speed.sinceDay}${t('periodJoin')}${data.speed.untilDay}`;
    return {
      rows, showDispatch, axis: { max, ticks }, vendors: VENDOR_ORDER.filter((v) => present.has(v.name)),
      title: t('shareTitleText'),
      subtitle: t('shareSubtitle')(period, hidden.length ? t('shareOmitted')(hidden.length, hidden.every((row) => row.lowSample)) : ''),
      thinKey: rows.some((row) => row.thin) ? t('shareThin') : null,
      noDispatchKey: showDispatch && rows.some((row) => row.dispatch === null) ? `${EM_DASH}: ${t('shareNoDispatch')}` : null,
      notes: [t('shareNoteSpeed'), ...(showDispatch ? [t('shareNotePass')] : []), t('shareNoteChannel')],
      brand: t('shareBrand'), headerRate: t('shareHeaderRate'), headerPass: t('shareHeaderPass'),
    };
  }

  const W = 1200, SCALE = 2, PAD = 60, ROW_H = 58;
  const FONT = '-apple-system, system-ui, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", sans-serif';
  const RANK_R = PAD + 30, NAME_R = RANK_R + 16 + 290, TRACK_L = NAME_R + 16, TRACK_W = 528;
  const RATE_R = TRACK_L + TRACK_W + 16 + 72, PASS_R = RATE_R + 16 + 96, CONTENT_W = W - PAD * 2;
  const WORD = /[（「『《【]*(?:[　-鿿＀-￯]|[^\s　-鿿＀-￯]+)[，。、；：）」』》】！？]*\s*/g;

  function wrap(measure, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const piece of text.match(WORD) ?? []) {
      if (line !== '' && measure((line + piece).trimEnd()) > maxWidth) { lines.push(line.trimEnd()); line = piece.trimStart(); } else line += piece;
    }
    if (line !== '') lines.push(line.trimEnd());
    return lines;
  }
  function alpha(color, a) {
    const v = Number.parseInt(color.slice(1), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }
  function hatch(ctx, x, y, w, hgt, color) {
    const length = (w + hgt) * Math.SQRT1_2;
    const cx = x + w / 2, cy = y + hgt / 2, dx = Math.SQRT1_2 * (length / 2);
    const g = ctx.createLinearGradient(cx - dx, cy + dx, cx + dx, cy - dx);
    for (let at = 0; at < length; at += 11) {
      g.addColorStop(at / length, color);
      g.addColorStop(Math.min(1, (at + 6) / length), color);
      if ((at + 6) / length < 1) {
        g.addColorStop(Math.min(1, (at + 6) / length), 'rgba(0,0,0,0)');
        g.addColorStop(Math.min(1, (at + 11) / length), 'rgba(0,0,0,0)');
      }
    }
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, hgt);
  }
  function drawShare(ctx, s, height) {
    const text = (value, x, cy, { size, weight = 400, color, spacing = 0 }, align = 'left') => {
      ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
      ctx.letterSpacing = `${spacing}px`; ctx.fillText(value, x, cy);
      return ctx.measureText(value).width;
    };
    const measure = (value, size, weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}`; ctx.letterSpacing = '0px'; return ctx.measureText(value).width; };
    ctx.fillStyle = '#0d0f13'; ctx.fillRect(0, 0, W, height);
    ctx.save(); ctx.translate(W * 0.15, -50); ctx.scale(1, 500 / 1200);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1200);
    glow.addColorStop(0, '#1a2233'); glow.addColorStop(0.6, 'rgba(26, 34, 51, 0)');
    ctx.fillStyle = glow; ctx.fillRect(-W, -1200, W * 3, 2400 + height * 3); ctx.restore();

    let y = 52;
    const badgeW = measure('modelpace', 14) + 26;
    ctx.strokeStyle = '#2c3445'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(PAD + 0.5, y + 0.5, badgeW - 1, 26, 13); ctx.stroke();
    text('modelpace', PAD + 13, y + 13.5, { size: 14, color: '#aab4c6', spacing: 0.6 });
    y += 43;
    text(s.title, PAD, y + 24, { size: 40, weight: 700, color: '#e9ecf1', spacing: 0.3 });
    y += 58;
    for (const line of wrap((v) => measure(v, 18), s.subtitle, CONTENT_W)) { text(line, PAD, y + 11, { size: 18, color: '#9aa3b2' }); y += 22; }
    y += 22;
    let x = PAD;
    for (const vendor of s.vendors) {
      ctx.fillStyle = vendor.color; ctx.beginPath(); ctx.roundRect(x, y + 3.5, 12, 12, 3); ctx.fill();
      x += 19; x += text(vendor.name, x, y + 9.5, { size: 16, color: '#c7cdd8' }) + 22;
    }
    y += 45;
    for (const tick of s.axis.ticks) text(String(tick), TRACK_L + (tick / s.axis.max) * TRACK_W, y + 12, { size: 13, color: '#7d8697' }, 'center');
    text(s.headerRate, RATE_R, y + 13, { size: 13, color: '#7d8697' }, 'right');
    if (s.showDispatch) text(s.headerPass, PASS_R, y + 13, { size: 13, color: '#7d8697' }, 'right');
    y += 26;
    const top0 = y, bottom0 = y + s.rows.length * ROW_H;
    ctx.fillStyle = '#232834';
    for (const tick of s.axis.ticks) if (tick > 0) ctx.fillRect(TRACK_L + (tick / s.axis.max) * TRACK_W - 0.5, top0, 1, bottom0 - top0);
    for (const row of s.rows) {
      const top = y + 6;
      text(String(row.rank), RANK_R, y + 29, { size: 17, color: '#5f6779' }, 'right');
      text(row.name, NAME_R, top + 12, { size: 20, color: '#dfe3ea' }, 'right');
      const chipW = measure(row.channel.label, 12.5, 600) + 14, chipX = NAME_R - chipW;
      ctx.beginPath(); ctx.roundRect(chipX, top + 28, chipW, 18, 5); ctx.fillStyle = alpha(row.channel.color, 0.12); ctx.fill();
      ctx.strokeStyle = alpha(row.channel.color, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(chipX + 0.5, top + 28.5, chipW - 1, 17, 4.5); ctx.stroke();
      text(row.channel.label, chipX + 7, top + 37.5, { size: 12.5, weight: 600, color: row.channel.color });
      const barW = (row.rate / s.axis.max) * TRACK_W;
      ctx.save(); ctx.beginPath(); ctx.roundRect(TRACK_L, y + 17, barW, 24, [0, 6, 6, 0]);
      if (row.thin) {
        ctx.clip(); hatch(ctx, TRACK_L, y + 17, barW, 24, row.color); ctx.restore();
        ctx.strokeStyle = row.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(TRACK_L + 0.75, y + 17.75, barW - 1.5, 22.5, [0, 5.25, 5.25, 0]); ctx.stroke();
      } else { ctx.fillStyle = row.color; ctx.fill(); ctx.restore(); }
      text(row.rate.toFixed(1), RATE_R, y + 29, { size: 21, weight: 700, color: '#e9ecf1' }, 'right');
      if (s.showDispatch) text(row.dispatch ?? EM_DASH, PASS_R, y + 29, { size: 17, color: '#aeb6c4' }, 'right');
      y += ROW_H;
    }
    y += 26; ctx.fillStyle = '#232834'; ctx.fillRect(PAD, y, CONTENT_W, 1); y += 19;
    const lh = 26.25;
    const keys = [s.thinKey, s.noDispatchKey].filter(Boolean);
    if (keys.length) { let kx = PAD; for (const key of keys) kx += text(key, kx, y + lh / 2, { size: 15, color: '#b5bcc8' }) + 22; y += lh + 6; }
    for (const note of s.notes) for (const line of wrap((v) => measure(v, 15), note, CONTENT_W)) { text(line, PAD, y + lh / 2, { size: 15, color: '#8a93a3' }); y += lh; }
    y += 12; text(s.brand, PAD, y + lh / 2, { size: 15, color: '#c5ccd8' }); y += lh;
    return y + 40;
  }
  function renderShareBlob(share) {
    const scratch = document.createElement('canvas').getContext('2d');
    const height = Math.ceil(drawShare(scratch, share, 0));
    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE; canvas.height = height * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    drawShare(ctx, share, height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'));
  }

  function openShare() { modal = { status: '' }; render(); updateShare(); }
  async function updateShare() {
    if (!modal) return;
    const options = shareOptions();
    const share = buildShare(options);
    const holder = document.getElementById('t3d-share-preview');
    if (!holder) return;
    holder.textContent = '';
    if (!share.rows.length) { holder.append(h('p', { class: 'empty' }, t('noRows'))); modal.blob = null; return; }
    modal.blob = await renderShareBlob(share);
    modal.url && URL.revokeObjectURL(modal.url);
    modal.url = URL.createObjectURL(modal.blob);
    holder.append(h('img', { src: modal.url, alt: share.title, class: 'share-img' }));
  }
  function setChoice(key, checked) {
    const choices = readChoices();
    choices[key] = checked;
    store.set(KEY_ROWS, JSON.stringify(choices));
    const list = shareOptions();
    if (!list.some((o) => o.checked)) { choices[key] = true; store.set(KEY_ROWS, JSON.stringify(choices)); }
    render(); updateShare();
  }
  function renderModal() {
    const options = shareOptions();
    const onlyOne = options.filter((o) => o.checked).length === 1;
    const close = () => { if (modal.url) URL.revokeObjectURL(modal.url); modal = null; render(); };
    return h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('shareTitle') },
        h('div', { class: 'modal-head' }, h('h3', null, t('shareTitle')),
          h('div', { class: 'seg' }, ['en', 'zh'].map((code) => h('button', { class: code === lang ? 'on' : '', onclick: () => setLang(code) }, code.toUpperCase()))),
          h('button', { class: 'btn', onclick: close }, t('close'))),
        h('div', { class: 'modal-body' },
          h('div', { class: 'picker' }, h('div', { class: 'muted small' }, t('rows')),
            options.map((o) => h('label', { class: 'pick' },
              h('input', { type: 'checkbox', checked: o.checked, disabled: onlyOne && o.checked, onchange: (e) => setChoice(o.key, e.target.checked) }),
              h('span', null, `${rowName(o.row)} · ${channelOf(o.row.provider).label} (${o.row.longRequests})`)))),
          h('div', { id: 't3d-share-preview', class: 'preview' })),
        h('div', { class: 'modal-foot' },
          h('span', { class: 'muted small' }, modal.status),
          h('button', { class: 'btn', onclick: copyShare }, t('copy')),
          h('button', { class: 'btn primary', onclick: downloadShare }, t('download')))));
  }
  function downloadShare() {
    if (!modal?.blob) return;
    const a = h('a', { href: modal.url, download: `model-speed-${data.speed.untilDay}-${lang}.png` });
    document.body.append(a); a.click(); a.remove();
  }
  async function copyShare() {
    if (!modal?.blob) return;
    let status = t('copied');
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': modal.blob })]); } catch { status = t('copyFailed'); }
    modal.status = status;
    const foot = document.querySelector('.modal-foot .muted');
    if (foot) foot.textContent = status;
  }

  // ---- 外壳 ----
  function setLang(code) {
    lang = code; store.set(KEY_LANG, lang);
    document.documentElement.lang = lang;
    render(); updateShare();
  }
  function render() {
    document.title = t('title');
    const tabs = [['quota', 'tabQuota'], ['speed', 'tabSpeed'], ['scores', 'tabScores']];
    const views = { quota: renderQuota, speed: renderSpeed, scores: renderScores };
    root.replaceChildren(
      h('header', { class: 'top' },
        h('h1', null, t('title')),
        h('span', { class: 'muted small' }, `${t('generated')} ${data.generatedAt.slice(0, 19).replace('T', ' ')} UTC`),
        h('div', { class: 'seg lang' }, ['en', 'zh'].map((code) => h('button', { class: code === lang ? 'on' : '', onclick: () => setLang(code) }, code.toUpperCase())))),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([id, key]) => h('button', {
        role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', class: id === tab ? 'on' : '',
        onclick: () => { tab = id; store.set(KEY_TAB, id); render(); },
      }, t(key)))),
      h('main', { role: 'tabpanel' }, views[tab]()),
      ...(modal ? [renderModal()] : []));
  }

  render();
  if (data.live) {
    // 独立服务走 fetch；在宿主插件视图里没有同源接口，改经桥取数。
    const fetchData = async () => {
      if (globalThis.t3dBridgeCall) return globalThis.t3dBridgeCall('data');
      const response = await fetch('api/data', { cache: 'no-store' });
      if (!response.ok) throw new Error('refresh failed');
      return response.json();
    };
    setInterval(async () => {
      if (modal) return;
      try {
        data = await fetchData();
        render();
      } catch { /* 服务暂不可达时保留当前画面 */ }
    }, 15000);
  }
})();
