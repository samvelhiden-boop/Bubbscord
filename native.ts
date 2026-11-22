/*
 * Bubbscord — запросы, которые нельзя сделать из окна Discord (его защита не пускает к GitHub).
 * Работает в основном процессе Vencord. Ходит ТОЛЬКО на raw.githubusercontent.com за version.json.
 */

import { IpcMainInvokeEvent } from "electron";

export async function fetchLatestVersion(_: IpcMainInvokeEvent, repo: string, branch: string) {
    // только «владелец/репозиторий» и имя ветки — никаких произвольных адресов
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch))
        return { ok: false as const, error: "неверное имя репозитория" };

    try {
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/version.json?t=${Date.now()}`, {
            headers: { "Cache-Control": "no-cache" }
        });
        if (!res.ok) return { ok: false as const, error: `GitHub ответил ${res.status}` };
        const data = await res.json();
        return {
            ok: true as const,
            version: String(data.version ?? ""),
            notes: String(data.notes ?? "")
        };
    } catch (e) {
        return { ok: false as const, error: String(e) };
    }
}
