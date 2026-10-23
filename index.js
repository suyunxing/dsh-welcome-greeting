/**
 * Host half of the welcome-greeting bundle.
 *
 * The browser half cannot reach the network, cannot read this plugin's row
 * config, and cannot call a model, so this half owns all three: it resolves the
 * visitor's place, fetches the current weather, and asks the model that the New
 * Session composer is set to for one short greeting built from that context.
 *
 * The model call is deliberately the cheapest shape the `llm` service allows:
 * one user message, one short system line, no tool schemas at all, a small
 * output cap, and the route's least-supported reasoning effort. Results are
 * cached per clock-hour and weather bucket, so a page reload costs nothing.
 *
 * Every step is best effort. With no network or no model the browser half falls
 * back to a locally composed greeting from the clock alone.
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULT_GREETINGS = [
  { from: 5, to: 9, text: '早上好' },
  { from: 9, to: 11, text: '上午好' },
  { from: 11, to: 13, text: '中午好' },
  { from: 13, to: 18, text: '下午好' },
  { from: 18, to: 23, text: '晚上好' },
  { from: 23, to: 5, text: '夜深了' },
];

/** WMO weather interpretation codes, as open-meteo reports them. */
const WMO_TEXT = {
  0: '晴',
  1: '大致晴朗',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛雨',
  53: '毛毛雨',
  55: '密毛雨',
  56: '冻毛雨',
  57: '冻毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '雷暴伴冰雹',
};

/**
 * The whole instruction set for the model. It is one line on purpose: the point
 * of this plugin is a cheap greeting, so nothing else is sent — no tool schemas,
 * no harness system prompt, no history.
 */
const DEFAULT_SYSTEM =
  '你是他的女朋友，很爱他。根据背景（时间、他在哪、那边天气），写一句中文情话向他问候，温柔有爱意。' +
  '长度：以10个字为目标，最多不超过20个字，只写一小句，像短信那样短。' +
  '不要说出城市名，不要报温度数字，也不要复述天气；把这些化成一句具体的关心——风凉、太阳好、添件外套、喝口温水、早点睡。' +
  '只输出这一句话，不要引号，不要解释。';

/**
 * The same request restated inside the user turn. Providers differ in how much
 * weight a short system line carries — one adapter routes the system prompt into
 * history, and a model given only facts tends to answer them like a task — so the
 * instruction travels with the facts as well.
 */
const DEFAULT_ASK =
  '请以女朋友的身份，结合上面的背景，对他说一句饱含爱意的问候。' +
  '要求：只写一小句，10个字左右，最多不超过20个字；不要提城市名，不要说温度数字，不要复述天气，用侧面的话把关心说出来。只输出这一句话。';

/**
 * Reasoning effort ids, cheapest first. Adapters advertise their efforts in
 * whatever order they like (one lists `high` first), so the least-supported
 * effort is found by rank rather than by array position.
 */
const EFFORT_RANK = ['none', 'minimal', 'min', 'low', 'light', 'medium', 'mid', 'high', 'max', 'xhigh'];

const DEFAULTS = {
  enabled: true,
  /** Empty string means "detect from the public IP address". */
  city: '',
  latitude: null,
  longitude: null,
  /** Empty string means "let open-meteo follow the coordinates". */
  timezone: '',
  /**
   * Explicit place/weather/temperature in the fallback line. Off by default: the
   * greeting should show care rather than a weather report. Turn on to append
   * the plain "city · sky 16°C" form.
   */
  showCity: false,
  showWeather: false,
  showTemp: false,
  /** Empty string selects the built-in composition. */
  template: '',
  /** Minutes the resolved place and weather stay cached before a refetch. */
  refreshMinutes: 15,
  greetings: DEFAULT_GREETINGS,
  /** Shown when nothing at all could be resolved; empty keeps the built-in headline. */
  fallback: '',
  /** Ask a model for the sentence instead of composing it locally. */
  useLlm: true,
  /** Empty strings follow the New Session default model. */
  llmProvider: '',
  llmModel: '',
  /** Minutes a generated sentence stays cached. */
  greetingMinutes: 60,
  greetingSystem: DEFAULT_SYSTEM,
  /** Appended to the user turn so the instruction survives a dropped system line. */
  greetingAsk: DEFAULT_ASK,
  greetingMaxTokens: 120,
  /** Hard character cap for the sentence; the model is asked for ~10 chars. */
  greetingMaxChars: 22,
  greetingTimeoutMs: 20000,
};

