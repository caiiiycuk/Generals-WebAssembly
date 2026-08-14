# GeneralsX Web — сборка и деплой веб-версии

Шпаргалка по веб-порту (Emscripten/WASM): как собрать движок, подготовить
игровые данные и выкатить обновление.

Модель распространения данных: игровые данные **не скачиваются с
веб-сервера**. Они распространяются торрентом и разворачиваются в OPFS
браузера **до запуска игры** внешним шагом (деплоером). Лоадер при старте
проверяет фактическое наличие установки в OPFS (файлы `GameData/*.big`)
и без неё не даёт продолжить — кнопка «Играть» не появляется.

## Состав веб-версии

Деплоится один статический каталог `web/dist/`:

| Что | Откуда | Когда обновляется |
|---|---|---|
| `GeneralsXZH.js` / `GeneralsXZH.wasm` | сборка `build/emscripten/GeneralsMD/` | при каждом изменении движка |
| `index.html`, `loader.js`, `storage.js`, `game.js`, `i18n/`, … | `web/shell/` | при изменении шелла |
| `build.json` (`{"buildId": …}`) | хэш `.wasm`, генерирует `make-dist.sh` | автоматически |

Игровые данные в `dist/` не входят — см. следующий раздел.

`buildId` (первые 12 символов sha256 от `.wasm`) версионирует движок и
воркеры — браузер сам подтянет новый движок после деплоя, ничего чистить
не нужно.

## 1. Сборка движка (wasm)

Нужен установленный Emscripten SDK; пресету требуется переменная
`EMSCRIPTEN_ROOT`:

```bash
export EMSCRIPTEN_ROOT="$EMSDK/upstream/emscripten"   # или $(brew --prefix emscripten)/libexec

cmake --preset emscripten
cmake --build build/emscripten --preset emscripten   # z_generals + g_generals
```

Результат: `build/emscripten/GeneralsMD/GeneralsXZH.js/.wasm` (Zero Hour) и
`build/emscripten/Generals/GeneralsX.js/.wasm` (базовая игра, `?game=generals`).
Отдельные таргеты — `--target z_generals` / `--target g_generals`. Для
отладочной сборки (assertions, source maps) есть пресет `emscripten-debug`.

## 2. Подготовка игровых данных

Исходные данные лежат в `web/gamedata/<BUILD_NAME>/` (симлинк на `gamedata/`):

```
web/gamedata/default_ru/
  GeneralsZH/   # установка Zero Hour (*.big, Data/, Maps/)
  Generals/     # установка базовой игры (опционально)
```

Выполните скрипт подготовки:

```bash
scripts/web/prepare-assets.sh default_ru        # → web/staging/default_ru
```

Он собирает эталонную директорию в `web/staging/<BUILD_NAME>`: берёт только
`*.big`, `Data/**`, `Maps/**` (без мусора вроде `.DS_Store` и
`Data/Backup Scripts/`) и стейджит шрифты (движок сам их не поставляет; без
`arial.ttf` текст не отрисуется). Видео урезаются: из базовой игры
вырезаются **все** `*.bik`, из ZH — только стартовое интро (лого EA +
sizzle-ролик); брифинги и челлендж-ролики ZH остаются. Отсутствующее видео
движок молча пропускает (никаких падений — все пути воспроизведения
проверяют NULL-поток). Скрипт идемпотентен — повторный запуск
синхронизирует каталог с источником.

Staging **зеркалирует раскладку корня OPFS один в один** — деплоеру ничего
перекладывать не нужно, содержимое копируется в OPFS как есть. Все данные
игры живут в собственной папке `ccgenerals/`, а не в корне OPFS (корень —
общий для всего origin):

```
web/staging/<BUILD_NAME>/          =  корень OPFS
  ccgenerals/
    GameData/                      <- ZH: *.big, Data/, Maps/ (рабочий каталог движка)
    GameData/fonts/                <- шрифты
    GameDataGenerals/              <- базовая игра (сиблинг GameData/)
```

(Движок монтирует OPFS в `/opfs` и работает в `/opfs/ccgenerals/GameData`;
база — в `/opfs/ccgenerals/GameDataGenerals`. Константа базового пути —
`GX_OPFS_BASE` в `WebMain.cpp`, JS-слой якорится на тот же подкаталог в
`storage.js`.)

Пользовательские данные (`Options.ini`, сохранения, реплеи) в OPFS **не
живут**: они хранятся в отдельной базе IndexedDB `gx-userdata` и монтируются
движком в `/idb/userdata` (классический IDBFS несовместим с `-s WASMFS`,
поэтому та же семантика mount+syncfs реализована поверх WASMFS: лоадер
восстанавливает файлы при старте, движок синхронизирует изменения обратно
каждые ~10 с и перед выходом). Благодаря этому повторный деплой или очистка
игровых данных в OPFS никогда не трогает сохранения. Userdata из старых
установок (`ccgenerals/userdata/` в OPFS) мигрируется автоматически при
первом запуске.

