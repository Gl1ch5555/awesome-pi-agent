# awesome-pi-agent

Минималистичный терминальный coding-agent на базе [Pi](https://github.com/earendil-works/pi), доработанный для быстрой ежедневной работы:

- **Графитовая тема и чистый UI** — строгая тёмно-графитовая палитра (`graphite` по умолчанию), плавные анимации спиннера с таймером, ноль эмодзи.
- **Встроенный голосовой ввод (Groq Whisper `whisper-large-v3`)** — зажимаешь `Space`, видишь минималистичный аудио-индикатор и почанковую расшифровку в реальном времени, отпускаешь `Space` — текст готов. Работает на Linux (`parecord` / `arecord` / `ffmpeg` / `sox`) и Windows (встроенный `winmm.dll` через PowerShell или `ffmpeg`).
- **Встроенный веб-поиск и чтение страниц (`web_search`, `web_fetch`)** — Tavily API по умолчанию + 11 провайдеров (Brave, Exa, Serper, Perplexity Sonar, Firecrawl, Jina, Linkup, SerpAPI, Google Custom Search, DuckDuckGo, SearXNG) с автоматическим фолбэком.
- **Удобный менеджер провайдеров (`/providers`)** — пошаговое добавление: имя провайдера -> API URL -> API ключ -> автоподгрузка списка моделей через `GET /v1/models` -> выбор моделей чекбоксами -> Save. Повторное обновление моделей из `/v1/models` в любой момент.
- **Исправленная вставка картинок по `Ctrl+V`** — работает на Linux и Windows (скриншоты из буфера обмена, скопированные файлы, вставленные пути к изображениям). В поле ввода вставляется компактный маркер `(image)`, а при отправке изображение передаётся модели как attachment.
- **Мастер настройки при первом запуске + `/settings`** — при первом старте (и в любое время в `/settings`) настраиваются тема, поисковый провайдер и ключ, Groq API ключ для голосового ввода и кастомные LLM-провайдеры.

---

## Быстрая установка

Требуется **Node.js >= 22.19** и **git**.

### Linux / macOS

Прямая установка:

```bash
curl -fsSL https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.sh | bash
```

Или через GitHub-токен:

```bash
export PI_GH_TOKEN="<YOUR_GITHUB_TOKEN>"
curl -fsSL -H "Authorization: token $PI_GH_TOKEN" \
  https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.sh | bash
```

Повторный запуск этой же команды обновляет `pi-awesome` до последнего коммита.

Папка установки: `~/.pi-awesome` (Linux/macOS) и `%USERPROFILE%\.pi-awesome` (Windows).
Команда запуска: `pi-awesome`.

### Windows (PowerShell)

Прямая установка:

```powershell
irm "https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.ps1" | iex
```

Или через GitHub-токен:

```powershell
$env:PI_GH_TOKEN = "<YOUR_GITHUB_TOKEN>"
$h = @{ Authorization = "token $env:PI_GH_TOKEN" }
irm -Headers $h "https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.ps1" | iex
```

На Windows установщик сам проверит `git` и `Node.js` (при необходимости доставит через `winget`), соберёт `pi` и добавит команду `pi` в пользовательский `PATH`.

---

## Основные команды и горячие клавиши

### Горячие клавиши

- **`Hold Space`** — зажать пробел для голосовой диктовки через Groq Whisper (`Esc` отменяет запись; короткий тап ставит обычный пробел)
- **`Ctrl+V`** — вставка картинки из буфера или пути к файлу изображения как `(image)`
- **`Ctrl+L`** — выбор модели
- **`Ctrl+P` / `Shift+Ctrl+P`** — переключение между выбранными моделями
- **`Shift+Tab`** — уровень reasoning (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`)
- **`Ctrl+O`** — раскрыть/свернуть вывод инструментов
- **`Ctrl+T`** — показать/скрыть блоки рассуждений (`thinking`)
- **`!command`** — выполнить локальную shell-команду

### Slash-команды

- **`/providers`** — добавить кастомного провайдера (Имя -> URL -> API Key -> выбор моделей из `/v1/models`) или обновить модели у существующего
- **`/settings`** — настройки интерфейса, темы, голосового ввода (Groq API key, модель, язык), поискового провайдера и ключей
- **`/voice`** — включить/выключить или вручную переключить запись голоса (`/voice on`, `/voice off`, `/voice toggle`)
- **`/model`** — выбрать модель
- **`/login`** — OAuth / API-ключи встроенных провайдеров
- **`/tree`**, **`/resume`**, **`/compact`**, **`/new`**, **`/quit`**

---

## Поисковые провайдеры (`web_search` / `web_fetch`)

Выбираются при первом запуске или в `/settings` -> **Web search & fetch**:

1. `tavily` (`TAVILY_API_KEY`) — основной провайдер по умолчанию + extract для `web_fetch`
2. `brave` (`BRAVE_API_KEY`)
3. `exa` (`EXA_API_KEY`)
4. `serper` (`SERPER_API_KEY`)
5. `perplexity` (`PERPLEXITY_API_KEY`)
6. `firecrawl` (`FIRECRAWL_API_KEY`)
7. `jina` (`JINA_API_KEY`, работает и без ключа)
8. `linkup` (`LINKUP_API_KEY`)
9. `serpapi` (`SERPAPI_API_KEY`)
10. `google_cse` (`GOOGLE_SEARCH_API_KEY` + `cx`)
11. `duckduckgo` (без ключа, резервный фолбэк)
12. `searxng` (`SEARXNG_URL`, self-hosted)

---

## Голосовой ввод (Groq Whisper)

- Модель по умолчанию: `whisper-large-v3` (можно переключить на `whisper-large-v3-turbo` в `/settings`).
- Ключ задаётся в мастере первого запуска, в `/settings` -> **Voice input**, или через `GROQ_API_KEY`.
- Во время удержания `Space` аудио-чанки каждые ~1.5 сек отправляются в Groq Whisper, отображая живую расшифровку под строкой статуса; при отпускании выполняется финальный проход по всей фразе.
- Для минимальной задержки отпускания рекомендуется терминал с поддержкой Kitty Keyboard Protocol (Windows Terminal, Ghostty, Kitty, WezTerm, Alacritty), но также работает и в обычных терминалах по таймауту key-repeat.

---

## Разработка локально

```bash
git clone https://github.com/Gl1ch5555/awesome-pi-agent.git
cd awesome-pi-agent
npm install --ignore-scripts
npm run build:offline
node packages/coding-agent/dist/bundle/cli.js
```
