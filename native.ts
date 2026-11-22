/*
 * Bubbscord — то, что нельзя сделать из окна Discord. Работает в основном процессе Vencord.
 *
 *  • fetchLatestVersion — номер свежей версии с GitHub (только raw.githubusercontent.com, только version.json);
 *  • autoUpdateInfo / runUpdate — «Обновить сейчас»: git pull в папке плагина и pnpm build в папке Vencord.
 *    Команды фиксированные, аргументы от окна Discord в них не попадают;
 *  • relaunchDiscord — перезапуск Discord после обновления.
 */

import { execFile } from "child_process";
import { app, IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

// ---------- автообновление ----------

// этот код собран в Vencord\dist — значит корень Vencord на уровень выше
const vencordRoot = () => join(__dirname, "..");
const pluginDir = () => join(vencordRoot(), "src", "userplugins", "bubbscord");

function isVencordRoot(dir: string) {
    try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
        return pkg?.name === "vencord";
    } catch {
        return false;
    }
}

export function autoUpdateInfo(_: IpcMainInvokeEvent) {
    const root = vencordRoot();
    if (!isVencordRoot(root))
        return { ok: false as const, reason: "Vencord установлен не из исходников — обновляй вручную по README." };
    if (!existsSync(join(pluginDir(), "index.tsx")))
        return { ok: false as const, reason: "Плагин лежит не в src\\userplugins\\bubbscord." };
    // авторская копия (метка .bubbscord-dev) — её никогда не перезаписываем версией с GitHub
    if (existsSync(join(pluginDir(), ".bubbscord-dev")))
        return { ok: false as const, reason: "Это авторская копия Bubbscord — она не обновляется с GitHub." };
    // поставлен из архива (без .git) — тоже можно: при первом обновлении папка станет git-копией репозитория
    return { ok: true as const, fromArchive: !existsSync(join(pluginDir(), ".git")) };
}

/** адрес репозитория — фиксированный, из окна Discord не передаётся */
const REPO_URL = "https://github.com/samvelhiden-boop/Bubbscord.git";

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string; }> {
    return new Promise(resolve => {
        execFile(cmd, args, { cwd, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
            resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: out || String(err ?? "") });
        });
    });
}

let updating = false;

export async function runUpdate(_: IpcMainInvokeEvent) {
    if (updating) return { ok: false as const, step: "busy", log: "Обновление уже идёт" };
    const info = autoUpdateInfo(_);
    if (!info.ok) return { ok: false as const, step: "check", log: info.reason };

    updating = true;
    try {
        const dir = pluginDir();
        let pull: { code: number; out: string; };
        if (info.fromArchive) {
            // 1а) плагин из архива: превращаем папку в git-копию репозитория и ставим последнюю версию.
            // Файлы плагина заменяются версиями с GitHub; настройки, Избранное и т.п. хранятся в Vencord и не трогаются.
            const steps: string[][] = [
                ["-C", dir, "init", "-q"],
                ["-C", dir, "remote", "add", "origin", REPO_URL],
                ["-C", dir, "fetch", "-q", "origin", "main"],
                ["-C", dir, "reset", "-q", "--hard", "origin/main"],
                ["-C", dir, "branch", "-q", "--set-upstream-to=origin/main"]
            ];
            pull = { code: 0, out: "" };
            for (const args of steps) {
                const r = await run("git", args, vencordRoot());
                pull.out += r.out ? r.out + "\n" : "";
                // «remote origin already exists» после неудачной прошлой попытки — не ошибка
                if (r.code !== 0 && !/already exists/i.test(r.out)) { pull.code = r.code; break; }
            }
        } else {
            // 1б) обычный случай. --ff-only: если в папке что-то меняли руками, ничего не ломаем, а говорим об этом
            pull = await run("git", ["-C", dir, "pull", "--ff-only"], vencordRoot());
        }
        if (pull.code !== 0) return { ok: false as const, step: "git", log: pull.out };

        // 2) пересборка Vencord. На Windows pnpm — это .cmd, его запускает cmd.exe; команда фиксированная
        const win = process.platform === "win32";
        const pm = (cmdline: string, bin: string, args: string[]) =>
            win ? run("cmd.exe", ["/d", "/s", "/c", cmdline], vencordRoot()) : run(bin, args, vencordRoot());
        let build = await pm("pnpm build", "pnpm", ["build"]);
        if (build.code !== 0 && /not recognized|не является|ENOENT|not found/i.test(build.out))
            build = await pm("npx pnpm build", "npx", ["pnpm", "build"]);
        if (build.code !== 0) return { ok: false as const, step: "build", log: build.out.slice(-2000) };

        return { ok: true as const, step: "done", log: pull.out.slice(-1000) };
    } finally {
        updating = false;
    }
}

export function relaunchDiscord(_: IpcMainInvokeEvent) {
    app.relaunch();
    app.exit(0);
}
