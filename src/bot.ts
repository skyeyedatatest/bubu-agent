import fs from "fs";
import { agentLoop } from "./agent.js";
import type { Skill } from "./skills.js";

const BASE_URL = "https://ilinkai.weixin.qq.com";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ========== 自动重连配置（可调参数） ==========
const RECONNECT_CONFIG = {
    session_duration: 24 * 3600,
    warning_before: 2 * 3600,
    reminder_interval: 30 * 60,
    force_before: 30 * 60,
    qrcode_scan_timeout: 600,
};
// =============================================

// ========== 配置文件 ==========
const DEFAULT_PROMPT = "你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量少一些";

function loadEnvConfig() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        console.error("错误：未找到 DEEPSEEK_API_KEY，请检查 .env 文件");
        process.exit(1);
    }
    return {
        api_key: apiKey,
        base_url: process.env.BASE_URL ?? "https://api.deepseek.com",
        model: process.env.MODEL ?? "deepseek-chat",
        prompt: process.env.PROMPT ?? DEFAULT_PROMPT,
    };
}
// ==============================

const COMMANDS_MSG = [
    "连接成功！",
    "可用指令：",
    "/help  /指令   - 查看全部指令列表",
    "/time          - 查询当前连接剩余时间",
    "/重新连接       - 立即触发重新连接（需确认）",
    "",
    "非指令输入即为 AI 对话"
].join("\n");

// 共享状态（模块级）
let botToken: string;
let botBaseUrl = BASE_URL;
let getUpdatesBuf = "";
const typingTicketCache: Record<string, string> = {};
let lastContact: { fromId: string | null; contextToken: string | null } = { fromId: null, contextToken: null };
const welcomedUsers = new Set<string>();
const manualReconnectPending = new Set<string>();
let warningActive = false;
let reconnectInProgress = false;
let reconnectResolve: (() => void) | null = null;
let loginTime: number;

// ========== Per-user agent state ==========
const agentRunning = new Set<string>();
// pendingConfirm: fromId → resolver called when user replies Y/N
const pendingConfirm = new Map<string, (result: boolean) => void>();
// ==========================================

function makeHeaders(token?: string) {
    const uin = BigInt(Math.floor(Math.random() * 0xFFFFFFFF)).toString();
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(uin).toString("base64"),
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };
}

async function apiPost(path: string, body: unknown, token?: string, baseUrl?: string) {
    const url = `${baseUrl ?? botBaseUrl}/${path}`;
    const res = await fetch(url, {
        method: "POST",
        headers: makeHeaders(token ?? botToken),
        body: JSON.stringify(body)
    });
    return res.json();
}

async function sendMsgSafe(toId: string | null, contextToken: string | null, text: string) {
    if (!toId || !contextToken) {
        console.log(`[重连通知] ${text}`);
        return;
    }
    try {
        const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0")}`;
        await apiPost("ilink/bot/sendmessage", {
            msg: {
                from_user_id: "",
                to_user_id: toId,
                client_id: clientId,
                message_type: 2,
                message_state: 2,
                context_token: contextToken,
                item_list: [{ type: 1, text_item: { text } }]
            },
            base_info: { channel_version: "1.0.2" }
        });
    } catch (e: any) {
        console.log(`[重连通知] 发送失败(${e?.message})，降级打印: ${text}`);
    }
}

