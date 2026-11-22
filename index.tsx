/*
 * Bubbscord — userplugin для Vencord.
 * Округлый интерфейс (капсулы и «таблетки»), сообщения пузырями как в Telegram, редактор темы,
 * свои обои, пауза гифок в фоне и уборка лишнего в интерфейсе.
 * Телеметрию блокирует встроенный NoTrack, «тихий набор» — встроенный SilentTyping.
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings, Settings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { Button } from "@components/Button";
import { addChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { chooseFile } from "@utils/web";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, showToast, useEffect, UserStore, useState } from "@webpack/common";

// Интерфейс встроен прямо в плагин: капсулы/«таблетки»/анимации и основа для обоев
import roundStyle from "./round.css?managed";
import {
    BoltIcon, ensureFolderTabs, hasActiveChatWallpaper, HubChatBarButton, openHub, refreshFolders, StarIcon,
    startTelegram, stopTelegram, telegramContextMenus, templateCommand, TemplatesChatBarButton, TranslationAccessory,
    TRANSLATE_LANGUAGES
} from "./telegram";
import telegramStyle from "./telegram.css?managed";
import { setWorkshopEnabled, startWorkshop, stopWorkshop } from "./workshop";
import workshopStyle from "./workshop.css?managed";
import { startUpdater, stopUpdater, UpdaterSetting } from "./updater";
import wallpaperStyle from "./wallpaper.css?managed";

const CSS = {
    noAnimations: `
        *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-delay: 0ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            transition-delay: 0ms !important;
            scroll-behavior: auto !important;
        }`,
    // Только там, где Discord реально размывает (затемнение за окнами/картинками).
    // Раньше тут было правило на ВСЕ элементы (*) — оно проверялось для каждого элемента при каждом пересчёте.
    noBlur: `
        [class*="backdrop_"], [class*="backdropWithLayer"], [class*="blurBackground"] {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }`,
    // Слева от пробела — только теги: [class*=…] слева заставлял бы пересчитывать поддеревья
    // при любой смене класса. :has проверяем только у строк списка ЛС (li с классом channel_).
    // Вкладки «Nitro» (/store) и «Магазин» (/shop) в списке ЛС оставляем — они нужны.
    hideClutter: `
        form button[aria-label="Send a gift"],
        form button[aria-label="Отправить подарок"],
        form button[aria-label="Open sticker picker"],
        form button[aria-label="Открыть выбор стикеров"],
        [class*="channelAppLauncher"],
        a[href="/library"],
        li[class*="channel_"]:has(a[href^="/quest-home"]),
        a[href^="/quest-home"], a[href^="/discovery/quests"] { display: none !important; }`,
    hideActiveNow: `
        [class*="nowPlayingColumn"] { display: none !important; }`,
    hideDecorations: `
        img[src*="avatar-decoration-presets"],
        [class*="profileEffects"],
        video[src*="nameplates"], img[src*="nameplates"] { display: none !important; }`,
    // Пауза в фоне больше не через CSS: переключение класса на <body> заставляло Discord
    // пересчитывать стили ВСЕГО окна при каждом переходе между окнами — отсюда сильные подвисания.
    // Теперь на паузу ставятся только зацикленные видео-гифки (см. goIdle), без пересчёта стилей.
    pauseWhenUnfocused: ``,
    // Сплошной фон под сообщениями: прокрутка непрозрачной области — самая дешёвая для видеокарты.
    // Обои остаются видны в боковых колонках, шапке и вокруг поля ввода.
    fastChat: `
        main [class*="messagesWrapper"],
        main [class*="scroller_"] {
            background: rgb(14 14 18) !important;
        }`
};

type Key = keyof typeof CSS;

const WALLPAPER_KEY = "DedBoost_wallpaper";

// ---------- Обои: кнопки выбора файла в настройках ----------
// Хватает ли картинке размера: обои растягиваются на весь экран (cover), и маленькая картинка мылит.
// Нужны физические пиксели экрана — с учётом масштаба Windows (devicePixelRatio).
function wallpaperVerdict(url: string): Promise<string> {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth, h = img.naturalHeight;
            const needW = Math.round(screen.width * devicePixelRatio);
            const needH = Math.round(screen.height * devicePixelRatio);
            const stretch = Math.max(needW / w, needH / h);
            const size = `${w}×${h}, экран ${needW}×${needH}`;
            if (stretch > 1.25)
                resolve(`⚠ Картинка ${size} — растягивается в ${stretch.toFixed(1)} раза и будет мыльной. Нужна хотя бы ${needW}×${needH}.`);
            else
                resolve(`✓ Картинка ${size} — размера хватает, будет чётко.`);
        };
        img.onerror = () => resolve("Не удалось прочитать картинку.");
        img.src = url;
    });
}

function WallpaperPicker() {
    const [status, setStatus] = useState<string>(localWallpaperUrl ? "Сейчас стоит картинка с компьютера" : "Картинка с компьютера не выбрана");

    // при открытии настроек сразу показываем, хватает ли размера текущей картинке
    useEffect(() => {
        if (localWallpaperUrl) wallpaperVerdict(localWallpaperUrl).then(setStatus);
    }, []);

    async function pick() {
        const file = await chooseFile("image/*");
        if (!file) return;
        await DataStore.set(WALLPAPER_KEY, file);
        await loadLocalWallpaper();
        const verdict = localWallpaperUrl ? await wallpaperVerdict(localWallpaperUrl) : "";
        setStatus(`Стоит: ${file.name}. ${verdict}`);
    }

    async function clear() {
        await DataStore.del(WALLPAPER_KEY);
        await loadLocalWallpaper();
        setStatus("Картинка с компьютера убрана");
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={pick}>Выбрать обои с компьютера</Button>
                <Button onClick={clear} variant="dangerPrimary">Убрать</Button>
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{status}</div>
        </div>
    );
}

// ---------- Редактор темы (как в Telegram): акцент и пузыри ----------
const DEFAULT_ACCENT = "#6c7bff";
const DEFAULT_BUBBLE = "#2a2e40";
const PRESETS: [string, string, string][] = [
    // название, акцент, цвет пузыря
    ["Ночь", "#6c7bff", "#2a2e40"],
    ["Telegram", "#3390ec", "#182533"],
    ["Золото", "#d4af37", "#1c2238"],
    ["Сакура", "#ff6fa8", "#2a1b24"],
    ["Изумруд", "#2ecc8f", "#15261f"],
    ["Графит", "#b8bcc8", "#202024"]
];

function hexToRgb(hex: string | undefined, fallback: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!;
    const n = parseInt(m[1], 16);
    return `${n >> 16} ${(n >> 8) & 255} ${n & 255}`;
}

// ---------- Шрифты (как в Telegram: выбор шрифта и размера текста) ----------
// Только шрифты, которые уже есть в Windows (или установлены у тебя): файлы шрифтов с внешних
// сайтов Discord блокирует, а системные грузятся мгновенно и ничего не тормозят.
const FONT_OPTIONS: { label: string; value: string; default?: boolean; }[] = [
    { label: "Discord (по умолчанию)", value: "default", default: true },
    { label: "Segoe UI Variable — системный Windows 11", value: "Segoe UI Variable Text" },
    { label: "Segoe UI — классический Windows", value: "Segoe UI" },
    { label: "Bahnschrift — строгий, современный", value: "Bahnschrift" },
    { label: "Calibri — мягкий", value: "Calibri" },
    { label: "Candara — округлый", value: "Candara" },
    { label: "Corbel — чистый", value: "Corbel" },
    { label: "Trebuchet MS", value: "Trebuchet MS" },
    { label: "Verdana — крупный и чёткий", value: "Verdana" },
    { label: "Georgia — с засечками", value: "Georgia" },
    { label: "Cascadia Code — моноширинный", value: "Cascadia Code" },
    { label: "Consolas — моноширинный", value: "Consolas" },
    { label: "Comic Sans MS — весёлый", value: "Comic Sans MS" },
    { label: "Свой (впиши название ниже)", value: "custom" }
];

function chosenFont(): string | null {
    const s = settings.store;
    const fam = s.fontFamily === "custom" ? s.customFont?.trim() : s.fontFamily;
    if (!fam || fam === "default") return null;
    // название шрифта попадает в CSS — убираем всё, что может его сломать
    return fam.replace(/["\;{}<>]/g, "").slice(0, 60) || null;
}

function fontStack(fam: string) {
    return `"${fam}", "gg sans", "Segoe UI", sans-serif`;
}

function fontsCss(): string {
    const s = settings.store;
    const fam = chosenFont();
    let css = "";
    if (fam) {
        const stack = fontStack(fam);
        css += s.fontScope === "messages"
            // только текст сообщений и ники в чате
            ? `
        li[id^="chat-messages-"] [class*="messageContent_"],
        li[id^="chat-messages-"] [class*="username_"] { font-family: ${stack} !important; }`
            // весь Discord: подменяем шрифтовые переменные Discord (меняются только при смене настройки)
            : `
        :root:root {
            --font-primary: ${stack};
            --font-display: ${stack};
            --font-headline: ${stack};
        }
        body { font-family: ${stack} !important; }`;
    }
    const size = Math.round(s.messageFontSize ?? 16);
    if (size !== 16) css += `
        li[id^="chat-messages-"] [class*="messageContent_"] {
            font-size: ${size}px !important;
            line-height: ${Math.round(size * 1.375)}px !important;
        }`;
    return css;
}

// Повтор селектора ([x][x]) только повышает приоритет над правилами из round.css,
// не добавляя проверок по предкам.
// Пузырь сообщения и акцент — сразу числами в CSS (без переменных на корне документа:
// их смена пересчитывала бы всё окно). Перестраивается только при изменении настроек.
function bubblesCss(): string {
    const s = settings.store;
    const accent = hexToRgb(s.accentColor, DEFAULT_ACCENT);
    let css = `
        [class*="modeSelected"][class*="modeSelected"],
        [class*="interactiveSelected"][class*="interactiveSelected"] {
            background: rgb(${accent} / 0.16) !important;
            box-shadow: inset 0 0 0 1px rgb(${accent} / 0.45) !important;
            /* у внешнего блока строки Discord скругления нет — без этого рамка была прямоугольной */
            border-radius: 999px !important;
        }
        [class*="channelTextArea_"][class*="channelTextArea_"]:focus-within {
            border-color: rgb(${accent} / 0.6) !important;
            box-shadow: 0 0 0 3px rgb(${accent} / 0.12) !important;
        }`;
    if (!s.bubbles) return css;

    const bubble = hexToRgb(s.bubbleColor, DEFAULT_BUBBLE);
    const a = Math.min(Math.max(s.bubbleOpacity ?? 75, 10), 100) / 100;
    const r = Math.min(Math.max(s.bubbleRadius ?? 18, 4), 24);
    const tail = Math.max(r / 3, 4);
    // Текст каждого сообщения — в своём пузыре по ширине текста. Пустой блок текста
    // (сообщение только с картинкой) и цитату в ответе (repliedTextContent — у неё тоже есть
    // класс messageContent_) пузырём не рисуем. Слева от пробела — только li с id: дёшево.
    const content = '[class*="messageContent_"]:not(:empty):not([class*="repliedTextContent"])';
    css += `
        li[id^="chat-messages-"] ${content} {
            width: fit-content !important;
            max-width: min(100%, 720px) !important;
            box-sizing: border-box !important;
            padding: 6px 14px !important;
            /* Discord сдвигает текст на -72px влево (под аватарку) — для пузыря это убираем */
            margin-inline-start: 0 !important;
            margin-top: 2px !important;
            border-radius: ${r}px ${r}px ${r}px ${tail}px !important;
            background: rgb(${bubble} / ${a}) !important;
            border: 1px solid rgb(255 255 255 / 0.06) !important;
        }
        li[id^="chat-messages-"] a[class*="anchor_"] {
            color: rgb(${accent}) !important;
        }`;
    if (!s.ownRight) return css;

    // Свои сообщения — справа и цветом акцента, как в Telegram. Класс dedboost-own ставит
    // плагин (см. markOwn); это точное имя класса, а не [class*=…], поэтому проверка дешёвая.
    css += `
        li.dedboost-own ${content} {
            margin-inline-start: auto !important;
            border-radius: ${r}px ${r}px ${tail}px ${r}px !important;
            background: rgb(${accent} / ${Math.min(a * 0.5, 0.55)}) !important;
            border-color: rgb(${accent} / 0.35) !important;
        }
        li.dedboost-own a[class*="anchor_"] {
            color: rgb(255 255 255) !important;
            text-decoration: underline !important;
        }
        li.dedboost-own [class*="header_"] {
            text-align: right !important;
        }
        li.dedboost-own img[class*="avatar_"],
        li.dedboost-own img[class*="avatarDecoration_"] {
            visibility: hidden !important;
        }
        li.dedboost-own [id^="message-accessories-"] {
            justify-items: end !important;
        }`;
    return css;
}

function Swatch({ color, size = 22 }: { color: string; size?: number; }) {
    return <div style={{ width: size, height: size, borderRadius: 999, background: color, border: "1px solid rgb(255 255 255 / .2)", flexShrink: 0 }} />;
}

let themeTimer: ReturnType<typeof setTimeout> | null = null;

function ThemeEditor() {
    const s = settings.use(["accentColor", "bubbleColor", "bubbleRadius", "bubbleOpacity", "bubbles", "fontFamily", "customFont", "messageFontSize"]);
    const previewFont = chosenFont();
    const [accent, setAccent] = useState(s.accentColor || DEFAULT_ACCENT);
    const [bubble, setBubble] = useState(s.bubbleColor || DEFAULT_BUBBLE);

    // Пока тянешь пипетку — меняется только превью в настройках; в Discord цвет
    // применяется, когда остановишься (иначе каждое движение пересчитывало бы стили всего окна)
    function commit(nextAccent: string, nextBubble: string) {
        setAccent(nextAccent);
        setBubble(nextBubble);
        if (themeTimer) clearTimeout(themeTimer);
        themeTimer = setTimeout(() => {
            settings.store.accentColor = nextAccent;
            settings.store.bubbleColor = nextBubble;
            applyStyles();
        }, 200);
    }

    const r = s.bubbleRadius ?? 18;
    const a = (s.bubbleOpacity ?? 75) / 100;
    const bubbleBg = `rgb(${hexToRgb(bubble, DEFAULT_BUBBLE)} / ${a})`;
    const label = { color: "var(--text-default)", fontSize: 14 } as const;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {PRESETS.map(([name, ac, bu]) => (
                    <button
                        key={name}
                        onClick={() => commit(ac, bu)}
                        style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 6px 6px",
                            borderRadius: 999, cursor: "pointer", color: "var(--text-default)",
                            background: "rgb(255 255 255 / .05)",
                            border: `1px solid ${accent === ac && bubble === bu ? ac : "rgb(255 255 255 / .1)"}`
                        }}
                    >
                        <Swatch color={ac} size={18} />
                        <Swatch color={bu} size={18} />
                        {name}
                    </button>
                ))}
            </div>
            <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", ...label }}>
                    <input type="color" value={accent} onChange={e => commit(e.currentTarget.value, bubble)} />
                    Акцент
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", ...label }}>
                    <input type="color" value={bubble} onChange={e => commit(accent, e.currentTarget.value)} />
                    Пузырь сообщения
                </label>
            </div>
            {/* живое превью */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, borderRadius: 16, background: "rgb(0 0 0 / .25)", fontFamily: previewFont ? fontStack(previewFont) : undefined }}>
                <div style={{ color: accent, fontSize: 13, fontWeight: 600 }}>Дед Богдан</div>
                <div style={{
                    width: "fit-content", padding: "6px 14px", color: "var(--text-default)",
                    fontSize: s.messageFontSize ?? 16,
                    borderRadius: `${r}px ${r}px ${r}px ${Math.max(r / 3, 4)}px`,
                    background: s.bubbles ? bubbleBg : "transparent",
                    border: s.bubbles ? "1px solid rgb(255 255 255 / .06)" : "none"
                }}>
                    Так будут выглядеть сообщения. <span style={{ color: accent }}>ссылка</span>
                </div>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    updater: {
        type: OptionType.COMPONENT,
        component: UpdaterSetting
    },
    migratedFromDedBoost: {
        type: OptionType.BOOLEAN,
        description: "Настройки перенесены со старого имени плагина (DedBoost)",
        default: false,
        hidden: true
    },
    // --- Наш интерфейс ---
    roundUi: {
        type: OptionType.BOOLEAN,
        description: "Интерфейс Bubbscord: капсулы, «таблетки», скругления и плавные анимации",
        default: true,
        onChange: () => applyUi()
    },

    // --- Тема в стиле Telegram ---
    themeEditor: {
        type: OptionType.COMPONENT,
        component: ThemeEditor
    },
    bubbles: {
        type: OptionType.BOOLEAN,
        description: "Сообщения пузырями, как в Telegram",
        default: true,
        onChange: () => { applyStyles(); scheduleMarkOwn(); }
    },
    ownRight: {
        type: OptionType.BOOLEAN,
        description: "Свои сообщения — справа и цветом акцента, как в Telegram",
        default: true,
        onChange: () => { applyStyles(); scheduleMarkOwn(); }
    },
    bubbleRadius: {
        type: OptionType.SLIDER,
        description: "Скругление пузырей, px",
        markers: [4, 8, 12, 16, 20, 24],
        default: 18,
        stickToMarkers: false,
        onChange: () => applyStyles()
    },
    bubbleOpacity: {
        type: OptionType.SLIDER,
        description: "Плотность пузырей, % (меньше — сильнее видно обои)",
        markers: [10, 25, 40, 55, 70, 85, 100],
        default: 75,
        stickToMarkers: false,
        onChange: () => applyStyles()
    },
    // --- Шрифты ---
    fontFamily: {
        type: OptionType.SELECT,
        description: "Шрифт (как в Telegram). Шрифты из Windows — работают без интернета и не тормозят",
        options: FONT_OPTIONS,
        onChange: () => applyStyles()
    },
    customFont: {
        type: OptionType.STRING,
        description: "Свой шрифт: точное название шрифта, установленного на компьютере (например, Nunito). Работает, если выше выбрано «Свой»",
        default: "",
        onChange: () => applyStyles()
    },
    fontScope: {
        type: OptionType.SELECT,
        description: "Где менять шрифт",
        options: [
            { label: "Во всём Discord", value: "all", default: true },
            { label: "Только в сообщениях", value: "messages" }
        ],
        onChange: () => applyStyles()
    },
    messageFontSize: {
        type: OptionType.SLIDER,
        description: "Размер текста сообщений, px (16 — как в Discord)",
        markers: [12, 13, 14, 15, 16, 17, 18, 19, 20, 22],
        default: 16,
        stickToMarkers: true,
        onChange: () => applyStyles()
    },

    // --- Из Telegram ---
    telegramHub: {
        type: OptionType.COMPONENT,
        component: () => (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={() => openHub("favorites")}>⭐ Избранное</Button>
                <Button onClick={() => openHub("reminders")}>⏰ Напоминания</Button>
                <Button onClick={() => openHub("templates")}>⚡ Шаблоны</Button>
                <Button onClick={() => openHub("workshop")}>🎨 Мастерская</Button>
            </div>
        )
    },
    workshopEnabled: {
        type: OptionType.BOOLEAN,
        description: "Мастерская: таблички у ников и эффекты профиля (свои и других пользователей Bubbscord)",
        default: true,
        onChange: (v: boolean) => setWorkshopEnabled(v)
    },
    foldersEnabled: {
        type: OptionType.BOOLEAN,
        description: "Папки чатов: вкладки «Все / Личные / Группы / свои» над списком ЛС",
        default: true,
        onChange: () => refreshFolders()
    },
    translateTo: {
        type: OptionType.SELECT,
        description: "Переводить сообщения на язык",
        options: TRANSLATE_LANGUAGES
    },
    accentColor: {
        type: OptionType.STRING,
        description: "Акцентный цвет (выбирается выше)",
        default: DEFAULT_ACCENT,
        hidden: true
    },
    bubbleColor: {
        type: OptionType.STRING,
        description: "Цвет пузыря (выбирается выше)",
        default: DEFAULT_BUBBLE,
        hidden: true
    },

    // --- Скорость ---
    fastChat: {
        type: OptionType.BOOLEAN,
        description: "Быстрый чат: сплошной тёмный фон под сообщениями (прокрутка заметно легче; обои остаются по бокам)",
        default: false,
        onChange: () => applyStyles()
    },
    noAnimations: {
        type: OptionType.BOOLEAN,
        description: "Без анимаций: интерфейс реагирует мгновенно, меньше нагрузка на GPU (выключено — тема Bubbscord Round даёт свои лёгкие анимации)",
        default: false,
        onChange: () => applyStyles()
    },
    noBlur: {
        type: OptionType.BOOLEAN,
        description: "Без размытия и тяжёлых теней (backdrop-filter — самый дорогой эффект)",
        default: true,
        onChange: () => applyStyles()
    },
    hideClutter: {
        type: OptionType.BOOLEAN,
        description: "Спрятать кнопки подарка и стикеров, квесты и лаунчер приложений (вкладки Nitro и Магазин остаются)",
        default: true,
        onChange: () => applyStyles()
    },
    hideActiveNow: {
        type: OptionType.BOOLEAN,
        description: "Спрятать колонку «Сейчас активны» на странице друзей",
        default: true,
        onChange: () => applyStyles()
    },
    hideDecorations: {
        type: OptionType.BOOLEAN,
        description: "Убрать украшения аватаров, эффекты профилей и анимированные таблички ников — они крутятся постоянно и жрут CPU",
        default: true,
        onChange: () => applyStyles()
    },
    pauseWhenUnfocused: {
        type: OptionType.BOOLEAN,
        description: "Ставить на паузу GIF-видео, когда окно Discord свёрнуто или не в фокусе (во время игры)",
        default: true,
        onChange: () => applyStyles()
    },

    // --- Обои ---
    wallpaperEnabled: {
        type: OptionType.BOOLEAN,
        description: "Обои: своя картинка на фоне Discord",
        default: false,
        onChange: () => { applyStyles(); probeWallpaperUrl(); }
    },
    wallpaperFile: {
        type: OptionType.COMPONENT,
        component: WallpaperPicker
    },
    wallpaperUrl: {
        type: OptionType.STRING,
        description: "…или ссылка на картинку (если файл с компьютера не выбран). Работают i.imgur.com, i.ibb.co, i.pinimg.com, cdn.discordapp.com, files.catbox.moe, GitHub",
        default: "",
        onChange: () => { applyStyles(); probeWallpaperUrl(); }
    },
    wallpaperPosition: {
        type: OptionType.SELECT,
        description: "Какую часть картинки показывать, если она не влезает целиком",
        options: [
            { label: "Верх (лица и головы не обрезаются)", value: "center top", default: true },
            { label: "Центр", value: "center center" },
            { label: "Низ", value: "center bottom" },
            { label: "Левый край", value: "left center" },
            { label: "Правый край", value: "right center" }
        ],
        onChange: () => applyStyles()
    },
    wallpaperDim: {
        type: OptionType.SLIDER,
        description: "Затемнение обоев, % (чтобы текст читался)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
        default: 70,
        stickToMarkers: false,
        onChange: () => applyStyles()
    },
    wallpaperBlur: {
        type: OptionType.SLIDER,
        description: "Размытие обоев, px (считается один раз, на скорость почти не влияет)",
        markers: [0, 5, 10, 15, 20, 25, 30],
        default: 0,
        stickToMarkers: false,
        onChange: () => applyStyles()
    },
    panelOpacity: {
        type: OptionType.SLIDER,
        description: "Тень на боковых панелях, % (0 — полностью прозрачные)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        default: 40,
        stickToMarkers: false,
        onChange: () => applyStyles()
    }
});

// ---------- Пауза в фоне ----------
const pausedVideos = new Set<HTMLVideoElement>();

function goIdle() {
    if (!settings.store.pauseWhenUnfocused) return;
    // Без классов на <body>: только пауза видео, чтобы не пересчитывать стили всего окна
    // Гифки в Discord — это зацикленные беззвучные <video loop>; голос/стримы не трогаем
    document.querySelectorAll<HTMLVideoElement>("video[loop]").forEach(v => {
        if (!v.paused) {
            v.pause();
            pausedVideos.add(v);
        }
    });
}

function wakeUp() {
    pausedVideos.forEach(v => {
        if (v.isConnected) v.play().catch(() => { });
    });
    pausedVideos.clear();
}

// Свёрнутый Discord: гифки на паузе и никаких фоновых таймеров плагина
function onVisibility() {
    if (document.hidden) {
        goIdle();
        stopPanelsTimer();
    } else {
        wakeUp();
        trackPanels();
        startPanelsTimer();
    }
}

// ---------- Обои: логика ----------
let localWallpaperUrl: string | null = null;

async function loadLocalWallpaper() {
    if (localWallpaperUrl) URL.revokeObjectURL(localWallpaperUrl);
    localWallpaperUrl = null;
    const blob = await DataStore.get<Blob>(WALLPAPER_KEY);
    if (blob) localWallpaperUrl = URL.createObjectURL(blob);
    applyStyles();
}

function wallpaperCss(): string {
    const s = settings.store;
    const src = localWallpaperUrl || s.wallpaperUrl?.trim();
    if (!s.wallpaperEnabled || !src) return "";

    const dim = Math.min(Math.max(s.wallpaperDim ?? 70, 0), 95) / 100;
    const panels = Math.min(Math.max(s.panelOpacity ?? 40, 0), 100) / 100;
    const blur = Math.max(s.wallpaperBlur ?? 0, 0);
    const url = src.replace(/["\\\n]/g, "");
    const pos = s.wallpaperPosition || "center top";

    // Основа для обоев (wallpaper.css включается вместе с ними): панели прозрачные,
    // читаемость даёт одно ровное затемнение самой картинки.
    // Раньше тут каждая панель была полупрозрачной — слои накладывались и картинка уходила почти в чёрный.
    // Здесь только подмена картинки и крутилок; :root:root и html body — чтобы перебить wallpaper.css.
    return `
        :root:root {
            --dedboost-dim: ${dim};
            --dedboost-panels: ${panels};
            --dedboost-position: ${pos};
        }
        html body::before {
            inset: ${-blur * 2}px;
            background:
                linear-gradient(rgb(0 0 0 / ${dim}), rgb(0 0 0 / ${dim})),
                url("${url}") ${pos} / cover no-repeat;
            ${blur ? `filter: blur(${blur}px);` : ""}
        }`;
}

// Картинку по ссылке Discord пускает только с разрешённых сайтов — проверяем и честно говорим, если нет
let probedUrl = "";
function probeWallpaperUrl() {
    const s = settings.store;
    const url = s.wallpaperUrl?.trim();
    if (!s.wallpaperEnabled || localWallpaperUrl || !url || url === probedUrl) return;
    probedUrl = url;
    const img = new Image();
    img.onerror = () => showToast({
        text: "Bubbscord: картинка по ссылке не загрузилась (сайт не разрешён Discord или это не прямая ссылка). Сохрани её и выбери файлом с компьютера.",
        variant: "critical"
    });
    img.src = url;
}

// ---------- Наш интерфейс (встроенные темы) ----------
let uiActive = false;

function applyUi() {
    if (!uiActive) return;
    const s = settings.store;
    s.roundUi ? enableStyle(roundStyle) : disableStyle(roundStyle);
    // свои обои из настроек важнее встроенных
    // основа для обоев (прозрачные панели) включается только вместе со своей картинкой
    const customWallpaper = s.wallpaperEnabled && (localWallpaperUrl || s.wallpaperUrl?.trim());
    customWallpaper || hasActiveChatWallpaper() ? enableStyle(wallpaperStyle) : disableStyle(wallpaperStyle);
}


// ---------- Высота нижнего блока (профиль + панель звонка) ----------
// Discord держит этот блок поверх колонок, и его высота меняется (например, во время звонка).
// Меряем её и отдаём теме в --dedboost-panels-h, чтобы капсула серверов заканчивалась ровно над ним.
let panelsObserver: ResizeObserver | null = null;
let panelsEl: Element | null = null;
let panelsTimer: ReturnType<typeof setInterval> | null = null;

let lastPanelsH = -1;
let voiceEl: Element | null = null;
let varTarget: HTMLElement | null = null;

// высота нижнего блока = от верхнего края самого высокого из (профиль, панель звонка) до низа окна
function measurePanels() {
    let top = Infinity;
    if (panelsEl?.isConnected) top = Math.min(top, panelsEl.getBoundingClientRect().top);
    if (voiceEl?.isConnected) {
        const r = voiceEl.getBoundingClientRect();
        if (r.height > 0) top = Math.min(top, r.top);
    }
    if (top === Infinity) return;
    const h = Math.max(0, Math.round(window.innerHeight - top));
    if (h === lastPanelsH) return;
    lastPanelsH = h;
    // ставим на левую колонку, а не на корень документа: смена переменной на корне
    // заставляла Discord пересчитывать стили всего окна, а так — только колонку
    const target = panelsEl?.parentElement as HTMLElement | null;
    if (!target) return;
    if (varTarget && varTarget !== target) varTarget.style.removeProperty("--dedboost-panels-h");
    varTarget = target;
    target.style.setProperty("--dedboost-panels-h", `${h}px`);
}

// Контейнер панели звонка у Discord держит отступ 10px между строкой статуса и кнопками
// и линию снизу — из-за них наша капсула выглядела разрубленной. Убираем это прямо на элементе
// (он уже найден для замера), без CSS-правил с :has, которые проверялись бы по всему окну.
function sealVoice(el: HTMLElement | null, on: boolean) {
    if (!el) return;
    if (on) {
        el.style.setProperty("gap", "0", "important");
        el.style.setProperty("border-bottom", "none", "important");
    } else {
        el.style.removeProperty("gap");
        el.style.removeProperty("border-bottom");
    }
}

function trackPanels() {
    // ищем только внутри левой колонки (а не по всему окну с чатом) — так проверка почти бесплатная
    const sidebar = panelsEl?.isConnected ? panelsEl.parentElement : null;
    const el = sidebar?.querySelector(':scope > section[class*="panels_"]') ?? document.querySelector('section[class*="panels_"]');
    // панель звонка — родитель кнопок звонка (есть только во время звонка). Она лежит внутри
    // того же раздела, поэтому ищем только в нём: ~10 элементов вместо всей колонки (0.009 мс против 0.11 мс)
    const voice = el?.querySelector('[class*="actionButtons_"]')?.parentElement ?? null;
    if (el !== panelsEl || voice !== voiceEl) {
        panelsObserver?.disconnect();
        if (voice !== voiceEl) {
            sealVoice(voiceEl as HTMLElement | null, false);
            sealVoice(voice as HTMLElement | null, true);
        }
        panelsEl = el;
        voiceEl = voice;
        panelsObserver ??= new ResizeObserver(measurePanels);
        if (el) panelsObserver.observe(el);
        if (voice) panelsObserver.observe(voice);
        // замер только при смене элементов; дальше размеры сообщает ResizeObserver —
        // так мы не заставляем Discord пересчитывать раскладку каждые 2 секунды, пока ты печатаешь
        measurePanels();
    }
    // заодно (тем же редким таймером) проверяем, не сменился ли список сообщений и на месте ли вкладки папок
    watchChat();
    ensureFolderTabs();
}

// при подключении к звонку панель появляется сразу — находим её через кадр, а не ждём таймер
let rtcTimer: ReturnType<typeof setTimeout> | null = null;
function onRtcState() {
    requestAnimationFrame(trackPanels);
    if (rtcTimer) clearTimeout(rtcTimer);
    rtcTimer = setTimeout(trackPanels, 400);
}

function startPanelsTimer() {
    if (panelsTimer) return;
    // раздел может пересоздаваться (смена аккаунта, перезагрузка интерфейса) — раз в 2 секунды проверяем, тот ли это элемент
    panelsTimer = setInterval(trackPanels, 2000);
}

function stopPanelsTimer() {
    if (panelsTimer) clearInterval(panelsTimer);
    panelsTimer = null;
}

function startPanelsTracking() {
    trackPanels();
    // свёрнутое окно ничего не перерисовывает — и проверять там нечего
    if (!document.hidden) startPanelsTimer();
}

function stopPanelsTracking() {
    stopPanelsTimer();
    sealVoice(voiceEl as HTMLElement | null, false);
    panelsObserver?.disconnect();
    panelsObserver = null;
    panelsEl = null;
    voiceEl = null;
    lastPanelsH = -1;
    varTarget?.style.removeProperty("--dedboost-panels-h");
    varTarget = null;
}

// ---------- Свои сообщения (для пузырей справа) ----------
// Discord не помечает «это моё сообщение». Признак есть только у первого сообщения группы:
// в адресе его аватарки стоит ID автора. Остальные сообщения группы идут следом без аватарки,
// поэтому проходим список по порядку и запоминаем, чья сейчас группа.
// Следим только за прямыми детьми списка сообщений (без subtree), пересчёт — раз в кадр.
let chatList: Element | null = null;
let chatObserver: MutationObserver | null = null;
let ownFrame = 0;

function isOwnGroupStart(msg: Element, id: string, names: string[]): boolean {
    const img = msg.querySelector<HTMLImageElement>('img[class*="avatar_"]');
    if (img?.src.includes(`/${id}/`)) return true;
    // без своей аватарки (стандартная картинка Discord) — сверяем имя в заголовке
    if (img && img.src.includes("/avatars/") && !img.src.includes("/embed/avatars/")) return false;
    const name = msg.querySelector('[id^="message-username-"] [data-text]')?.getAttribute("data-text");
    return !!name && names.includes(name);
}

function markOwn() {
    ownFrame = 0;
    const list = chatList;
    if (!list?.isConnected) return;
    const enabled = settings.store.bubbles && settings.store.ownRight;
    const user = UserStore.getCurrentUser();
    if (!user) return;
    const names = [user.globalName, user.username].filter(Boolean) as string[];
    let own = false;
    for (const li of list.children) {
        if (li.tagName !== "LI") continue;
        const msg = li.firstElementChild;
        if (msg?.className.includes("groupStart_")) own = isOwnGroupStart(msg, user.id, names);
        const mark = enabled && own;
        // classList.toggle меняет класс только если состояние другое — лишних пересчётов нет
        if (li.classList.contains("dedboost-own") !== mark) li.classList.toggle("dedboost-own", mark);
    }
}

function scheduleMarkOwn() {
    if (!ownFrame) ownFrame = requestAnimationFrame(markOwn);
}

// Список сообщений пересоздаётся при смене канала — проверяем, тот ли это ещё список
function watchChat() {
    if (chatList?.isConnected) return;
    chatObserver?.disconnect();
    chatList = document.querySelector('ol[data-list-id="chat-messages"]');
    if (!chatList) return;
    chatObserver ??= new MutationObserver(scheduleMarkOwn);
    chatObserver.observe(chatList, { childList: true });
    scheduleMarkOwn();
}

// после смены канала ждём, пока Discord нарисует новый список (несколько кадров)
function onChannelSelect() {
    let tries = 0;
    const attempt = () => {
        const ol = document.querySelector('ol[data-list-id="chat-messages"]');
        if (ol && ol !== chatList) {
            chatList = null;
            watchChat();
            return;
        }
        if (++tries < 30) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
}

function stopOwnTracking() {
    FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
    chatObserver?.disconnect();
    chatObserver = null;
    if (ownFrame) cancelAnimationFrame(ownFrame);
    ownFrame = 0;
    document.querySelectorAll("li.dedboost-own").forEach(li => li.classList.remove("dedboost-own"));
    chatList = null;
}

// ---------- Переименование DedBoost → Bubbscord ----------
// Vencord хранит настройки по имени плагина, поэтому после переименования они бы сбросились.
// Один раз переносим всё, что было сохранено под старым именем (цвета, обои, переключатели).
function migrateFromDedBoost() {
    if (settings.store.migratedFromDedBoost) return;
    const old = (Settings.plugins as Record<string, Record<string, unknown> | undefined>).DedBoost;
    if (old) {
        const store = settings.store as Record<string, unknown>;
        for (const key of Object.keys(settings.def)) {
            if (key !== "migratedFromDedBoost" && old[key] !== undefined) store[key] = old[key];
        }
    }
    settings.store.migratedFromDedBoost = true;
}

// ---------- Применение стилей ----------
let styleEl: HTMLStyleElement | null = null;
let lastCss: string | null = null;
const CSS_KEYS = Object.keys(CSS) as Key[];

function applyStyles() {
    const css = CSS_KEYS.filter(key => settings.store[key]).map(key => CSS[key]).join("\n") + wallpaperCss() + bubblesCss() + fontsCss();
    // Перезапись <style> = повторный разбор CSS и пересчёт стилей всего окна,
    // поэтому пишем только если текст реально изменился
    if (css !== lastCss) {
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "vc-dedboost";
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
        lastCss = css;
    }
    applyUi();
}

export default definePlugin({
    name: "Bubbscord",
    description: "Округлый интерфейс, сообщения пузырями как в Telegram, редактор темы, свои обои и разгрузка Discord",
    authors: [{ name: "Sherry Williams", id: 0n }],
    settings,

    // функции из Telegram (telegram.tsx)
    contextMenus: telegramContextMenus,
    chatBarButton: { icon: StarIcon, render: HubChatBarButton },
    renderMessageAccessory: props => <TranslationAccessory message={props.message} />,
    commands: [templateCommand],

    start() {
        migrateFromDedBoost();
        uiActive = true;
        applyStyles();
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.subscribe("RTC_CONNECTION_STATE", onRtcState);
        startPanelsTracking();
        enableStyle(telegramStyle);
        enableStyle(workshopStyle);
        startWorkshop(settings.store.workshopEnabled !== false);
        startUpdater();
        addChatBarButton("BubbscordTemplates", TemplatesChatBarButton, BoltIcon);
        startTelegram({
            translateTo: () => settings.store.translateTo || "ru",
            onChatWallpaperChange: () => applyUi(),
            foldersEnabled: () => settings.store.foldersEnabled !== false
        });
        loadLocalWallpaper().then(probeWallpaperUrl);
        window.addEventListener("blur", goIdle);
        window.addEventListener("focus", wakeUp);
        document.addEventListener("visibilitychange", onVisibility);
    },

    stop() {
        window.removeEventListener("blur", goIdle);
        window.removeEventListener("focus", wakeUp);
        document.removeEventListener("visibilitychange", onVisibility);
        wakeUp();
        uiActive = false;
        stopPanelsTracking();
        stopOwnTracking();
        stopTelegram();
        stopWorkshop();
        disableStyle(workshopStyle);
        stopUpdater();
        removeChatBarButton("BubbscordTemplates");
        disableStyle(telegramStyle);
        FluxDispatcher.unsubscribe("RTC_CONNECTION_STATE", onRtcState);
        if (rtcTimer) clearTimeout(rtcTimer);
        rtcTimer = null;
        if (themeTimer) clearTimeout(themeTimer);
        themeTimer = null;
        disableStyle(roundStyle);
        disableStyle(wallpaperStyle);
        if (localWallpaperUrl) URL.revokeObjectURL(localWallpaperUrl);
        localWallpaperUrl = null;
        styleEl?.remove();
        styleEl = null;
        lastCss = null;
    }
});
