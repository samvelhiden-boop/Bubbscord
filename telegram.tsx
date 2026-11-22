/*
 * Bubbscord — функции из Telegram:
 *   • Избранное (сохранённые сообщения) с поиском
 *   • Напоминания о сообщениях
 *   • Быстрые ответы (шаблоны) — кнопка у поля ввода и команда /шаблон
 *   • Перевод сообщения в один клик
 *   • Свои обои для отдельного чата
 *   • Папки чатов — вкладки над списком ЛС
 *
 * Всё хранится только у тебя на компьютере (DataStore Vencord), никуда не отправляется.
 * Исключение — перевод: текст сообщения уходит в Google Translate (как во встроенном плагине Translate).
 */

import * as DataStore from "@api/DataStore";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { chooseFile } from "@utils/web";
import { Message } from "@vencord/discord-types";
import {
    ChannelStore, ContextMenuApi, FluxDispatcher, Menu, Modal, NavigationRouter, openModal, Parser,
    SelectedChannelStore, showToast, TextInput, useEffect, useState
} from "@webpack/common";

// ---------- связь с основным файлом плагина ----------
interface Hooks {
    translateTo(): string;
    /** есть ли у текущего чата свои обои — чтобы основной файл включил основу для обоев */
    onChatWallpaperChange(): void;
    foldersEnabled(): boolean;
}
let hooks: Hooks | null = null;

const KEY_FAV = "Bubbscord_favorites";
const KEY_REM = "Bubbscord_reminders";
const KEY_TPL = "Bubbscord_templates";
const KEY_FOLDERS = "Bubbscord_folders";
const KEY_WALL_INDEX = "Bubbscord_chatwall_index";
const wallKey = (channelId: string) => `Bubbscord_chatwall_${channelId}`;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- иконки ----------
type IconProps = { width?: number | string; height?: number | string; className?: string; [key: string]: any; };
const svg = (path: string) => ({ width = 20, height = 20, className }: IconProps) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d={path} />
    </svg>
);
export const StarIcon = svg("M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z");
const BellIcon = svg("M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.8V3.5a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v5l-2 2v1h18v-1z");
export const BoltIcon = svg("M13 2 4 14h6l-1 8 9-12h-6z");
const TranslateIcon = svg("M12.9 15.1 10.4 12.6l.03-.03A17.5 17.5 0 0 0 14.1 6H17V4h-7V2H8v2H1v2h11.2A15.8 15.8 0 0 1 9 11.4 15.6 15.6 0 0 1 6.7 8H4.7a17.6 17.6 0 0 0 3 4.6l-5.1 5L4 19l5-5 3.1 3.1zM18.5 10h-2L12 22h2l1.1-3h4.8l1.1 3h2zm-2.6 7 1.6-4.3L19.1 17z");
const ImageIcon = svg("M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z");
const FolderIcon = svg("M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z");

// ---------- общие помощники ----------
function messageText(m: Message): string {
    return m.content
        || (m as any).messageSnapshots?.[0]?.message?.content
        || "";
}

function authorName(m: Message): string {
    const a = m.author as any;
    return a?.globalName || a?.global_name || a?.username || "Кто-то";
}

function guildOf(channelId: string): string | null {
    return ChannelStore.getChannel(channelId)?.guild_id ?? null;
}

