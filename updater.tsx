/*
 * Bubbscord — проверка обновлений.
 * Раз в сутки смотрит version.json в репозитории на GitHub и, если там версия новее,
 * показывает уведомление «Доступно обновление». Обновить сам себя плагин не может:
 * Vencord пересобирается командой (см. README → «Обновление»).
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Button } from "@components/Button";
import { PluginNative } from "@utils/types";
import { useState } from "@webpack/common";

/** версия этой сборки — повышай при каждом выпуске (и в version.json в репозитории) */
export const VERSION = "1.2.0";
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

type CheckResult = { state: "off" } | { state: "error"; error: string; } | { state: "latest"; } | { state: "update"; version: string; notes: string; };

export async function checkForUpdate(manual = false): Promise<CheckResult> {
    if (!UPDATE_REPO || !Native?.fetchLatestVersion) return { state: "off" };
    const res = await Native.fetchLatestVersion(UPDATE_REPO, UPDATE_BRANCH);
    await DataStore.set(KEY_LAST, Date.now());
    if (!res.ok) return { state: "error", error: res.error };
    if (!res.version || !newer(res.version, VERSION)) return { state: "latest" };

    // уведомляем об одной и той же версии один раз (если проверка не ручная)
    const notified = await DataStore.get<string>(KEY_NOTIFIED);
    if (manual || notified !== res.version) {
        await DataStore.set(KEY_NOTIFIED, res.version);
        showNotification({
            title: `Доступно обновление Bubbscord ${res.version}`,
            body: `У тебя ${VERSION}. ${res.notes || "Нажми, чтобы открыть страницу плагина."}`.slice(0, 220),
            permanent: true,
            onClick: () => VencordNative.native.openExternal(repoUrl())
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

/** строка в настройках: версия + кнопка «Проверить обновления» */
export function UpdaterSetting() {
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
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
            <Button variant="secondary" onClick={() => VencordNative.native.openExternal(repoUrl())}>Страница плагина</Button>
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{status}</span>
        </div>
    );
}