async function doReconnect() {
    if (reconnectInProgress) return;
    reconnectInProgress = true;
    warningActive = false;
    reconnectResolve = null;

    console.log("[重连] 开始重连流程...");
    const { fromId, contextToken } = lastContact;

    let qrcode: string, qrcodeUrl: string;
    try {
        const data: any = await fetch(`${botBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`).then(r => r.json());
        qrcode = data.qrcode;
        qrcodeUrl = data.qrcode_img_content ?? qrcode;
    } catch (e: any) {
        console.log(`[重连] 获取二维码失败: ${e?.message}`);
        reconnectInProgress = false;
        loginTime = Date.now();
        return;
    }

    const qrMsg = `[重连] 请扫码完成新连接：${qrcodeUrl}`;
    console.log(qrMsg);
    await sendMsgSafe(fromId, contextToken, qrMsg);

    const deadline = Date.now() + RECONNECT_CONFIG.qrcode_scan_timeout * 1000;
    let newToken: string | null = null, newBaseUrl: string | null = null;
    while (Date.now() < deadline) {
        try {
            const status: any = await fetch(
                `${botBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
            ).then(r => r.json());
            if (status.status === "confirmed") {
                newToken = status.bot_token;
                newBaseUrl = status.baseurl ?? botBaseUrl;
                break;
            }
        } catch { }
        await sleep(1000);
    }

    if (!newToken) {
        console.log("[重连] 扫码超时，重连未完成");
        await sendMsgSafe(fromId, contextToken, "[失败] 扫码超时，重连未完成，下次到期前会再次提醒");
        loginTime = Date.now();
        reconnectInProgress = false;
        return;
    }

    botToken = newToken;
    botBaseUrl = newBaseUrl!;
    Object.keys(typingTicketCache).forEach(k => delete typingTicketCache[k]);
    console.log("[重连] 新连接已建立，token 已切换");
    await sendMsgSafe(fromId, contextToken, "[完成] 新连接已建立，已自动切换，继续使用");

    reconnectInProgress = false;
    loginTime = Date.now();
}

async function reconnectTimerLoop() {
    while (true) {
        const elapsed = (Date.now() - loginTime) / 1000;
        const firstWait = Math.max(0, RECONNECT_CONFIG.session_duration - RECONNECT_CONFIG.warning_before - elapsed);
        await sleep(firstWait * 1000);

        let remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
        if (remaining <= RECONNECT_CONFIG.force_before) {
            const msg = "[自动] 连接即将到期，开始强制重新连接...";
            console.log(msg);
            await sendMsgSafe(lastContact.fromId, lastContact.contextToken, msg);
            await doReconnect();
            continue;
        }

        const remainingH = (remaining / 3600).toFixed(1);
        const warnMsg = `[提醒] 连接还剩约 ${remainingH} 小时到期，是否现在重新连接？回复 Y 立即重连，N 稍后提醒`;
        console.log(warnMsg);
        await sendMsgSafe(lastContact.fromId, lastContact.contextToken, warnMsg);
        warningActive = true;

        while (true) {
            remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
            if (remaining <= RECONNECT_CONFIG.force_before) {
                const forceMsg = "[自动] 连接即将到期，开始强制重新连接...";
                console.log(forceMsg);
                await sendMsgSafe(lastContact.fromId, lastContact.contextToken, forceMsg);
                await doReconnect();
                break;
            }

            const waitSecs = Math.max(0, Math.min(RECONNECT_CONFIG.reminder_interval,
                remaining - RECONNECT_CONFIG.force_before));

            let userReplied = false;
            await Promise.race([
                new Promise<void>(r => { reconnectResolve = () => { userReplied = true; r(); }; }),
                sleep(waitSecs * 1000)
            ]);

            if (userReplied) {
                await doReconnect();
                break;
            }

            remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
            if (remaining <= RECONNECT_CONFIG.force_before) continue;

            const remainingM = Math.round(remaining / 60);
            const remindMsg = `[提醒] 连接还剩约 ${remainingM} 分钟，是否现在重新连接？回复 Y 立即重连，N 继续等待`;
            console.log(remindMsg);
            await sendMsgSafe(lastContact.fromId, lastContact.contextToken, remindMsg);
        }
    }
}

async function messageLoop() {
    console.log("开始监听消息...");
    while (true) {
        const result: any = await apiPost(
            "ilink/bot/getupdates",
            { get_updates_buf: getUpdatesBuf, base_info: { channel_version: "1.0.2" } }
        );
        getUpdatesBuf = result.get_updates_buf ?? getUpdatesBuf;

        for (const msg of result.msgs ?? []) {
            if (msg.message_type !== 1) continue;
            const text: string = msg.item_list?.[0]?.text_item?.text;
            const fromId: string = msg.from_user_id;
            const contextToken: string = msg.context_token;
            console.log(`收到消息: ${text}`);

            lastContact = { fromId, contextToken };

            // 优先级 1：手动重连 Y/N 确认
            if (manualReconnectPending.has(fromId) && ["Y", "N"].includes(text?.trim()?.toUpperCase())) {
                manualReconnectPending.delete(fromId);
                if (text.trim().toUpperCase() === "Y") {
                    await sendMsgSafe(fromId, contextToken, "好的，正在重新连接...");
                    await doReconnect();
                } else {
                    await sendMsgSafe(fromId, contextToken, "已取消重新连接");
                }
                continue;
            }

            // 优先级 2：定时预警 Y/N 处理
            if (warningActive && ["Y", "N"].includes(text?.trim()?.toUpperCase())) {
                if (text.trim().toUpperCase() === "Y") {
                    reconnectResolve?.();
                    await sendMsgSafe(fromId, contextToken, "好的，正在重新连接...");
                } else {
                    await sendMsgSafe(fromId, contextToken, "好的，稍后再提醒您");
                }
                continue;
            }

            // 优先级 3：Agent 敏感操作确认 Y/N
            if (pendingConfirm.has(fromId) && ["Y", "N"].includes(text?.trim()?.toUpperCase())) {
                const resolve = pendingConfirm.get(fromId)!;
                pendingConfirm.delete(fromId);
                const confirmed = text.trim().toUpperCase() === "Y";
                await sendMsgSafe(fromId, contextToken, confirmed ? "已确认，继续执行..." : "已取消操作");
                resolve(confirmed);
                continue;
            }

            // 优先级 4：首次交互，发送指令列表
            if (!welcomedUsers.has(fromId)) {
                welcomedUsers.add(fromId);
                await sendMsgSafe(fromId, contextToken, COMMANDS_MSG);
                continue;
            }

            // /help  /指令
            if (["/help", "/指令"].includes(text?.trim())) {
                await sendMsgSafe(fromId, contextToken, COMMANDS_MSG);
                continue;
            }

            // /time 指令
            if (text?.trim() === "/time") {
                const rem = Math.max(0, (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000);
                const h = Math.floor(rem / 3600);
                const m = Math.floor((rem % 3600) / 60);
                const s = Math.floor(rem % 60);
                const ts = h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟 ${s} 秒`;
                await sendMsgSafe(fromId, contextToken, `当前连接剩余时间：${ts}`);
                continue;
            }

            // /重新连接
            if (text?.trim() === "/重新连接") {
                if (reconnectInProgress) {
                    await sendMsgSafe(fromId, contextToken, "重连正在进行中，请稍候...");
                } else {
                    manualReconnectPending.add(fromId);
                    await sendMsgSafe(fromId, contextToken, "确认要立即重新连接吗？\n回复 Y 确认重连 / N 取消");
                }
                continue;
            }

            // 若 agent 正在处理该用户的上一条消息
            if (agentRunning.has(fromId)) {
                await sendMsgSafe(fromId, contextToken, "上一条消息还在处理中，请稍候...");
                continue;
            }

            // getconfig 获取 typing_ticket
            if (!typingTicketCache[fromId]) {
                const cfg: any = await apiPost("ilink/bot/getconfig", {
                    ilink_user_id: fromId,
                    context_token: contextToken,
                    base_info: { channel_version: "1.0.2" }
                });
                typingTicketCache[fromId] = cfg.typing_ticket ?? "";
            }
            const typingTicket = typingTicketCache[fromId];

            if (typingTicket) {
                await apiPost("ilink/bot/sendtyping", {
                    ilink_user_id: fromId,
                    typing_ticket: typingTicket,
                    status: 1
                });
            }

            // WeChat 确认函数：向用户发消息并等待 Y/N 回复（60s 超时自动拒绝）
            const confirmFn = async (cmd: string): Promise<boolean> => {
                await sendMsgSafe(fromId, contextToken,
                    `⚠️ Agent 请求执行敏感操作：\n${cmd}\n\n回复 Y 确认 / N 取消（60秒超时自动取消）`);
                return new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => {
                        pendingConfirm.delete(fromId);
                        resolve(false);
                    }, 60_000);
                    pendingConfirm.set(fromId, (result: boolean) => {
                        clearTimeout(timer);
                        resolve(result);
                    });
                });
            };

            // 注入微信发消息工具（仅对本次调用可见，不污染全局 skills）
            const wechatSkill: Skill = {
                name: "send_wechat_message",
                description: "向当前微信用户发送一条消息，适合在任务执行中途汇报进度、请求补充信息或发送通知",
                input_schema: {
                    type: "object",
                    properties: {
                        text: { type: "string", description: "要发送的消息内容" }
                    },
                    required: ["text"]
                },
                handler: async (args: { text: string }) => {
                    await sendMsgSafe(fromId, contextToken, args.text);
                    return "消息已发送";
                }
            };

            // 启动 Agent（不 await，避免阻塞消息循环）
            agentRunning.add(fromId);
            agentLoop(text, {
                interactive: false,
                confirmFn,
                onReply: (reply) => { sendMsgSafe(fromId, contextToken, reply); },
                extraSkills: [wechatSkill],
            }).catch((e: any) => {
                sendMsgSafe(fromId, contextToken, `[Agent 出错] ${e?.message ?? String(e)}`);
            }).finally(async () => {
                agentRunning.delete(fromId);
                if (typingTicket) {
                    await apiPost("ilink/bot/sendtyping", {
                        ilink_user_id: fromId,
                        typing_ticket: typingTicket,
                        status: 2
                    });
                }
            });
        }
    }
}