function jumpTo(guildId: string | null | undefined, channelId: string, messageId?: string) {
    NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${channelId}${messageId ? "/" + messageId : ""}`);
}

const fmtDate = (ts: number) => new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// маленькое хранилище с подпиской — чтобы окна обновлялись сами
function makeStore<T>(key: string) {
    let items: T[] = [];
    const listeners = new Set<() => void>();
    return {
        get: () => items,
        async load() { items = (await DataStore.get<T[]>(key)) ?? []; listeners.forEach(l => l()); },
        set(next: T[]) { items = next; DataStore.set(key, next); listeners.forEach(l => l()); },
        use(): T[] {
            const [, force] = useState(0);
            useEffect(() => {
                const l = () => force(x => x + 1);
                listeners.add(l);
                return () => void listeners.delete(l);
            }, []);
            return items;
        }
    };
}

// =====================================================================
// 1. Избранное
// =====================================================================
interface Favorite {
    id: string;
    channelId: string;
    guildId: string | null;
    author: string;
    avatar?: string;
    content: string;
    images: string[];
    ts: number;
    savedAt: number;
}
const favorites = makeStore<Favorite>(KEY_FAV);

function isFavorite(messageId: string) {
    return favorites.get().some(f => f.id === messageId);
}

function toggleFavorite(m: Message) {
    if (isFavorite(m.id)) {
        favorites.set(favorites.get().filter(f => f.id !== m.id));
        showToast({ text: "Убрано из Избранного" });
        return;
    }
    const a = m.author as any;
    const fav: Favorite = {
        id: m.id,
        channelId: m.channel_id,
        guildId: guildOf(m.channel_id),
        author: authorName(m),
        avatar: typeof a?.getAvatarURL === "function" ? a.getAvatarURL(void 0, 64) : void 0,
        content: messageText(m),
        images: (m.attachments ?? [])
            .filter((x: any) => /^image\//.test(x.content_type ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(x.filename ?? ""))
            .map((x: any) => x.proxy_url || x.url)
            .slice(0, 4),
        ts: +new Date(m.timestamp as any) || Date.now(),
        savedAt: Date.now()
    };
    favorites.set([fav, ...favorites.get()]);
    showToast({ text: "Сохранено в Избранное ⭐" });
}

// =====================================================================
// 2. Напоминания
// =====================================================================
interface Reminder {
    id: string;
    messageId: string;
    channelId: string;
    guildId: string | null;
    author: string;
    content: string;
    due: number;
}
const reminders = makeStore<Reminder>(KEY_REM);
let reminderTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReminders() {
    if (reminderTimer) clearTimeout(reminderTimer);
    reminderTimer = null;
    const list = reminders.get();
    if (!list.length) return;
    const next = Math.min(...list.map(r => r.due));
    // один таймер на ближайшее напоминание (setTimeout не любит задержки больше ~24 дней)
    reminderTimer = setTimeout(fireReminders, Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1));
}

function fireReminders() {
    const now = Date.now() + 500;
    const list = reminders.get();
    const due = list.filter(r => r.due <= now);
    if (due.length) reminders.set(list.filter(r => r.due > now));
    for (const r of due) {
        showNotification({
            title: "⏰ Напоминание",
            body: `${r.author}: ${r.content || "сообщение"}`.slice(0, 200),
            permanent: true,
            onClick: () => jumpTo(r.guildId, r.channelId, r.messageId)
        });
    }
    scheduleReminders();
}

function remindAt(m: Message, due: number) {
    const r: Reminder = {
        id: uid(),
        messageId: m.id,
        channelId: m.channel_id,
        guildId: guildOf(m.channel_id),
        author: authorName(m),
        content: messageText(m).slice(0, 300),
        due
    };
    reminders.set([...reminders.get(), r]);
    scheduleReminders();
    showToast({ text: `Напомню ${fmtDate(due)} ⏰` });
}

function reminderOptions(): { id: string; label: string; due: number; }[] {
    const now = new Date();
    const evening = new Date(now); evening.setHours(20, 0, 0, 0);
    if (evening.getTime() <= now.getTime() + 10 * 60_000) evening.setDate(evening.getDate() + 1);
    const morning = new Date(now); morning.setDate(morning.getDate() + 1); morning.setHours(9, 0, 0, 0);
    return [
        { id: "20m", label: "Через 20 минут", due: Date.now() + 20 * 60_000 },
        { id: "1h", label: "Через 1 час", due: Date.now() + 60 * 60_000 },
        { id: "3h", label: "Через 3 часа", due: Date.now() + 3 * 60 * 60_000 },
        { id: "evening", label: evening.getDate() === now.getDate() ? "Сегодня в 20:00" : "Завтра в 20:00", due: evening.getTime() },
        { id: "morning", label: "Завтра в 9:00", due: morning.getTime() }
    ];
}

// =====================================================================
// 3. Быстрые ответы (шаблоны)
// =====================================================================
interface Template { id: string; name: string; text: string; }
const templates = makeStore<Template>(KEY_TPL);

function findTemplate(name: string) {
    const n = name.trim().toLowerCase();
    return templates.get().find(t => t.name.toLowerCase() === n);
}

export const templateCommand = {
    name: "шаблон",
    description: "Отправить быстрый ответ (шаблон Bubbscord)",
    inputType: ApplicationCommandInputType.BUILT_IN_TEXT,
    options: [{
        name: "название",
        description: "Название шаблона",
        type: ApplicationCommandOptionType.STRING,
        required: true
    }],
    execute(args: any[]) {
        const name = findOption<string>(args, "название", "");
        const t = findTemplate(name);
        if (!t) {
            showToast({ text: `Шаблон «${name}» не найден`, variant: "critical" });
            return;
        }
        return { content: t.text };
    }
};

function openTemplatesMenu(e: React.MouseEvent) {
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-bubbscord-templates" onClose={ContextMenuApi.closeContextMenu} aria-label="Быстрые ответы">
            <Menu.MenuGroup>
                {templates.get().length === 0
                    ? <Menu.MenuItem id="vc-bubbscord-tpl-empty" label="Шаблонов пока нет" disabled />
                    : templates.get().map(t => (
                        <Menu.MenuItem
                            key={t.id}
                            id={`vc-bubbscord-tpl-${t.id}`}
                            label={t.name}
                            action={() => insertTextIntoChatInputBox(t.text)}
                        />
                    ))}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-bubbscord-tpl-manage" label="Управлять шаблонами…" action={() => openHub("templates")} />
        </Menu.Menu>
    ));
}

export const TemplatesChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Быстрые ответы (Bubbscord)" onClick={openTemplatesMenu} onContextMenu={() => openHub("templates")}>
            <BoltIcon />
        </ChatBarButton>
    );
};

export const HubChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Избранное и напоминания (Bubbscord)" onClick={() => openHub("favorites")}>
            <StarIcon />
        </ChatBarButton>
    );
};

// =====================================================================
// 4. Перевод
// =====================================================================
export const TRANSLATE_LANGUAGES = [
    { label: "Русский", value: "ru", default: true },
    { label: "Английский", value: "en" },
    { label: "Украинский", value: "uk" },
    { label: "Немецкий", value: "de" },
    { label: "Испанский", value: "es" },
    { label: "Французский", value: "fr" },
    { label: "Польский", value: "pl" },
    { label: "Турецкий", value: "tr" },
    { label: "Японский", value: "ja" },
    { label: "Корейский", value: "ko" },
    { label: "Китайский", value: "zh-CN" }
];

interface Translation { text: string; from: string; }
const translationSetters = new Map<string, Set<(t: Translation | null) => void>>();

async function translateText(text: string, to: string): Promise<Translation> {
    // тот же адрес, что у встроенного плагина Translate (он разрешён в защите Vencord)
    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA",
        "query.sourceLanguage": "auto",
        "query.targetLanguage": to,
        "query.text": text
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return { text: data.translation ?? "", from: data.sourceLanguage ?? "?" };
}

async function translateMessage(m: Message) {
    const text = messageText(m);
    if (!text) return showToast({ text: "В сообщении нет текста для перевода" });
    try {
        const t = await translateText(text, hooks?.translateTo() ?? "ru");
        translationSetters.get(m.id)?.forEach(set => set(t));
    } catch {
        showToast({ text: "Не удалось перевести — проверь интернет", variant: "critical" });
    }
}

export function TranslationAccessory({ message }: { message: Message; }) {
    const [t, setT] = useState<Translation | null>(null);
    useEffect(() => {
        let set = translationSetters.get(message.id);
        if (!set) translationSetters.set(message.id, set = new Set());
        set.add(setT);
        return () => {
            set!.delete(setT);
            if (!set!.size) translationSetters.delete(message.id);
        };
    }, [message.id]);
    if (!t) return null;
    return (
        <div className="vc-bubbscord-translation">
            <TranslateIcon width={14} height={14} />
            <div style={{ minWidth: 0 }}>
                <div>{Parser.parse(t.text)}</div>
                <div className="vc-bubbscord-translation-meta">
                    перевод с «{t.from}» · <button type="button" onClick={() => setT(null)}>скрыть</button>
                </div>
            </div>
        </div>
    );
}

// =====================================================================
// 5. Обои для отдельного чата
// =====================================================================
let wallIndex: string[] = [];
const wallUrls = new Map<string, string>();
let chatWallStyle: HTMLStyleElement | null = null;
let activeChatWall: string | null = null;

export function hasActiveChatWallpaper() {
    return activeChatWall !== null;
}

async function applyChatWallpaper() {
    const id = SelectedChannelStore.getChannelId();
    const has = !!id && wallIndex.includes(id);
    let url: string | null = null;
    if (has) {
        url = wallUrls.get(id!) ?? null;
        if (!url) {
            const blob = await DataStore.get<Blob>(wallKey(id!));
            if (blob) {
                url = URL.createObjectURL(blob);
                wallUrls.set(id!, url);
            }
        }
    }
    const next = url ? id! : null;
    if (next === activeChatWall && chatWallStyle) return;
    activeChatWall = next;
    if (!chatWallStyle) {
        chatWallStyle = document.createElement("style");
        chatWallStyle.id = "vc-bubbscord-chatwall";
        document.head.appendChild(chatWallStyle);
    }
    // отдельный маленький <style>: при смене чата пересчитывается только фон, а не весь интерфейс
    chatWallStyle.textContent = url ? `
        html body::before {
            background:
                linear-gradient(rgb(0 0 0 / var(--dedboost-dim, 0.7)), rgb(0 0 0 / var(--dedboost-dim, 0.7))),
                url("${url}") var(--dedboost-position, center top) / cover no-repeat !important;
        }` : "";
    hooks?.onChatWallpaperChange();
}

async function setChatWallpaper(channelId: string) {
    const file = await chooseFile("image/*");
    if (!file) return;
    await DataStore.set(wallKey(channelId), file);
    const old = wallUrls.get(channelId);
    if (old) URL.revokeObjectURL(old);
    wallUrls.delete(channelId);
    if (!wallIndex.includes(channelId)) wallIndex = [...wallIndex, channelId];
    await DataStore.set(KEY_WALL_INDEX, wallIndex);
    activeChatWall = "__force__";
    await applyChatWallpaper();
    showToast({ text: "Обои для этого чата поставлены 🖼️" });
}

async function removeChatWallpaper(channelId: string) {
    await DataStore.del(wallKey(channelId));
    const old = wallUrls.get(channelId);
    if (old) URL.revokeObjectURL(old);
    wallUrls.delete(channelId);
    wallIndex = wallIndex.filter(x => x !== channelId);
    await DataStore.set(KEY_WALL_INDEX, wallIndex);
    await applyChatWallpaper();
    showToast({ text: "Обои чата убраны" });
}

function chatWallpaperItems(channelId: string) {
    const has = wallIndex.includes(channelId);
    return (
        <Menu.MenuItem id="vc-bubbscord-chatwall" label="Обои этого чата" icon={ImageIcon}>
            <Menu.MenuItem id="vc-bubbscord-chatwall-set" label={has ? "Сменить картинку…" : "Выбрать картинку…"} action={() => setChatWallpaper(channelId)} />
            {has && <Menu.MenuItem id="vc-bubbscord-chatwall-del" label="Убрать" color="danger" action={() => removeChatWallpaper(channelId)} />}
        </Menu.MenuItem>
    );
}

// =====================================================================
// 6. Папки чатов — вкладки над списком ЛС
// =====================================================================
interface Folder { id: string; name: string; channels: string[]; }
const folders = makeStore<Folder>(KEY_FOLDERS);
let activeFolder = "all"; // "all" | "dm" | "groups" | id папки
let tabsEl: HTMLDivElement | null = null;
let folderStyle: HTMLStyleElement | null = null;

function privateChannels() {
    return ChannelStore.getSortedPrivateChannels?.() ?? [];
}

function folderChannelIds(folder: string): string[] | null {
    if (folder === "all") return null;
    if (folder === "dm") return privateChannels().filter(c => c.type === 1).map(c => c.id);
    if (folder === "groups") return privateChannels().filter(c => c.type === 3).map(c => c.id);
    return folders.get().find(f => f.id === folder)?.channels ?? null;
}

function updateFolderCss() {
    if (!folderStyle) {
        folderStyle = document.createElement("style");
        folderStyle.id = "vc-bubbscord-folders";
        document.head.appendChild(folderStyle);
    }
    const ids = hooks?.foldersEnabled() ? folderChannelIds(activeFolder) : null;
    if (!ids) { folderStyle.textContent = ""; return; }
    // прячем строки ЛС, которых нет в папке. Слева — только атрибут data-list-id (дёшево);
    // правило есть, только пока выбрана не «Все».
    const keep = ids.map(id => `a[href="/channels/@me/${id}"]`).join(", ");
    folderStyle.textContent = `
        [data-list-id^="private-channels"] li:has(a[href^="/channels/@me/"])${keep ? `:not(:has(${keep}))` : ""} {
            display: none !important;
        }`;
}

function renderTabs() {
    if (!tabsEl) return;
    const tabs: { id: string; name: string; }[] = [
        { id: "all", name: "Все" },
        { id: "dm", name: "Личные" },
        { id: "groups", name: "Группы" },
        ...folders.get().map(f => ({ id: f.id, name: f.name }))
    ];
    if (!tabs.some(t => t.id === activeFolder)) activeFolder = "all";
    tabsEl.replaceChildren(...tabs.map(t => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "vc-bubbscord-tab" + (t.id === activeFolder ? " vc-bubbscord-tab-active" : "");
        b.textContent = t.name;
        b.onclick = () => { activeFolder = t.id; renderTabs(); updateFolderCss(); };
        if (!["all", "dm", "groups"].includes(t.id))
            b.oncontextmenu = e => { e.preventDefault(); openFolderMenu(e, t.id); };
        return b;
    }), (() => {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "vc-bubbscord-tab vc-bubbscord-tab-add";
        add.title = "Новая папка";
        add.textContent = "+";
        add.onclick = () => openFolderNameModal(null);
        return add;
    })());
}

/** вставляет вкладки над списком ЛС, если список на экране (вызывается редким таймером и при смене канала) */
export function ensureFolderTabs() {
    if (!hooks?.foldersEnabled()) {
        tabsEl?.remove();
        tabsEl = null;
        updateFolderCss();
        return;
    }
    const list = document.querySelector('[data-list-id^="private-channels"]');
    if (!list?.parentElement) return;
    if (tabsEl?.isConnected && tabsEl.nextElementSibling === list) return;
    tabsEl?.remove();
    tabsEl = document.createElement("div");
    tabsEl.className = "vc-bubbscord-tabs";
    list.parentElement.insertBefore(tabsEl, list);
    renderTabs();
}

function openFolderMenu(e: MouseEvent, folderId: string) {
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-bubbscord-folder" onClose={ContextMenuApi.closeContextMenu} aria-label="Папка">
            <Menu.MenuItem id="vc-bubbscord-folder-rename" label="Переименовать…" action={() => openFolderNameModal(folderId)} />
            <Menu.MenuItem
                id="vc-bubbscord-folder-delete"
                label="Удалить папку"
                color="danger"
                action={() => {
                    folders.set(folders.get().filter(f => f.id !== folderId));
                    if (activeFolder === folderId) activeFolder = "all";
                    renderTabs(); updateFolderCss();
                }}
            />
        </Menu.Menu>
    ));
}

function FolderNameModal({ props, folderId, addChannel }: { props: any; folderId: string | null; addChannel?: string; }) {
    const existing = folderId ? folders.get().find(f => f.id === folderId) : null;
    const [name, setName] = useState(existing?.name ?? "");
    const save = () => {
        const n = name.trim();
        if (!n) return;
        if (existing) folders.set(folders.get().map(f => f.id === existing.id ? { ...f, name: n } : f));
        else folders.set([...folders.get(), { id: uid(), name: n, channels: addChannel ? [addChannel] : [] }]);
        renderTabs(); updateFolderCss();
        props.onClose();
    };
    return (
        <Modal
            {...props}
            title={existing ? "Переименовать папку" : "Новая папка"}
            actions={[{ text: existing ? "Сохранить" : "Создать", variant: "primary", onClick: save, disabled: !name.trim() }]}
        >
            <form onSubmit={e => { e.preventDefault(); save(); }}>
                <TextInput value={name} onChange={(v: string) => setName(v)} placeholder="Например: Друзья, Игры, Работа" autoFocus />
            </form>
        </Modal>
    );
}

function openFolderNameModal(folderId: string | null, addChannel?: string) {
    openModal(props => <FolderNameModal props={props} folderId={folderId} addChannel={addChannel} />);
}

function toggleChannelInFolder(folderId: string, channelId: string) {
    folders.set(folders.get().map(f => f.id !== folderId ? f : {
        ...f,
        channels: f.channels.includes(channelId) ? f.channels.filter(c => c !== channelId) : [...f.channels, channelId]
    }));
    updateFolderCss();
}

function folderItems(channelId: string) {
    const list = folders.get();
    return (
        <Menu.MenuItem id="vc-bubbscord-folders" label="Папка" icon={FolderIcon}>
            {list.map(f => (
                <Menu.MenuCheckboxItem
                    key={f.id}
                    id={`vc-bubbscord-folder-${f.id}`}
                    label={f.name}
                    checked={f.channels.includes(channelId)}
                    action={() => toggleChannelInFolder(f.id, channelId)}
                />
            ))}
            {list.length > 0 && <Menu.MenuSeparator />}
            <Menu.MenuItem id="vc-bubbscord-folder-new" label="Новая папка…" action={() => openFolderNameModal(null, channelId)} />
        </Menu.MenuItem>
    );
}

// =====================================================================
// Общее окно: Избранное / Напоминания / Шаблоны
// =====================================================================
type HubTab = "favorites" | "reminders" | "templates";

function FavoritesTab({ close }: { close(): void; }) {
    const list = favorites.use();
    const [q, setQ] = useState("");
    const query = q.trim().toLowerCase();
    const shown = query ? list.filter(f => (f.content + " " + f.author).toLowerCase().includes(query)) : list;
    return (
        <div className="vc-bubbscord-hub-list">
            <TextInput value={q} onChange={(v: string) => setQ(v)} placeholder="Поиск по Избранному" />
            {shown.length === 0 && <div className="vc-bubbscord-empty">{list.length ? "Ничего не нашлось" : "Пока пусто. ПКМ по сообщению → «В Избранное»."}</div>}
            {shown.map(f => (
                <div key={f.id} className="vc-bubbscord-card">
                    <div className="vc-bubbscord-card-head">
                        {f.avatar && <img src={f.avatar} alt="" />}
                        <b>{f.author}</b>
                        <span>{fmtDate(f.ts)}</span>
                    </div>
                    {f.content && <div className="vc-bubbscord-card-text">{Parser.parse(f.content)}</div>}
                    {f.images.length > 0 && (
                        <div className="vc-bubbscord-card-images">
                            {f.images.map(src => <img key={src} src={src} alt="" />)}
                        </div>
                    )}
                    <div className="vc-bubbscord-card-actions">
                        <button type="button" onClick={() => { close(); jumpTo(f.guildId, f.channelId, f.id); }}>Перейти</button>
                        <button type="button" onClick={() => favorites.set(favorites.get().filter(x => x.id !== f.id))}>Убрать</button>
                    </div>
                </div>
            ))}
        </div>
    );
}

function RemindersTab({ close }: { close(): void; }) {
    const list = [...reminders.use()].sort((a, b) => a.due - b.due);
    return (
        <div className="vc-bubbscord-hub-list">
            {list.length === 0 && <div className="vc-bubbscord-empty">Напоминаний нет. ПКМ по сообщению → «Напомнить».</div>}
            {list.map(r => (
                <div key={r.id} className="vc-bubbscord-card">
                    <div className="vc-bubbscord-card-head"><b>⏰ {fmtDate(r.due)}</b><span>{r.author}</span></div>
                    {r.content && <div className="vc-bubbscord-card-text">{Parser.parse(r.content)}</div>}
                    <div className="vc-bubbscord-card-actions">
                        <button type="button" onClick={() => { close(); jumpTo(r.guildId, r.channelId, r.messageId); }}>Перейти</button>
                        <button type="button" onClick={() => { reminders.set(reminders.get().filter(x => x.id !== r.id)); scheduleReminders(); }}>Отменить</button>
                    </div>
                </div>
            ))}
        </div>
    );
}

function TemplatesTab() {
    const list = templates.use();
    const [editing, setEditing] = useState<Template | null>(null);
    const [name, setName] = useState("");
    const [text, setText] = useState("");
    const startEdit = (t: Template | null) => { setEditing(t); setName(t?.name ?? ""); setText(t?.text ?? ""); };
    const save = () => {
        const n = name.trim(), x = text.trim();
        if (!n || !x) return;
        if (editing) templates.set(templates.get().map(t => t.id === editing.id ? { ...t, name: n, text: x } : t));
        else templates.set([...templates.get(), { id: uid(), name: n, text: x }]);
        startEdit(null);
    };
    return (
        <div className="vc-bubbscord-hub-list">
            <div className="vc-bubbscord-card">
                <b>{editing ? "Изменить шаблон" : "Новый шаблон"}</b>
                <TextInput value={name} onChange={(v: string) => setName(v)} placeholder="Название (для команды /шаблон)" />
                <textarea className="vc-bubbscord-textarea" value={text} onChange={e => setText(e.currentTarget.value)} placeholder="Текст ответа" rows={3} />
                <div className="vc-bubbscord-card-actions">
                    <button type="button" onClick={save} disabled={!name.trim() || !text.trim()}>{editing ? "Сохранить" : "Добавить"}</button>
                    {editing && <button type="button" onClick={() => startEdit(null)}>Отмена</button>}
                </div>
            </div>
            {list.map(t => (
                <div key={t.id} className="vc-bubbscord-card">
                    <div className="vc-bubbscord-card-head"><b>{t.name}</b><span>/шаблон {t.name}</span></div>
                    <div className="vc-bubbscord-card-text">{t.text}</div>
                    <div className="vc-bubbscord-card-actions">
                        <button type="button" onClick={() => startEdit(t)}>Изменить</button>
                        <button type="button" onClick={() => templates.set(templates.get().filter(x => x.id !== t.id))}>Удалить</button>
                    </div>
                </div>
            ))}
        </div>
    );
}

function Hub({ props, initial }: { props: any; initial: HubTab; }) {
    const [tab, setTab] = useState<HubTab>(initial);
    const tabs: [HubTab, string][] = [["favorites", "⭐ Избранное"], ["reminders", "⏰ Напоминания"], ["templates", "⚡ Шаблоны"]];
    return (
        <Modal {...props} size="md" title="Bubbscord">
            <div className="vc-bubbscord-hub-tabs">
                {tabs.map(([id, label]) => (
                    <button key={id} type="button" className={"vc-bubbscord-tab" + (tab === id ? " vc-bubbscord-tab-active" : "")} onClick={() => setTab(id)}>{label}</button>
                ))}
            </div>
            {tab === "favorites" && <FavoritesTab close={props.onClose} />}
            {tab === "reminders" && <RemindersTab close={props.onClose} />}
            {tab === "templates" && <TemplatesTab />}
        </Modal>
    );
}

export function openHub(tab: HubTab = "favorites") {
    openModal(props => <Hub props={props} initial={tab} />);
}

// =====================================================================
// Контекстные меню
// =====================================================================
const messageMenu: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message) return;
    const items = (
        <Menu.MenuGroup key="vc-bubbscord-msg">
            <Menu.MenuItem
                id="vc-bubbscord-fav"
                label={isFavorite(message.id) ? "Убрать из Избранного" : "В Избранное"}
                icon={StarIcon}
                action={() => toggleFavorite(message)}
            />
            <Menu.MenuItem id="vc-bubbscord-remind" label="Напомнить" icon={BellIcon}>
                {reminderOptions().map(o => (
                    <Menu.MenuItem key={o.id} id={`vc-bubbscord-remind-${o.id}`} label={o.label} action={() => remindAt(message, o.due)} />
                ))}
            </Menu.MenuItem>
            {messageText(message) && (
                <Menu.MenuItem id="vc-bubbscord-translate" label="Перевести" icon={TranslateIcon} action={() => translateMessage(message)} />
            )}
        </Menu.MenuGroup>
    );
    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) group.push(...(items.props.children as any[]).filter(Boolean));
    else children.splice(1, 0, items);
};

const dmMenu: NavContextMenuPatchCallback = (children, props: any) => {
    const channel = props?.channel;
    if (!channel?.id) return;
    const extra = [chatWallpaperItems(channel.id)];
    // в папки — только личные и групповые ЛС
    if (channel.type === 1 || channel.type === 3) extra.unshift(folderItems(channel.id));
    children.push(<Menu.MenuGroup key="vc-bubbscord-chat">{extra}</Menu.MenuGroup>);
};

const channelMenu: NavContextMenuPatchCallback = (children, props: any) => {
    const channel = props?.channel;
    if (!channel?.id) return;
    children.push(<Menu.MenuGroup key="vc-bubbscord-chat">{chatWallpaperItems(channel.id)}</Menu.MenuGroup>);
};

export const telegramContextMenus = {
    "message": messageMenu,
    "user-context": dmMenu,
    "gdm-context": dmMenu,
    "channel-context": channelMenu
};

// =====================================================================
// Запуск / остановка
// =====================================================================
function onChannelSelect() {
    applyChatWallpaper();
    // список ЛС появляется через пару кадров после перехода на «Главную»
    let tries = 0;
    const attempt = () => {
        ensureFolderTabs();
        if (++tries < 20 && !(tabsEl?.isConnected) && hooks?.foldersEnabled()) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
}

export async function startTelegram(h: Hooks) {
    hooks = h;
    FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
    await Promise.all([favorites.load(), reminders.load(), templates.load(), folders.load()]);
    wallIndex = (await DataStore.get<string[]>(KEY_WALL_INDEX)) ?? [];
    // пропущенные, пока Discord был закрыт, напоминания сработают сразу
    scheduleReminders();
    await applyChatWallpaper();
    ensureFolderTabs();
    updateFolderCss();
}

export function stopTelegram() {
    FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
    if (reminderTimer) clearTimeout(reminderTimer);
    reminderTimer = null;
    tabsEl?.remove(); tabsEl = null;
    folderStyle?.remove(); folderStyle = null;
    chatWallStyle?.remove(); chatWallStyle = null;
    activeChatWall = null;
    wallUrls.forEach(u => URL.revokeObjectURL(u));
    wallUrls.clear();
    translationSetters.clear();
    hooks = null;
}

/** для основного файла: смена настройки «Папки» */
export function refreshFolders() {
    ensureFolderTabs();
    updateFolderCss();
}
