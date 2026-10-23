# dsh-welcome-greeting

Rewrites the New Session headline — the line that normally reads *Into the Unknown* / 探索未至之境 — into a short, affectionate greeting written by **the model the new session is already set to use**, from the local time, the current city and the live weather.

## What it does

- **Host half** resolves the place (IP geolocation, then a Chinese city name via Open-Meteo geocoding) and the weather (Open-Meteo, no API key), then asks the selected model for one short sentence. The call is deliberately minimal: a single user message, one short system line, **no tool schemas, no history, no harness system prompt**, and the least reasoning effort the model declares.
- **Client half** paints that sentence into the hero headline through a stylesheet. Before the model answers — or if no model is reachable — it shows a local time-based greeting plus one caring aside, so the headline is never blank.

The greeting never states the city name or the temperature. Those facts are only hints: the model is asked to turn them into something like *“风一吹还是凉的，路上把外套穿好。”*

## Install

```sh
dsh plugin --profile <your-profile> add dsh-welcome-greeting
```

Then reload the DSH window so the browser half is picked up.

## Configuration

Everything lives in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: welcome-greeting
      name: 'dsh-welcome-greeting'
      config:
        city: ''            # empty = detect from the public IP
        latitude: null      # set both to skip IP detection
        longitude: null
        timezone: ''        # empty = let Open-Meteo follow the coordinates
        useLlm: true        # false = local template only, no model call
        llmProvider: ''     # empty = the New Session default model
        llmModel: ''
        greetingSystem: ''  # empty = built-in girlfriend-voice prompt
        greetingAsk: ''
        greetingMaxChars: 22
        greetingMaxTokens: 120
        greetingMinutes: 60 # how long a generated sentence stays cached
        refreshMinutes: 15  # how long place + weather stay cached
        showCity: false     # true appends the explicit "city · sky 16°C" form
        showWeather: false
        showTemp: false
```

The generated sentence is cached per hour + weather code + rounded temperature, so a chatty session does not burn tokens on every repaint. Failed calls back off for five minutes and fall back to the local greeting.

## Notes

- Place and weather need no API key. IP geolocation tries `ipinfo.io`, then `get.geojs.io`, then `ipwho.is`.
- If the harness has no `llm` service, the plugin still loads and shows the local greeting.
- The client half is a stylesheet plus a fetch — it does not replace or re-register any slot.

## 中文

把新会话首屏那句「探索未至之境」换成一句**由当前会话所选模型**写的短问候：模型只拿到时间、城市和天气，写成侧面关心的情话，不点名城市、不报温度。

- **Host 半**：IP 定位（ipinfo → geojs → ipwho）→ 中文城市名（Open-Meteo geocoding）→ 天气（Open-Meteo，免密钥）→ 调模型。请求极简：一条 user 消息 + 一句短 system，**不带工具、不带历史、不带 harness 系统提示词**，思考强度取模型声明里最低的一档。
- **Client 半**：一段样式表把句子画到首屏标题上。模型还没返回（或没有模型可用）时，先显示按小时计算的问候加一句侧面关怀，首屏不会空着。

配置项同上。`useLlm: false` 可完全关掉模型调用，只用本地模板。改完 `cordis.patch.yml` 后重载插件即可生效。

## License

MIT