// ── 启动流程 ──

console.log(`
╔══════════════════════════════════════════════════════════╗
║          微信 ClawBot  ·  WeChat iLink Bot               ║
║  Copyright (c) 2026 SiverKing. All rights reserved.     ║
║  GitHub : https://github.com/SiverKing/weixin-ClawBot-API║
╚══════════════════════════════════════════════════════════╝`);

// 0. 加载配置
const botConfig = loadEnvConfig();
console.log(`  API Key  : ${botConfig.api_key.slice(0, 5)}${"*".repeat(Math.max(0, botConfig.api_key.length - 10))}${botConfig.api_key.slice(-5)}`);
console.log(`  API 地址 : ${botConfig.base_url}`);
console.log(`  模型     : ${botConfig.model}`);

// 1. 获取二维码
const { qrcode, qrcode_img_content }: any = await fetch(
    `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
).then(r => r.json());

if (qrcode_img_content) {
    const content = String(qrcode_img_content);
    if (content.startsWith("data:image/")) {
        const [header, b64] = content.split(",");
        const ext = header!.match(/data:image\/(\w+)/)?.[1] ?? "png";
        fs.writeFileSync(`qrcode.${ext}`, Buffer.from(b64!, "base64"));
        console.log(`二维码已保存到 qrcode.${ext}`);
    } else if (content.startsWith("http")) {
        console.log("二维码图片地址:", content);
        console.log("请将图片地址发送给文件传输助手，然后用手机端微信打开链接进行连接！！！");
    } else if (content.startsWith("<svg")) {
        fs.writeFileSync("qrcode.svg", content);
        console.log("二维码已保存到 qrcode.svg，用浏览器打开");
    } else {
        fs.writeFileSync("qrcode.png", Buffer.from(content, "base64"));
        console.log("二维码已保存到 qrcode.png");
    }
}

// 2. 等待扫码
console.log("等待扫码...");
while (true) {
    const status: any = await fetch(
        `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
    ).then(r => r.json());

    if (status.status === "confirmed") {
        botToken = status.bot_token;
        botBaseUrl = status.baseurl ?? BASE_URL;
        console.log("登录成功！");
        console.log("=".repeat(40));
        console.log(COMMANDS_MSG);
        console.log("=".repeat(40));
        break;
    }
    await sleep(1000);
}

// 3. 记录登录时间，并发启动消息循环和定时器循环
loginTime = Date.now();
await Promise.all([messageLoop(), reconnectTimerLoop()]);
