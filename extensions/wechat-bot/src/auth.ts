import type * as finch from 'finch';
import QRCode from 'qrcode';
import {
  ILINK_BASE_URL, DEFAULT_BOT_TYPE, QR_POLL_INTERVAL_MS,
  type BotState, type QRCodeResponse, type StatusResponse, type WeChatAccount,
} from './types';
import { IlinkClient, type IlinkAccount } from './ilink-client';
import { ContextStore } from './context';
import { AccountStore, cursorKey, activeSessionKey } from './accounts';
import { randomHex, sleep } from './utils';

type ToastFn = (title: string, description?: string, variant?: finch.ToastVariant) => void;

/** 一个登录轮询产生的 iLink 凭证。 */
interface LoginCredentials {
  botToken: string;
  botId: string;
  baseUrl: string;
  ownerUserId?: string;
}

/**
 * 认证管理器：微信扫码登录、退出、typing 指示器。支持主账号 + 多个子账号，
 * 每个账号独立保存凭证与上下文，登录/退出互不影响。
 */
export class AuthManager {
  private typingState = new Map<string, { ticket: string; timer: ReturnType<typeof setInterval>; runningTurns: number }>();
  private ticketCache = new Map<string, string>();

  constructor(
    private ctx: finch.MiniToolContext,
    private ilink: IlinkClient,
    private contexts: ContextStore,
    private accounts: AccountStore,
    private state: BotState,
    private toast: ToastFn,
    private onAccountReady: (accountId: string) => void,
  ) {}

  // ── 输入状态 (typing) ──────────────────────────────────────────────────────

  private typingKey(accountId: string, peerId: string): string {
    return `${accountId}:${peerId}`;
  }

  private async accountOf(accountId: string): Promise<IlinkAccount | undefined> {
    const account = await this.accounts.get(accountId);
    if (!account) return undefined;
    return { baseUrl: account.baseUrl, botId: account.botId, botToken: account.botToken };
  }

  private async fetchTypingTicket(account: IlinkAccount, cacheKey: string, peerId: string, contextToken?: string): Promise<string | undefined> {
    if (this.ticketCache.has(cacheKey)) return this.ticketCache.get(cacheKey);
    try {
      const resp = await this.ilink.post<{ ret?: number; typing_ticket?: string }>(
        account.baseUrl, 'ilink/bot/getconfig',
        { ilink_user_id: peerId, context_token: contextToken, base_info: this.ilink.buildBaseInfo() }, account.botToken,
      );
      if (resp.typing_ticket) {
        this.ticketCache.set(cacheKey, resp.typing_ticket);
        return resp.typing_ticket;
      }
    } catch (error) {
      this.ctx.logger.debug('getConfig failed (ignored)', error);
    }
    return undefined;
  }

  private async sendTyping(account: IlinkAccount, peerId: string, ticket: string, status: 1 | 2): Promise<void> {
    await this.ilink.post(account.baseUrl, 'ilink/bot/sendtyping',
      { ilink_user_id: peerId, typing_ticket: ticket, status, base_info: this.ilink.buildBaseInfo() }, account.botToken,
    ).catch((error) => this.ctx.logger.debug('sendTyping failed (ignored)', error));
  }

  async startTyping(accountId: string, peerId: string, contextToken?: string): Promise<void> {
    const cacheKey = this.typingKey(accountId, peerId);
    const existing = this.typingState.get(cacheKey);
    if (existing) { existing.runningTurns += 1; return; }
    const account = await this.accountOf(accountId);
    if (!account) return;
    const ticket = await this.fetchTypingTicket(account, cacheKey, peerId, contextToken);
    if (!ticket) return;
    await this.sendTyping(account, peerId, ticket, 1);
    const timer = setInterval(() => { void this.sendTyping(account, peerId, ticket, 1); }, 5_000);
    this.typingState.set(cacheKey, { ticket, timer, runningTurns: 1 });
  }

  async stopTyping(accountId: string, peerId: string): Promise<void> {
    const cacheKey = this.typingKey(accountId, peerId);
    const st = this.typingState.get(cacheKey);
    if (!st) return;
    st.runningTurns -= 1;
    if (st.runningTurns > 0) return;
    clearInterval(st.timer);
    this.typingState.delete(cacheKey);
    const account = await this.accountOf(accountId);
    if (account) await this.sendTyping(account, peerId, st.ticket, 2);
  }

  /** 清空某个账号的 typing 状态（登出/重新登录时调用）。 */
  clearTypingFor(accountId: string): void {
    for (const [key, st] of this.typingState) {
      if (!key.startsWith(`${accountId}:`)) continue;
      clearInterval(st.timer);
      this.typingState.delete(key);
      this.ticketCache.delete(key);
    }
  }

  clearTypingTimers(): void {
    for (const st of this.typingState.values()) clearInterval(st.timer);
    this.typingState.clear();
    this.ticketCache.clear();
  }

