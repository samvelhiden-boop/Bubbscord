/*
 * Bubbscord — Мастерская: таблички (фон у ника в списке участников) и эффекты профиля.
 * Всё рисуется CSS-ом прямо в плагине — без картинок со сторонних сайтов, мгновенно и без нагрузки.
 *
 * Как это видят другие:
 *   • свой выбор ты видишь сразу;
 *   • чтобы табличку и эффект видели все, у кого стоит Bubbscord, — кнопка «Показать всем»
 *     отправляет заявку автору (открывается страница на GitHub), автор добавляет её в общий список
 *     workshop/users.json, и плагин у всех подхватывает его (раз в несколько часов).
 * Пользователей узнаём по ID в адресе аватарки (у стандартной аватарки Discord ID нет — там не сработает).
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { showToast, UserStore, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Bubbscord as PluginNative<typeof import("./native")>;
/** общий список мастерской — всегда из репозитория автора (даже в авторской копии без автообновлений) */
const WORKSHOP_REPO = "samvelhiden-boop/Bubbscord";
const WORKSHOP_BRANCH = "main";
const KEY_ME = "Bubbscord_workshop_me";
const REFRESH = 6 * 60 * 60_000;

// ---------- каталог ----------
interface Plate { id: string; name: string; bg: string; animated?: boolean; }
interface Effect { id: string; name: string; css: string; }

const fade = (rgb: string, a: number) => `rgb(${rgb} / 0) 0%, rgb(${rgb} / ${a * 0.6}) 45%`;

export const PLATES: Plate[] = [
    { id: "sunset", name: "Закат", bg: `linear-gradient(90deg, ${fade("255 140 90", 0.5)}, rgb(255 80 140 / 0.55) 100%)` },
    { id: "ocean", name: "Океан", bg: `linear-gradient(90deg, ${fade("60 160 255", 0.5)}, rgb(40 90 220 / 0.6) 100%)` },
    { id: "sakura", name: "Сакура", bg: `linear-gradient(90deg, ${fade("255 150 200", 0.5)}, rgb(255 105 170 / 0.55) 100%)` },
    { id: "emerald", name: "Изумруд", bg: `linear-gradient(90deg, ${fade("60 220 150", 0.5)}, rgb(20 160 110 / 0.6) 100%)` },
    { id: "gold", name: "Золото", bg: `linear-gradient(90deg, ${fade("255 210 90", 0.5)}, rgb(212 160 40 / 0.6) 100%)` },
    { id: "neon", name: "Неон", bg: `linear-gradient(90deg, ${fade("190 80 255", 0.5)}, rgb(0 220 255 / 0.5) 100%)` },
    { id: "lava", name: "Лава", bg: `linear-gradient(90deg, ${fade("255 90 40", 0.55)}, rgb(200 20 20 / 0.6) 100%)` },
    { id: "mint", name: "Мята", bg: `linear-gradient(90deg, ${fade("150 255 220", 0.45)}, rgb(80 210 190 / 0.5) 100%)` },
    { id: "graphite", name: "Графит", bg: `linear-gradient(90deg, ${fade("200 205 215", 0.35)}, rgb(120 125 140 / 0.45) 100%)` },
    {
        id: "cosmos", name: "Космос",
        bg: "radial-gradient(1px 1px at 70% 30%, #fff 50%, transparent 51%), radial-gradient(1.5px 1.5px at 85% 70%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 60% 75%, #fffa 50%, transparent 51%), "
            + `linear-gradient(90deg, ${fade("90 70 200", 0.5)}, rgb(30 20 90 / 0.75) 100%)`
    },
    {
        id: "aurora", name: "Аврора ✦", animated: true,
        bg: "linear-gradient(90deg, rgb(0 0 0 / 0) 0%, rgb(60 230 200 / 0.4) 30%, rgb(140 90 255 / 0.45) 55%, rgb(60 230 200 / 0.4) 80%, rgb(140 90 255 / 0.45) 100%) 0% 50% / 200% 100%"
    },
    {
        id: "rainbow", name: "Радуга ✦", animated: true,
        bg: "linear-gradient(90deg, rgb(255 80 80 / 0.35), rgb(255 200 60 / 0.35), rgb(80 220 120 / 0.35), rgb(60 160 255 / 0.35), rgb(190 90 255 / 0.35), rgb(255 80 80 / 0.35)) 0% 50% / 200% 100%"
    }
];

const dots = (spec: string[]) => spec.map(s => `radial-gradient(${s} 50%, transparent 51%)`).join(", ");

