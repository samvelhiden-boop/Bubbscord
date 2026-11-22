/*
 * Bubbscord — обновления.
 * Раз в сутки смотрит version.json в репозитории на GitHub. Если там версия новее —
 * уведомление «Доступно обновление»: клик → «Обновить сейчас» (git pull + сборка Vencord)
 * → уведомление «Обновлено» → клик перезапускает Discord.
 * Если плагин поставлен не через git clone, кнопка честно скажет, что обновлять надо по README.
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Button } from "@components/Button";
import { PluginNative } from "@utils/types";
import { showToast, useState } from "@webpack/common";

/** версия этой сборки — повышай при каждом выпуске (и в version.json в репозитории) */
export const VERSION = "1.4.0";
/** репозиторий на GitHub в виде «ник/название»; пусто — проверка выключена */
export const UPDATE_REPO = "samvelhiden-boop/Bubbscord";
export const UPDATE_BRANCH = "main";

const KEY_LAST = "Bubbscord_update_lastCheck";
const KEY_NOTIFIED = "Bubbscord_update_notified";
const DAY = 24 * 60 * 60_000;

const Native = VencordNative.pluginHelpers.Bubbscord as PluginNative<typeof import("./native")>;

let timer: ReturnType<typeof setInterval> | null = null;
let firstCheck: ReturnType<typeof setTimeout> | null = null;

function newer(a: string, b: string) {
    const pa = a.split(".").map(n => parseInt(n) || 0), pb = b.split(".").map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
    return false;
}

export const repoUrl = () => `https://github.com/${UPDATE_REPO}`;

type CheckResult = { state: "off"; } | { state: "error"; error: string; } | { state: "latest"; } | { state: "update"; version: string; notes: string; };

// ---------- «Обновить сейчас» ----------
let updateRunning = false;

const STEP_TEXT: Record<string, string> = {
    git: "Не удалось скачать новую версию (git pull). Возможно, в папке плагина что-то меняли вручную.",
    build: "Новая версия скачана, но сборка Vencord не прошла. Попробуй в папке Vencord: pnpm install --frozen-lockfile, потом pnpm build.",
    check: "",
    busy: "Обновление уже идёт."
};

export async function updateNow(): Promise<boolean> {
    if (updateRunning) return false;
    const info = await Native.autoUpdateInfo();
    if (!info.ok) {
        showNotification({
            title: "Bubbscord: обнови вручную",
            body: `${info.reason} Нажми, чтобы открыть страницу плагина.`,
            permanent: true,
            onClick: () => VencordNative.native.openExternal(repoUrl())
        });
        return false;
    }

    updateRunning = true;
    showToast({ text: "Bubbscord: обновляю… это займёт до минуты, Discord можно не трогать" });
    try {
        const r = await Native.runUpdate();
        if (r.ok) {
            showNotification({
                title: "Bubbscord обновлён ✓",
                body: "Нажми, чтобы перезапустить Discord и включить новую версию.",
                permanent: true,
                onClick: () => Native.relaunchDiscord()
            });
            return true;
        }
        showNotification({
            title: "Не удалось обновить Bubbscord",
            body: `${STEP_TEXT[r.step] || ""} ${r.log}`.trim().slice(0, 300),
            permanent: true,
            onClick: () => VencordNative.native.openExternal(repoUrl())
        });
        return false;
    } finally {
        updateRunning = false;
    }
}

// ---------- проверка ----------
export async function checkForUpdate(manual = false): Promise<CheckResult> {
    if (!UPDATE_REPO || !Native?.fetchLatestVersion) return { state: "off" };
    const res = await Native.fetchLatestVersion(UPDATE_REPO, UPDATE_BRANCH);
    await DataStore.set(KEY_LAST, Date.now());
    if (!res.ok) return { state: "error", error: res.error };
    if (!res.version || !newer(res.version, VERSION)) return { state: "latest" };

    // уведомляем об одной и той же версии один раз (ручная проверка показывает всегда)
    const notified = await DataStore.get<string>(KEY_NOTIFIED);
    if (manual || notified !== res.version) {
        await DataStore.set(KEY_NOTIFIED, res.version);
        showNotification({
            title: `Доступно обновление Bubbscord ${res.version}`,
            body: `У тебя ${VERSION}. ${res.notes ? res.notes + " " : ""}Нажми, чтобы обновить.`.slice(0, 260),
            permanent: true,
            onClick: () => { updateNow(); }
        });
    }
    return { state: "update", version: res.version, notes: res.notes };
}

async function dailyCheck() {
    const last = (await DataStore.get<number>(KEY_LAST)) ?? 0;
    if (Date.now() - last >= DAY) checkForUpdate().catch(() => { });
}

export function startUpdater() {
    if (!UPDATE_REPO) return;
    // не мешаем запуску Discord: первая проверка через 15 секунд, дальше — раз в 6 часов смотрим, прошли ли сутки
    firstCheck = setTimeout(dailyCheck, 15_000);
    timer = setInterval(dailyCheck, 6 * 60 * 60_000);
}

export function stopUpdater() {
    if (firstCheck) clearTimeout(firstCheck);
    if (timer) clearInterval(timer);
    firstCheck = timer = null;
}

/** строка в настройках: версия, «Проверить обновления», «Обновить сейчас» */
export function UpdaterSetting() {
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const [available, setAvailable] = useState<string | null>(null);
    if (!UPDATE_REPO) return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Bubbscord {VERSION}</div>;
    return (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-default)" }}>Bubbscord {VERSION}</span>
            <Button
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setStatus("Проверяю…");
                    const r = await checkForUpdate(true).catch(e => ({ state: "error", error: String(e) }) as CheckResult);
                    setBusy(false);
                    setAvailable(r.state === "update" ? r.version : null);
                    setStatus(
                        r.state === "update" ? `Есть новая версия ${r.version}!`
                            : r.state === "latest" ? "У тебя последняя версия ✓"
                                : r.state === "error" ? `Не удалось проверить: ${r.error}`
                                    : ""
                    );
                }}
            >
                Проверить обновления
            </Button>
            {available && (
                <Button
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setStatus("Обновляю… до минуты");
                        const ok = await updateNow();
                        setBusy(false);
                        setStatus(ok ? "Готово — перезапусти Discord (уведомление справа внизу)" : "Не получилось — подробности в уведомлении");
                    }}
                >
                    Обновить сейчас
                </Button>
            )}
            <Button variant="secondary" onClick={() => VencordNative.native.openExternal(repoUrl())}>Страница плагина</Button>
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{status}</span>
        </div>
    );
}