function settings(config) {
  const given = config !== null && typeof config === 'object' ? config : {};
  const merged = { ...DEFAULTS, ...given };
  merged.refreshMinutes = clamp(Number(merged.refreshMinutes), 1, 720, DEFAULTS.refreshMinutes);
  merged.greetingMinutes = clamp(Number(merged.greetingMinutes), 1, 1440, DEFAULTS.greetingMinutes);
  merged.greetingMaxTokens = clamp(Number(merged.greetingMaxTokens), 16, 4096, DEFAULTS.greetingMaxTokens);
  merged.greetingMaxChars = clamp(Number(merged.greetingMaxChars), 4, 200, DEFAULTS.greetingMaxChars);
  merged.greetingTimeoutMs = clamp(Number(merged.greetingTimeoutMs), 1000, 120000, DEFAULTS.greetingTimeoutMs);
  merged.city = typeof merged.city === 'string' ? merged.city.trim() : '';
  merged.template = typeof merged.template === 'string' ? merged.template : '';
  merged.fallback = typeof merged.fallback === 'string' ? merged.fallback : '';
  merged.timezone = typeof merged.timezone === 'string' ? merged.timezone.trim() : '';
  merged.llmProvider = typeof merged.llmProvider === 'string' ? merged.llmProvider.trim() : '';
  merged.llmModel = typeof merged.llmModel === 'string' ? merged.llmModel.trim() : '';
  merged.greetingSystem =
    typeof merged.greetingSystem === 'string' && merged.greetingSystem.trim() !== ''
      ? merged.greetingSystem
      : DEFAULT_SYSTEM;
  merged.greetingAsk =
    typeof merged.greetingAsk === 'string' && merged.greetingAsk.trim() !== '' ? merged.greetingAsk : DEFAULT_ASK;
  merged.latitude = toNumber(merged.latitude);
  merged.longitude = toNumber(merged.longitude);
  merged.greetings =
    Array.isArray(merged.greetings) && merged.greetings.length > 0
      ? merged.greetings
          .filter((row) => row !== null && typeof row === 'object' && typeof row.text === 'string')
          .map((row) => ({ from: clamp(Number(row.from), 0, 23, 0), to: clamp(Number(row.to), 0, 23, 0), text: row.text }))
      : DEFAULT_GREETINGS;
  return merged;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pad(value) {
  return value < 10 ? `0${value}` : String(value);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'dsh-welcome-greeting/1.0' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Keyless place lookups, tried in order; each returns coordinates and, when known, a city. */
const PLACE_PROVIDERS = [
  async function fromIpinfo() {
    const body = await fetchJson('https://ipinfo.io/json', 5000);
    const [lat, lon] = String(body.loc || '').split(',');
    return { city: clean(body.city), region: clean(body.region), country: clean(body.country), latitude: toNumber(lat), longitude: toNumber(lon) };
  },
  async function fromGeojs() {
    const body = await fetchJson('https://get.geojs.io/v1/ip/geo.json', 5000);
    return { city: clean(body.city), region: clean(body.region), country: clean(body.country), latitude: toNumber(body.latitude), longitude: toNumber(body.longitude) };
  },
  async function fromIpwho() {
    const body = await fetchJson('https://ipwho.is/', 5000);
    if (body.success === false) throw new Error('ipwho refused the lookup');
    return { city: clean(body.city), region: clean(body.region), country: clean(body.country), latitude: toNumber(body.latitude), longitude: toNumber(body.longitude) };
  },
];

async function detectPlace() {
  for (const provider of PLACE_PROVIDERS) {
    try {
      const place = await provider();
      if (place.latitude !== null && place.longitude !== null) return await localize({ ...place, source: 'ip' });
    } catch {
      // try the next provider
    }
  }
  return null;
}

/**
 * IP databases answer in English ("Shenyang"), which reads badly inside a
 * Chinese greeting. Geocoding the same name with `language=zh` yields the local
 * spelling; the IP coordinates are kept because they are the more precise pair.
 */
async function localize(place) {
  if (typeof place.city !== 'string' || !/^[\x20-\x7e]+$/.test(place.city)) return place;
  const hit = await geocodeCity(place.city);
  if (hit === null) return place;
  return {
    ...place,
    city: hit.city ?? place.city,
    region: hit.region ?? place.region,
    country: /^[A-Za-z]{2}$/.test(place.country ?? '') ? (hit.country ?? place.country) : place.country,
  };
}

async function geocodeCity(city) {
  try {
    const body = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      6000,
    );
    const hit = Array.isArray(body.results) ? body.results[0] : undefined;
    if (hit === undefined) return null;
    return {
      city: clean(hit.name) ?? city,
      region: clean(hit.admin1),
      country: clean(hit.country),
      latitude: toNumber(hit.latitude),
      longitude: toNumber(hit.longitude),
      source: 'geocode',
    };
  } catch {
    return null;
  }
}

async function fetchWeather(latitude, longitude, timezone) {
  try {
    const zone = timezone !== '' ? encodeURIComponent(timezone) : 'auto';
    const body = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,weather_code&timezone=${zone}`,
      7000,
    );
    const current = body.current ?? {};
    const code = toNumber(current.weather_code);
    return {
      tempC: toNumber(current.temperature_2m),
      code,
      text: code === null ? undefined : WMO_TEXT[code] ?? '未知天气',
      timezone: clean(body.timezone),
    };
  } catch {
    return null;
  }
}

/** The facts handed to the model: clock, place, weather. Nothing else. */
function contextFor(now, place, weather) {
  const parts = [`现在是${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}（${WEEKDAYS[now.getDay()]}）`];
  const city = clean(place?.city);
  if (city !== undefined) parts.push(`他在${city}`);
  const text = clean(weather?.text);
  const temp = typeof weather?.tempC === 'number' ? Math.round(weather.tempC) : null;
  if (text !== undefined && temp !== null) parts.push(`当地${text}，${temp}℃`);
  else if (text !== undefined) parts.push(`当地${text}`);
  else if (temp !== null) parts.push(`当地${temp}℃`);
  return `${parts.join('；')}。`;
}

/**
 * The one user message sent to the model: the facts, then the ask. The facts are
 * labelled as background so a model that would otherwise treat them as a task
 * still writes the sentence instead of reporting the weather back.
 */
function promptFor(now, place, weather, ask) {
  return `背景（仅供你体会，不要直接说出这些词）：${contextFor(now, place, weather)}\n${ask}`;
}

/**
 * Least-supported reasoning effort the model declares. Adapters list efforts in
 * their own order, so rank by id; an unrecognised set falls back to the model's
 * own default rather than guessing.
 */
function lowestEffort(info) {
  const efforts = info?.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  let best;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const effort of efforts) {
    const id = typeof effort?.id === 'string' ? effort.id.toLowerCase() : '';
    const rank = EFFORT_RANK.indexOf(id);
    if (rank === -1) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = effort.id;
    }
  }
  if (best !== undefined) return best;
  const fallback = info?.reasoning?.defaultEffort;
  return typeof fallback === 'string' ? fallback : efforts[0]?.id;
}

/** Keep one clean sentence: first non-empty line, no wrapping quotes or emphasis. */
function tidy(text, maxChars) {
  const line = String(text)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (line === undefined) return '';
  const cleaned = line
    .replace(/^["'“”『「（(]+/u, '')
    .replace(/["'“”』」）)]+$/u, '')
    .replace(/\*+/gu, '')
    .trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.round(maxChars) : 80;
  if (cleaned.length <= limit) return cleaned;
  // Over budget: cut at the last clause boundary that still fits, so the line
  // ends on a comma rather than mid-word. A hard slice is the last resort.
  const head = cleaned.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf('；'),
    head.lastIndexOf(','),
    head.lastIndexOf(' '),
  );
  const kept = cut >= Math.ceil(limit / 2) ? head.slice(0, cut) : head;
  return kept.replace(/[，、；,\s]+$/u, '').trim();
}

/**
 * Only the web server is a hard dependency. `llm` and `agentDefaultModel` are
 * looked up at call time with `ctx.get`, so the plugin still loads (and still
 * shows its clock-based greeting) in a build without either of them.
 */
export const inject = ['webServer'];

export function apply(ctx, config) {
  const options = settings(config);

  let cached = null;
  let cachedAt = 0;
  let pending = null;

  /** Last generated sentence, keyed by the context it was generated for. */
  let greeting = null;
  let greetingPending = null;

  /** Proof that the browser half loaded and what it last painted; diagnostics only. */
  let clientBoot = null;
  let lastPaint = null;

  async function build() {
    let place = null;

    if (options.latitude !== null && options.longitude !== null) {
      place = {
        city: options.city !== '' ? options.city : undefined,
        latitude: options.latitude,
        longitude: options.longitude,
        source: 'config',
      };
    } else if (options.city !== '') {
      place = await geocodeCity(options.city);
      if (place === null) place = { city: options.city, latitude: null, longitude: null, source: 'config' };
    } else {
      place = await detectPlace();
    }

    let weather = null;
    if (place !== null && place.latitude !== null && place.longitude !== null) {
      weather = await fetchWeather(place.latitude, place.longitude, options.timezone);
    }

    return {
      ok: true,
      at: Date.now(),
      place: place ?? { city: undefined, latitude: null, longitude: null, source: 'none' },
      weather,
      settings: {
        enabled: options.enabled,
        showCity: options.showCity,
        showWeather: options.showWeather,
        showTemp: options.showTemp,
        template: options.template,
        greetings: options.greetings,
        fallback: options.fallback,
        useLlm: options.useLlm,
      },
    };
  }

  async function snapshot() {
    const age = Date.now() - cachedAt;
    if (cached !== null && age < options.refreshMinutes * 60_000) return cached;
    if (pending !== null) return await pending;
    pending = build()
      .then((value) => {
        cached = value;
        cachedAt = Date.now();
        return value;
      })
      .catch(() => cached ?? { ok: false, at: Date.now(), place: null, weather: null, settings: null })
      .finally(() => {
        pending = null;
      });
    return await pending;
  }

  /**
   * Cache identity: the same sentence is reused while the clock hour, the
   * weather code, the rounded temperature, the route, and the instruction all
   * hold. A change in any of them is a different greeting, not a stale one.
   */
  function greetingKey(now, weather) {
    const code = weather?.code ?? -1;
    const temp = typeof weather?.tempC === 'number' ? Math.round(weather.tempC / 5) * 5 : -99;
    return `${now.getHours()}|${code}|${temp}|${options.llmProvider}|${options.llmModel}|${options.greetingSystem}|${options.greetingAsk}`;
  }

  function route() {
    if (options.llmProvider !== '' && options.llmModel !== '') {
      return { provider: options.llmProvider, model: options.llmModel, source: 'config' };
    }
    const defaults = ctx.get('agentDefaultModel');
    if (defaults === undefined) throw new Error('the agentDefaultModel service is unavailable');
    const selection = defaults.currentSelection();
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') {
      throw new Error('the default model selection is incomplete');
    }
    return { provider: selection.provider, model: selection.model, source: 'default' };
  }

  /**
   * One minimal model call: a single user message, one short system line, no
   * tool schemas, a small output cap, and the least-supported reasoning effort
   * the model declares (`efforts[0]`, the same pick the bundled session-title
   * provider makes).
   */
  async function generate(now, place, weather) {
    const llm = ctx.get('llm');
    if (llm === undefined) throw new Error('the llm service is unavailable');
    const target = route();
    const signal = AbortSignal.timeout(options.greetingTimeoutMs);
    const prompt = promptFor(now, place, weather, options.greetingAsk);
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    let efforts = [];

    const call = await llm.prepareCall(
      { provider: target.provider, model: target.model, maxTokens: options.greetingMaxTokens },
      signal,
      (controls, info) => {
        efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((item) => item.id) : [];
        const effort = lowestEffort(info);
        return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
      },
    );

    let text = '';
    let finish;
    let usage;
    for await (const chunk of call.stream({ ...call.config, messages, system: options.greetingSystem, signal })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason;
      else if (chunk.type === 'usage') usage = chunk.usage;
    }

    if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
      throw new Error(finish.failure?.message ?? `model call ended as ${finish.kind}`);
    }
    const cleaned = tidy(text, options.greetingMaxChars);
    if (cleaned === '') throw new Error('the model returned no text');

    return {
      ok: true,
      text: cleaned,
      provider: target.provider,
      model: target.model,
      routeSource: target.source,
      reasoningEffort: call.config.reasoningEffort,
      maxTokens: call.config.maxTokens,
      efforts,
      prompt,
      at: Date.now(),
      usage,
    };
  }

  async function greetingFor(force) {
    const now = new Date();
    const base = await snapshot();
    const key = greetingKey(now, base.weather);
    if (!force && greeting !== null && greeting.key === key) {
      const ttl = greeting.value.ok === true ? options.greetingMinutes * 60_000 : 5 * 60_000;
      if (Date.now() - greeting.at < ttl) return { ...greeting.value, cached: true };
    }
    if (greetingPending !== null) return await greetingPending;
    greetingPending = generate(now, base.place, base.weather)
      .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))
      .then((value) => {
        greeting = { key, at: Date.now(), value };
        return value;
      })
      .finally(() => {
        greetingPending = null;
      });
    return await greetingPending;
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-welcome/ping',
      handler(request, response) {
        const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
        const now = Date.now();
        // Only the page itself reports; `src` keeps manual probes from faking the signal.
        if (query.get('src') === 'client') {
          if (query.get('boot') !== null) clientBoot = { at: now };
          const text = query.get('text');
          if (text !== null && text !== '') lastPaint = { at: now, text };
        }
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-welcome/greeting',
      async handler(request, response) {
        const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
        let payload;
        if (options.enabled === false || options.useLlm === false) {
          payload = { ok: false, error: 'model greetings are disabled' };
        } else {
          try {
            payload = await greetingFor(query.get('refresh') !== null);
          } catch (error) {
            payload = { ok: false, error: String(error && error.message ? error.message : error) };
          }
        }
        const body = JSON.stringify(payload);
        response.writeHead(payload.ok === true ? 200 : 503, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-welcome/state',
      async handler(request, response) {
        let payload;
        try {
          payload = await snapshot();
        } catch (error) {
          payload = { ok: false, error: String(error && error.message ? error.message : error) };
        }
        const body = JSON.stringify({
          ...payload,
          greeting: greeting === null ? null : { key: greeting.key, at: greeting.at, value: greeting.value },
          client: { boot: clientBoot, paint: lastPaint },
        });
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    }),
  );
}