Полученную директорию `web/staging/<BUILD_NAME>` нужно **обернуть в
торрент**; деплоер разворачивает её содержимое в корень OPFS браузера
**до запуска игры**.

## 3. Сборка dist

```bash
cmake --build build/emscripten --target z_generals
scripts/web/make-dist.sh --skip-assets
```

Копирует шелл и wasm, генерирует `build.json` (buildId по хэшу wasm).
Игровые данные в dist не пакуются — раздача идёт торрентом (раздел 2).
Уже отредактированный `dist/ice.json` (STUN/TURN, MQTT) не перезаписывается.

## 4. Запуск: без стартового экрана, параметры в URL

Стартового экрана нет — страница сразу проверяет установку и запускает
игру. Параметры передаются через query-параметры URL:

| Параметр | Значения | По умолчанию |
|---|---|---|
| `?game=` | `zh` (Zero Hour, `GeneralsXZH.js/.wasm`) или `generals` (база, `GeneralsX.js/.wasm`) | `zh` |
| `?fps=` | лимит FPS рендера, например `?fps=60` | `30` (оригинал) |
| `?lang=` | `ru` — русская локализация; любое другое значение (или отсутствие) — английская | английский |
| `?args=` | прочие флаги движка, например `?args=-noshellmap` | — |
| `?storage=idb` | принудительный IndexedDB-фолбэк | OPFS |

Пример: `https://host/?game=zh&fps=60&lang=ru`.

Про `?lang=`: данные `default_ru` — это английская установка с русским
патчем поверх (оверрайд-архивы `00RussianZH.big`, `00Russian.big`,
`0!Russian.big`; озвучка и так английская). Один и тот же деплой в OPFS
обслуживает оба языка: без `?lang=ru` движок просто не загружает эти три
архива (шелл передаёт `Module.gxLang`, `WebMain.cpp` выставляет
`GX_SKIP_BIGS`, список читает `StdBIGFileSystem`).

`?game=generals` запускает базовую игру (`GeneralsX.js/.wasm`): у неё свой
web-вход (`Generals/Code/Main/WebMain.cpp`), рабочий каталог в OPFS —
`ccgenerals/GameDataGenerals` (тот же, откуда ZH берёт базовые ассеты), и
свои сохранения (`userdata/GeneralsX/Generals/`). Лоадер проверяет наличие
установки в каталоге выбранной игры.

`loader.js` **не использует маркеры установки** — при каждом старте он
проверяет фактическое наличие игры в хранилище: хотя бы один `*.big` в
`ccgenerals/GameData/` в OPFS (для IndexedDB-фолбэка — среди сохранённых
путей).

- Установка найдена → игра запускается сразу; из сети берётся только движок
  (`build.json` + wasm, с ревалидацией HTTP-кэша). Игровые данные не
  скачиваются никогда.
- Установки нет → лоадер показывает ошибку «Данные игры не найдены…» и
  **не даёт продолжить**. Полная очистка хранилища доступна из консоли:
  `gxWipeAllStorage()`.

Обновление движка/шелла — просто выгрузите новый `dist/`: buildId изменится,
браузеры подтянут новый wasm, данные игроков в OPFS не затрагиваются.
Обновление данных — новый торрент и повторное разворачивание деплоером.

Для деплоера в шелле экспортирован конвейер записи в OPFS:
`window.gxStreamExtract(url, storage, journalKey)` умеет распаковывать
GAXD-архив (`packer.py`) в OPFS с докачкой и журналом возобновления, а
`scripts/web/pack-assets.sh` по-прежнему собирает такой архив, если торрент
удобнее раздавать одним файлом (нужен Python с модулем `brotli`:
`python3 -m venv web/.venv && web/.venv/bin/pip install brotli`).

## 5. Хостинг

Годится любой статический HTTPS-хост: заливаете содержимое `web/dist/` как
есть. Кросс-origin-изоляцию (COOP/COEP — обязательна для pthreads) на «голом»
статическом хостинге обеспечивает включённый в dist `coi-serviceworker.js`.

Локально / на своём сервере — Go-сервер из репозитория (сам ставит нужные
заголовки):

```bash
cd web && go run ./server -dir ./dist                    # http://localhost:8080
cd web && go run ./server -dir ./dist -tls-self-signed   # https://<ip>:8080
```

## Отладка на клиенте

- `?storage=idb` в URL — принудительный фолбэк на IndexedDB вместо OPFS;
- `gxWipeAllStorage()` в консоли devtools — сброс OPFS, IndexedDB,
  Cache Storage и настроек (эквивалент «переустановки»);
- раскладка внутри OPFS, которую ожидает движок: `/opfs/ccgenerals/GameData`
  (ассеты ZH, рабочий каталог), `/opfs/ccgenerals/GameDataGenerals` (база);
- сохранения, `Options.ini` и реплеи — НЕ в OPFS, а в IndexedDB-базе
  `gx-userdata` (движок монтирует её содержимое в `/idb/userdata`);