export const EFFECTS: Effect[] = [
    {
        id: "snow", name: "Снег",
        css: `background-image: ${dots(["2px 2px at 20px 30px, #fff", "1.5px 1.5px at 80px 70px, rgb(255 255 255 / 0.8)", "2.5px 2.5px at 140px 20px, #fff"])};
              background-size: 160px 200px; animation: vc-bubbs-fall 9s linear infinite;`
    },
    {
        id: "sakura", name: "Сакура",
        css: `background-image: ${dots(["3px 2px at 20px 30px, rgb(255 170 210 / 0.9)", "2.5px 2px at 90px 80px, rgb(255 140 190 / 0.8)", "3px 2.5px at 150px 20px, rgb(255 190 220 / 0.9)"])};
              background-size: 180px 220px; animation: vc-bubbs-fall-diag 11s linear infinite;`
    },
    {
        id: "stars", name: "Звёзды",
        css: `background-image: ${dots(["1.5px 1.5px at 30px 40px, #fff", "1px 1px at 100px 90px, rgb(255 255 255 / 0.9)", "2px 2px at 160px 25px, rgb(255 240 200 / 0.95)"])};
              background-size: 190px 140px; animation: vc-bubbs-twinkle 3.2s ease-in-out infinite;`
    },
    {
        id: "embers", name: "Огоньки",
        css: `background-image: ${dots(["2.5px 2.5px at 30px 60px, rgb(255 170 60 / 0.9)", "2px 2px at 100px 120px, rgb(255 110 40 / 0.85)", "3px 3px at 160px 40px, rgb(255 210 120 / 0.9)"])};
              background-size: 180px 200px; animation: vc-bubbs-rise 8s linear infinite;`
    },
    {
        id: "aurora", name: "Северное сияние",
        css: `background: linear-gradient(100deg, transparent 15%, rgb(80 255 200 / 0.18) 40%, rgb(150 100 255 / 0.22) 60%, transparent 85%) 0% 0% / 200% 45% no-repeat;
              animation: vc-bubbs-aurora 8s linear infinite;`
    },
    {
        id: "glow", name: "Неоновая рамка",
        css: "border-radius: inherit; animation: vc-bubbs-glow 2.4s ease-in-out infinite;"
    }
];

const plateById = (id?: string) => PLATES.find(p => p.id === id);
const effectById = (id?: string) => EFFECTS.find(e => e.id === id);

// ---------- данные ----------
interface Choice { nameplate?: string; effect?: string; }
let mine: Choice = {};
let shared: Record<string, Choice> = {};
let styleEl: HTMLStyleElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let enabled = true;

const validId = (id: string) => /^\d{15,21}$/.test(id);

function plateCss(id: string, plate: Plate) {
    const has = `:has(img[src*="/${id}/"])`;
    return `
        [data-list-item-id^="members"]${has},
        [data-list-id^="private-channels"] li${has} [class*="interactive_"] {
            background: ${plate.bg} !important;
            ${plate.animated ? "animation: vc-bubbs-shimmer 7s linear infinite;" : ""}
        }`;
}

function effectCss(id: string, effect: Effect) {
    return `
        :is(.user-profile-popout, .user-profile-sidebar)[class*="outer_"]:has(img[src*="/${id}/"])::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 5;
            border-radius: inherit;
            ${effect.css}
        }`;
}

/** пересобирает правила «у кого какая табличка». Один маленький <style>, меняется только при изменении списка */
function render() {
    if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "vc-bubbscord-workshop";
        document.head.appendChild(styleEl);
    }
    if (!enabled) { styleEl.textContent = ""; return; }
    const all: Record<string, Choice> = { ...shared };
    const me = UserStore.getCurrentUser()?.id;
    if (me) all[me] = { ...all[me], ...mine };
    let css = "";
    for (const [id, c] of Object.entries(all)) {
        if (!validId(id)) continue;
        const p = plateById(c.nameplate), e = effectById(c.effect);
        if (p) css += plateCss(id, p);
        if (e) css += effectCss(id, e);
    }
    if (styleEl.textContent !== css) styleEl.textContent = css;
}

async function refreshShared() {
    if (!Native?.fetchWorkshopUsers) return;
    const r = await Native.fetchWorkshopUsers(WORKSHOP_REPO, WORKSHOP_BRANCH);
    if (!r.ok) return;
    const next: Record<string, Choice> = {};
    for (const [id, c] of Object.entries(r.users ?? {})) {
        if (!validId(id) || typeof c !== "object" || !c) continue;
        const choice = c as Choice;
        next[id] = {
            nameplate: plateById(choice.nameplate) ? choice.nameplate : void 0,
            effect: effectById(choice.effect) ? choice.effect : void 0
        };
    }
    shared = next;
    render();
}

