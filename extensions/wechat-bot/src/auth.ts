import type * as finch from 'finch';
import QRCode from 'qrcode';
import {
  ILINK_BASE_URL, DEFAULT_BOT_TYPE, QR_POLL_INTERVAL_MS,
  KEY_TOKEN, KEY_BASE_URL, KEY_BOT_ID, KEY_OWNER_USER,
  KEY_CURSOR, KEY_ACTIVE_SESSION,
  type BotState, type QRCodeResponse, type StatusResponse,
} from './types';
import { IlinkClient } from './ilink-client';
import { sleep } from './utils';

type ToastFn = (title: string, description?: string, variant?: finch.ToastVariant) => void;

/**
 * 认证管理器：扫码登录、退出、typing 指示器。
 */
export class AuthManager {
  private typingState = new Map<string, { ticket: string; timer: ReturnType<typeof setInterval>; runningTurns: number }>();
  private ticketCache = new Map<string, string>();

  constructor(
    private ctx: finch.MiniToolContext,
    private ilink: IlinkClient,
    private state: BotState,
    private toast: ToastFn,
    private onStartMessageLoop: () => void,
  ) {}

  // ── 输入状态 (typing) ──────────────────────────────────────────────────────

  private async fetchTypingTicket(peerId: string, contextToken?: string): Promise<string | undefined> {
    if (this.ticketCache.has(peerId)) return this.ticketCache.get(peerId);
    const baseUrl = await this.ilink.getBaseUrl();
    const token = await this.ilink.getToken();
    if (!baseUrl || !token) return undefined;
    try {
      const resp = await this.ilink.post<{ ret?: number; typing_ticket?: string }>(
        baseUrl, 'ilink/bot/getconfig',
        { ilink_user_id: peerId, context_token: contextToken, base_info: this.ilink.buildBaseInfo() }, token,
      );
      if (resp.typing_ticket) {
        this.ticketCache.set(peerId, resp.typing_ticket);
        return resp.typing_ticket;
      }
    } catch (error) {
      this.ctx.logger.debug('getConfig failed (ignored)', error);
    }
    return undefined;
  }

  private async sendTyping(peerId: string, ticket: string, status: 1 | 2): Promise<void> {
    const baseUrl = await this.ilink.getBaseUrl();
    const token = await this.ilink.getToken();
    if (!baseUrl || !token) return;
    await this.ilink.post(baseUrl, 'ilink/bot/sendtyping',
      { ilink_user_id: peerId, typing_ticket: ticket, status, base_info: this.ilink.buildBaseInfo() }, token,
    ).catch((error) => this.ctx.logger.debug('sendTyping failed (ignored)', error));
  }

  async startTyping(peerId: string, contextToken?: string): Promise<void> {
    const existing = this.typingState.get(peerId);
    if (existing) { existing.runningTurns += 1; return; }
    const ticket = await this.fetchTypingTicket(peerId, contextToken);
    if (!ticket) return;
    await this.sendTyping(peerId, ticket, 1);
    const timer = setInterval(() => { void this.sendTyping(peerId, ticket, 1); }, 5_000);
    this.typingState.set(peerId, { ticket, timer, runningTurns: 1 });
  }

  async stopTyping(peerId: string): Promise<void> {
    const st = this.typingState.get(peerId);
    if (!st) return;
    st.runningTurns -= 1;
    if (st.runningTurns > 0) return;
    clearInterval(st.timer);
    this.typingState.delete(peerId);
    await this.sendTyping(peerId, st.ticket, 2);
  }

  clearTypingTimers(): void {
    for (const st of this.typingState.values()) clearInterval(st.timer);
    this.typingState.clear();
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
          await this.ctx.storage.set(KEY_TOKEN, st.bot_token);
          await this.ctx.storage.set(KEY_BASE_URL, baseUrl);
          await this.ctx.storage.set(KEY_BOT_ID, st.ilink_bot_id);
          if (st.ilink_user_id) await this.ctx.storage.set(KEY_OWNER_USER, st.ilink_user_id);
          await this.ctx.storage.delete(KEY_CURSOR);
          await this.ctx.storage.delete(KEY_ACTIVE_SESSION);
          this.state.activeQr = undefined;
          this.state.loginPhase = 'idle';
          this.state.lastError = undefined;
          this.toast('微信登录成功', '已开始接收消息。', 'success');
          this.state.settingsMenu?.notifyUpdate();
          await this.state.activeLoginDialog?.close('connected');
          this.state.loginCancel = true;
          this.onStartMessageLoop();
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

  async showLoginDialog(): Promise<void> {
    if (await this.ilink.isLoggedIn()) {
      this.toast('微信已登录', '当前正在接收消息。', 'info');
      return;
    }
    try {
      const qr = await this.getLoginQr();
      const pngBase64 = await this.renderQrPng(qr.qrcode_img_content);
      await this.state.activeLoginDialog?.close('replaced');
      const dialog = this.ctx.ui.showModalDialog({
        title: '登录微信',
        description: '请使用手机微信扫码，并在手机上确认登录。',
        message: `![微信登录二维码](data:image/png;base64,${pngBase64})\n\n> 请尽快扫码；实际有效期以微信端为准。`,
        actions: [{ id: 'close', label: '关闭' }],
      });
      this.state.activeLoginDialog = dialog;
      const result = await dialog;
      if (this.state.activeLoginDialog === dialog) this.state.activeLoginDialog = undefined;

      if (['connected', 'verify', 'expired', 'failed', 'replaced', 'logged-out', 'disposed'].includes(result.action)) return;
      if (await this.ilink.isLoggedIn()) return;

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

  async logout(): Promise<void> {
    this.state.loginAttempt += 1;
    this.state.loginCancel = true;
    await this.state.activeLoginDialog?.close('logged-out');
    this.state.activeLoginDialog = undefined;
    this.state.loginRunning = false;
    this.state.loginPhase = 'idle';
    this.state.activeQr = undefined;
    this.state.stopMessageLoop = true;
    this.state.messageRunning = false;
    this.state.lastError = undefined;
    await this.ctx.storage.delete(KEY_TOKEN);
    await this.ctx.storage.delete(KEY_BASE_URL);
    await this.ctx.storage.delete(KEY_BOT_ID);
    await this.ctx.storage.delete(KEY_OWNER_USER);
    await this.ctx.storage.delete(KEY_CURSOR);
    await this.ctx.storage.delete(KEY_ACTIVE_SESSION);
    this.toast('已退出微信', '本地登录状态已清除。', 'info');
    this.state.settingsMenu?.notifyUpdate();
  }
}
