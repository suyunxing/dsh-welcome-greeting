/**
 * Browser half of the welcome-greeting bundle.
 *
 * The shipped New-Session hero renders its headline as a locale string
 * (`hero.headline`), and that namespace is single-occupant, so the text cannot
 * be replaced through `ctx.locale.register`. Instead this half keeps the hero's
 * own element and layout untouched: one stylesheet swaps the headline text node
 * for a CSS `content` value fed by a custom property, and this module keeps that
 * property in step with the Host half.
 *
 * The sentence itself comes from the Host half, which asks the New Session model
 * for it. That call takes seconds, so the first paint never waits for it: the
 * clock-based sentence is painted immediately and is replaced in place as soon
 * as the model answers. With no network and no model the clock sentence simply
 * stays, so the hero is never blank.
 *
 * Nothing here is positioned by hand: the greeting occupies exactly the box the
 * original headline occupied, inherits its type scale and colour, and the
 * "Preview" badge beside it is left alone.
 */

window.__ModuleLoader__.load({
  id: 'dsh-welcome-greeting',
  factory(require) {
    /** Present on <html> only while this plugin is showing its own greeting. */
    const ATTR = 'data-dsh-greeting';
    /** Carries the greeting text into the stylesheet. */
    const VAR = '--dsh-welcome-greeting';

    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    /** Mirrors the Host defaults, so the very first paint needs no network. */
    const FALLBACK_GREETINGS = [
      { from: 5, to: 9, text: '早上好' },
      { from: 9, to: 11, text: '上午好' },
      { from: 11, to: 13, text: '中午好' },
      { from: 13, to: 18, text: '下午好' },
      { from: 18, to: 23, text: '晚上好' },
      { from: 23, to: 5, text: '夜深了' },
    ];

    const CSS = `
html[${ATTR}="on"] [class*="_headline"] > [class*="_titleGroup"] > span:first-child {
  display: none !important;
}
html[${ATTR}="on"] [class*="_headline"] > [class*="_titleGroup"]::after {
  content: var(${VAR}, "");
  order: -1;
}
`;

    function pad(value) {
      return value < 10 ? `0${value}` : String(value);
    }

    function greetingFor(hour, table) {
      for (const row of table) {
        const from = Number(row.from);
        const to = Number(row.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        const hit = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
        if (hit) return String(row.text);
      }
      const first = table[0];
      return first !== undefined && typeof first.text === 'string' ? first.text : '你好';
    }

    function fill(template, vars) {
      return template.replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
      );
    }

    /** Tidies separators left dangling when a placeholder had no value. */
    function collapse(text) {
      return text
        .replace(/\s+/g, ' ')
        .replace(/^[\s·,，]+/, '')
        .replace(/[\s·,，]+$/, '')
        .replace(/([·,，])(?:\s*[·,，])+/g, '$1')
        .trim();
    }

    /** The clock-and-weather sentence, used before the model answers and if it never does. */
    // Weather codes collapse into one caring aside. The greeting never states the
    // city or the temperature: those are only hints for how to phrase the care.
    function careFor(code, tempC) {
      if (typeof code === 'number') {
        if (code === 0 || code === 1) return '太阳挺好，别把自己关在屋里';
        if (code === 2) return '云淡风轻的，出去走走';
        if (code === 3) return '天有点阴，心情别跟着暗';
        if (code === 45 || code === 48) return '雾有点重，路上慢一点';
        if (code >= 51 && code <= 67) return '下着雨，记得带伞别淋着';
        if (code >= 71 && code <= 77) return '飘雪了，多穿点';
        if (code >= 80 && code <= 82) return '阵雨说来就来，伞别忘了';
        if (code === 85 || code === 86) return '雪下得不小，出门裹紧点';
        if (code >= 95) return '打雷了，别在外面久留';
      }
      if (typeof tempC !== 'number') return '';
      if (tempC <= 5) return '外面冷，出门裹紧点';
      if (tempC <= 12) return '有点凉，别忘加件外套';
      if (tempC <= 18) return '风里带凉，早晚记得添衣';
      if (tempC >= 30) return '天热，多喝点水';
      if (tempC >= 25) return '暖和，别忙得忘了喝水';
      return '';
    }

    function compose(now, payload) {
      const settings = (payload && payload.settings) || {};
      const place = (payload && payload.place) || {};
      const weather = (payload && payload.weather) || {};
      const table =
        Array.isArray(settings.greetings) && settings.greetings.length > 0
          ? settings.greetings
          : FALLBACK_GREETINGS;

      const city = typeof place.city === 'string' ? place.city : '';
      const weatherText = typeof weather.text === 'string' ? weather.text : '';
      const tempC = typeof weather.tempC === 'number' ? Math.round(weather.tempC) : null;

      const vars = {
        greeting: greetingFor(now.getHours(), table),
        city,
        region: typeof place.region === 'string' ? place.region : '',
        country: typeof place.country === 'string' ? place.country : '',
        weather: weatherText,
        temp: tempC === null ? '' : String(tempC),
        care: careFor(typeof weather.code === 'number' ? weather.code : undefined, tempC),
        date: `${now.getMonth() + 1}月${now.getDate()}日`,
        time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
        weekday: WEEKDAYS[now.getDay()],
      };

      if (typeof settings.template === 'string' && settings.template.trim() !== '') {
        return collapse(fill(settings.template, vars));
      }

      // Default composition: the time greeting plus one caring aside, never the
      // place name or the temperature. `showCity`/`showWeather`/`showTemp` still
      // switch the explicit forms back on for anyone who wants them.
      let text = vars.greeting;
      if (settings.showCity === true && city !== '') text += `，${city}`;
      const tail = [];
      if (settings.showWeather === true && weatherText !== '') tail.push(weatherText);
      if (settings.showTemp === true && vars.temp !== '') tail.push(`${vars.temp}°C`);
      if (tail.length > 0) text += ` · ${tail.join(' ')}`;
      else if (vars.care !== '') text += `，${vars.care}`;

      const collapsed = collapse(text);
      if (collapsed === '' && typeof settings.fallback === 'string') return settings.fallback;
      return collapsed;
    }

    return {
      inject: ['timer'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.dshWelcomeGreeting = '';
          tag.textContent = CSS;
          document.head.append(tag);
          return () => tag.remove();
        }, 'welcome-greeting/styles');

        const root = document.documentElement;

        /** Last `/dsh-welcome/state` snapshot: place, weather, settings. */
        let payload = null;
        /** Last model sentence from `/dsh-welcome/greeting`, if one arrived. */
        let sentence = '';
        /** A greeting request is in flight; never stack them, the Host call costs tokens. */
        let asking = false;
        let painted;

        /** Diagnostics only: lets the Host half report what this half painted. */
        function report(query) {
          void fetch(`/dsh-welcome/ping?src=client&${query}`, { cache: 'no-store', method: 'GET' }).catch(() => {});
        }

        function clear() {
          root.removeAttribute(ATTR);
          root.style.removeProperty(VAR);
          painted = undefined;
        }

        function paint() {
          const settings = (payload && payload.settings) || {};
          if (settings.enabled === false) {
            clear();
            return;
          }
          // The model sentence wins; the clock sentence holds the slot until it lands.
          const text = sentence !== '' ? sentence : compose(new Date(), payload);
          if (text === '') {
            clear();
            return;
          }
          if (text === painted) return;
          painted = text;
          root.style.setProperty(VAR, JSON.stringify(text));
          root.setAttribute(ATTR, 'on');
          report(`text=${encodeURIComponent(text)}`);
        }

        /** Fast: place, weather, and the settings this half renders with. */
        async function refreshState() {
          try {
            const response = await fetch('/dsh-welcome/state', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            if (next !== null && typeof next === 'object' && next.ok === true) payload = next;
          } catch {
            // Keep whatever was already resolved; the clock-based greeting still works.
          }
          paint();
        }

        /**
         * Slow: the model sentence. Resolves in seconds, may fail outright, and
         * is only ever an upgrade over what is already painted.
         */
        async function refreshGreeting(force) {
          if (asking) return;
          asking = true;
          try {
            const suffix = force ? '?refresh=1' : '';
            const response = await fetch(`/dsh-welcome/greeting${suffix}`, { cache: 'no-store' });
            const body = await response.json();
            if (body !== null && typeof body === 'object' && body.ok === true && typeof body.text === 'string') {
              if (body.text !== '') {
                sentence = body.text;
                paint();
              }
            }
          } catch {
            // No model, no network, or the call failed: the clock sentence stays.
          } finally {
            asking = false;
          }
        }

        ctx.effect(() => () => clear(), 'welcome-greeting/reset');

        // Repaint on the clock often enough to cross an hour boundary promptly;
        // paint() is a no-op while the text is unchanged.
        ctx.effect(() => ctx.timer.interval(paint, 15_000), 'welcome-greeting/tick');
        // The Host caches a sentence per clock hour and weather bucket, so this
        // refresh usually costs one cheap request and no model call at all.
        ctx.effect(
          () => ctx.timer.interval(() => void refreshGreeting(false), 10 * 60_000),
          'welcome-greeting/regreet',
        );
        ctx.effect(
          () => ctx.timer.interval(() => void refreshState(), 5 * 60_000),
          'welcome-greeting/refresh',
        );

        ctx.effect(() => {
          const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            void refreshState();
            void refreshGreeting(false);
          };
          document.addEventListener('visibilitychange', onVisible);
          return () => document.removeEventListener('visibilitychange', onVisible);
        }, 'welcome-greeting/visibility');

        paint();
        report('boot=1');
        void refreshState().then(() => refreshGreeting(false));
      },
    };
  },
});