export async function startWorkshop(isEnabled: boolean) {
    enabled = isEnabled;
    mine = (await DataStore.get<Choice>(KEY_ME)) ?? {};
    render();
    // общий список — через 20 секунд после запуска (не мешаем загрузке) и раз в 6 часов
    setTimeout(() => refreshShared().catch(() => { }), 20_000);
    timer = setInterval(() => refreshShared().catch(() => { }), REFRESH);
}

export function stopWorkshop() {
    if (timer) clearInterval(timer);
    timer = null;
    styleEl?.remove();
    styleEl = null;
}

export function setWorkshopEnabled(v: boolean) {
    enabled = v;
    render();
}

function choose(next: Choice) {
    mine = next;
    DataStore.set(KEY_ME, mine);
    render();
}

function sendRequest() {
    const me = UserStore.getCurrentUser();
    if (!me) return;
    const p = plateById(mine.nameplate), e = effectById(mine.effect);
    if (!p && !e) return showToast({ text: "Сначала выбери табличку или эффект" });
    const body = [
        "Заявка в Мастерскую Bubbscord",
        "",
        "```json",
        JSON.stringify({ [me.id]: { nameplate: p?.id, effect: e?.id } }, null, 2),
        "```",
        "",
        `Ник: ${me.username}`
    ].join("\n");
    const url = `https://github.com/${WORKSHOP_REPO}/issues/new?` + new URLSearchParams({ title: `Мастерская: ${me.username}`, body });
    VencordNative.native.openExternal(url);
    showToast({ text: "Открыл заявку на GitHub — нажми там «Submit new issue»" });
}

// ---------- окно ----------
export function WorkshopTab() {
    const [choice, setChoice] = useState<Choice>(mine);
    const me = UserStore.getCurrentUser();
    const name = (me as any)?.globalName || me?.username || "Ты";
    const pick = (next: Choice) => { setChoice(next); choose(next); };

    return (
        <div className="vc-bubbscord-hub-list">
            {!enabled && <div className="vc-bubbscord-empty">Мастерская выключена в настройках Bubbscord.</div>}

            <div className="vc-bubbs-ws-section">Табличка у ника</div>
            <div className="vc-bubbs-ws-grid">
                <button type="button" className={"vc-bubbs-ws-item" + (!choice.nameplate ? " vc-bubbs-ws-item-active" : "")} onClick={() => pick({ ...choice, nameplate: void 0 })}>
                    <div className="vc-bubbs-ws-plate" style={{ background: "rgb(255 255 255 / 0.04)" }}>
                        <div className="vc-bubbs-ws-plate-avatar" /><span className="vc-bubbs-ws-plate-name">{name}</span>
                    </div>
                    Без таблички
                </button>
                {PLATES.map(p => (
                    <button key={p.id} type="button" className={"vc-bubbs-ws-item" + (choice.nameplate === p.id ? " vc-bubbs-ws-item-active" : "")} onClick={() => pick({ ...choice, nameplate: p.id })}>
                        <div className="vc-bubbs-ws-plate" style={{ background: p.bg, animation: p.animated ? "vc-bubbs-shimmer 7s linear infinite" : void 0 }}>
                            <div className="vc-bubbs-ws-plate-avatar" /><span className="vc-bubbs-ws-plate-name">{name}</span>
                        </div>
                        {p.name}
                    </button>
                ))}
            </div>

            <div className="vc-bubbs-ws-section">Эффект профиля</div>
            <div className="vc-bubbs-ws-grid">
                <button type="button" className={"vc-bubbs-ws-item" + (!choice.effect ? " vc-bubbs-ws-item-active" : "")} onClick={() => pick({ ...choice, effect: void 0 })}>
                    <div className="vc-bubbs-ws-effect" />
                    Без эффекта
                </button>
                {EFFECTS.map(e => (
                    <button key={e.id} type="button" className={"vc-bubbs-ws-item" + (choice.effect === e.id ? " vc-bubbs-ws-item-active" : "")} onClick={() => pick({ ...choice, effect: e.id })}>
                        <style>{`.vc-bubbs-ws-fx-${e.id}::after { ${e.css} }`}</style>
                        <div className={`vc-bubbs-ws-effect vc-bubbs-ws-fx-${e.id}`} />
                        {e.name}
                    </button>
                ))}
            </div>

            <div className="vc-bubbscord-card">
                <b>Сейчас это видишь только ты.</b>
                <div>Чтобы табличку и эффект видели все, у кого стоит Bubbscord, — отправь заявку автору. Нужен аккаунт GitHub. После добавления в общий список у всех появится в течение нескольких часов.</div>
                <div className="vc-bubbscord-card-actions">
                    <button type="button" onClick={sendRequest}>Показать всем — отправить заявку</button>
                </div>
            </div>
        </div>
    );
}