  // ── 扫码登录 ────────────────────────────────────────────────────────────────

  private async fetchQrCode(): Promise<QRCodeResponse> {
    return this.ilink.post<QRCodeResponse>(
      ILINK_BASE_URL,
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`,
      { local_token_list: [] },
    );
  }

  private async pollQrStatus(baseUrl: string, qrcode: string): Promise<StatusResponse> {
    try {
      return await this.ilink.get<StatusResponse>(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        undefined, 35_000,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' };
      this.ctx.logger.warn('pollQrStatus network error, retrying', { error: String(error) });
      return { status: 'wait' };
    }
  }

  /** 注册或更新一个账号；返回账号 id。已存在同 botId 的账号时原地更新。 */
  private async registerAccount(credentials: LoginCredentials): Promise<string> {
    const accounts = await this.accounts.list();
    const targetId = this.state.loginTargetAccountId;
    const existing = (targetId ? accounts.find((a) => a.id === targetId) : undefined)
      ?? accounts.find((a) => a.botId === credentials.botId);

    if (existing) {
      // 旧登录的上下文不能复用到新凭证。
      await this.contexts.clearScope({ botId: existing.botId, botToken: existing.botToken });
      this.clearTypingFor(existing.id);
    }

    const id = existing?.id ?? `acc_${randomHex(6)}`;
    const role = existing?.role ?? (accounts.length ? 'sub' : 'primary');
    const account: WeChatAccount = {
      id,
      botId: credentials.botId,
      botToken: credentials.botToken,
      baseUrl: credentials.baseUrl,
      ...(credentials.ownerUserId ? { ownerUserId: credentials.ownerUserId } : {}),
      label: AccountStore.labelFor(credentials.ownerUserId, String(accounts.length + 1)),
      role,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await this.accounts.save(account);
    // 新登录从头拉取：清掉旧游标与当前会话指针。
    await this.ctx.storage.delete(cursorKey(id));
    await this.ctx.storage.delete(activeSessionKey(id));
    await this.accounts.ensurePrimary();
    return id;
  }

  private async runLoginPolling(qr: QRCodeResponse, attempt: number): Promise<void> {
    let currentBase = ILINK_BASE_URL;
    const isCurrent = () => attempt === this.state.loginAttempt && !this.state.loginCancel;

    while (isCurrent()) {
      const st = await this.pollQrStatus(currentBase, qr.qrcode);
      if (!isCurrent()) break;
      switch (st.status) {
        case 'wait': break;
        case 'scaned':
          if (this.state.loginPhase !== 'scanned') this.toast('二维码已扫描', '请在手机微信中确认登录。', 'info');
          this.state.loginPhase = 'scanned';
          this.state.settingsMenu?.notifyUpdate();
          break;
        case 'need_verifycode':
          this.state.loginPhase = 'verify';
          this.state.activeQr = undefined;
          this.toast('需要配对码', '当前弹窗无法输入配对码，请重新获取二维码。', 'warning');
          await this.state.activeLoginDialog?.close('verify');
          this.state.loginCancel = true;
          break;
        case 'scaned_but_redirect':
          if (st.redirect_host) currentBase = `https://${st.redirect_host}`;
          break;
        case 'expired':
          this.state.loginPhase = 'expired';
          this.state.activeQr = undefined;
          this.toast('二维码已过期', '请重新发起微信登录。', 'warning');
          await this.state.activeLoginDialog?.close('expired');
          this.state.loginCancel = true;
          break;
        case 'verify_code_blocked':
          this.state.loginPhase = 'failed';
          this.state.activeQr = undefined;
          this.state.lastError = 'Too many incorrect pairing codes. Try again later.';
          this.toast('登录受限', '配对码错误次数过多，请稍后重试。', 'error');
          await this.state.activeLoginDialog?.close('failed');
          this.state.loginCancel = true;
          break;
        case 'binded_redirect':
          this.state.loginPhase = 'failed';
          this.state.activeQr = undefined;
          this.state.lastError = 'This WeChat account is already connected to another client.';
          this.toast('无法重复连接', '这个微信账号已连接到其他客户端。', 'warning');
          await this.state.activeLoginDialog?.close('failed');
          this.state.loginCancel = true;
          break;
        case 'confirmed': {
          if (!st.bot_token || !st.ilink_bot_id) throw new Error('Login confirmed but credentials missing');
          const baseUrl = (st.baseurl || currentBase).replace(/\/+$/, '');
          const accountId = await this.registerAccount({
            botToken: st.bot_token, botId: st.ilink_bot_id, baseUrl,
            ...(st.ilink_user_id ? { ownerUserId: st.ilink_user_id } : {}),
          });
          this.state.activeQr = undefined;
          this.state.loginPhase = 'idle';
          this.state.lastError = undefined;
          this.toast('微信登录成功', '已开始接收消息。', 'success');
          this.state.settingsMenu?.notifyUpdate();
          await this.state.activeLoginDialog?.close('connected');
          this.state.loginCancel = true;
          this.onAccountReady(accountId);
          break;
        }
      }
      if (isCurrent()) await sleep(QR_POLL_INTERVAL_MS, () => !isCurrent());
    }
  }

  private beginLoginPolling(qr: QRCodeResponse): void {
    const attempt = ++this.state.loginAttempt;
    this.state.loginRunning = true;
    this.state.loginCancel = false;
    this.state.loginPhase = 'waiting';
    this.state.settingsMenu?.notifyUpdate();
    void this.runLoginPolling(qr, attempt)
      .catch((error) => {
        if (attempt !== this.state.loginAttempt) return;
        this.state.loginPhase = 'failed';
        this.state.activeQr = undefined;
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.ctx.logger.error('login polling failed', error);
        this.toast('微信登录失败', '请重试或重新获取二维码。', 'error');
        void this.state.activeLoginDialog?.close('failed');
      })
      .finally(() => {
        if (attempt !== this.state.loginAttempt) return;
        this.state.loginRunning = false;
        this.state.loginTargetAccountId = undefined;
        this.state.settingsMenu?.notifyUpdate();
      });
  }

  private async getLoginQr(): Promise<QRCodeResponse> {
    if (this.state.activeQr && this.state.loginRunning) return this.state.activeQr;
    this.state.activeQr = await this.fetchQrCode();
    this.beginLoginPolling(this.state.activeQr);
    return this.state.activeQr;
  }

  private async renderQrPng(content: string): Promise<string> {
    const png = await QRCode.toBuffer(content, { type: 'png', width: 420, margin: 3, errorCorrectionLevel: 'M' });
    return png.toString('base64');
  }

  /**
   * 打开扫码弹窗。`targetAccountId` 为空表示新增子账号；有值表示重新登录该账号。
   */
  async showLoginDialog(targetAccountId?: string): Promise<void> {
    // 切换登录目标时放弃进行中的轮询，避免把新二维码归到旧账号。
    if (this.state.loginRunning && this.state.loginTargetAccountId !== targetAccountId) {
      this.state.loginAttempt += 1;
      this.state.loginCancel = true;
      this.state.activeQr = undefined;
      this.state.loginRunning = false;
    }
    this.state.loginTargetAccountId = targetAccountId;
    try {
      const qr = await this.getLoginQr();
      const pngBase64 = await this.renderQrPng(qr.qrcode_img_content);
      await this.state.activeLoginDialog?.close('replaced');
      const dialog = this.ctx.ui.showModalDialog({
        title: targetAccountId ? '重新登录微信' : '添加微信子账号',
        description: '请使用手机微信扫码，并在手机上确认登录。',
        message: `![微信登录二维码](data:image/png;base64,${pngBase64})\n\n> 请尽快扫码；实际有效期以微信端为准。`,
        actions: [{ id: 'close', label: '关闭' }],
      });
      this.state.activeLoginDialog = dialog;
      const result = await dialog;
      if (this.state.activeLoginDialog === dialog) this.state.activeLoginDialog = undefined;

      if (['connected', 'verify', 'expired', 'failed', 'replaced', 'logged-out', 'disposed'].includes(result.action)) return;
      if (this.state.loginRunning) return;

      this.state.loginCancel = true;
      this.state.activeQr = undefined;
      this.state.loginPhase = 'failed';
      this.state.lastError = 'The QR dialog was closed before login completed.';
      this.toast('登录未完成', '关闭弹窗前尚未完成微信确认。', 'warning');
    } catch (error) {
      this.state.activeLoginDialog = undefined;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.loginPhase = 'failed';
      this.toast('微信登录失败', '请稍后重试。', 'error');
    }
  }

  /** 登出指定账号：取消其进行中的登录、清账号与上下文、必要时顺延主账号。 */
  async logout(accountId: string): Promise<void> {
    const account = await this.accounts.get(accountId);
    if (this.state.loginTargetAccountId === accountId) {
      this.state.loginAttempt += 1;
      this.state.loginCancel = true;
      await this.state.activeLoginDialog?.close('logged-out');
      this.state.activeLoginDialog = undefined;
      this.state.loginRunning = false;
      this.state.loginPhase = 'idle';
      this.state.activeQr = undefined;
      this.state.loginTargetAccountId = undefined;
    }
    this.clearTypingFor(accountId);
    await this.accounts.remove(accountId);
    if (account) await this.contexts.clearScope({ botId: account.botId, botToken: account.botToken });
    await this.accounts.ensurePrimary();
    this.state.lastError = undefined;
    this.state.settingsMenu?.notifyUpdate();
  }
}
