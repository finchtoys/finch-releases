import type * as finch from 'finch';
import type { AppRequest, HostMessage } from '../shared/types';

declare global {
  interface Window { finch?: finch.WebviewBridgeApi }
}

export function post(message: AppRequest): void {
  window.finch?.postMessage(message);
}

export function listen(listener: (message: HostMessage) => void): () => void {
  return window.finch?.onMessage((message) => {
    const value = message as Partial<HostMessage>;
    if (typeof value.type === 'string' && value.type.startsWith('agent-team:')) listener(value as HostMessage);
  }) ?? (() => undefined);
}

export async function openSession(sessionId: string): Promise<void> {
  if (!window.finch) return;
  await window.finch.navigation.openSession(sessionId);
}

export async function confirmAction(title: string, message: string): Promise<boolean> {
  if (!window.finch) return globalThis.confirm(`${title}\n\n${message}`);
  return (await window.finch.ui.confirm({ title, message, variant: 'danger' })).confirmed;
}

export async function toast(title: string, variant: 'success' | 'error' | 'warning' | 'info' = 'success'): Promise<void> {
  await window.finch?.ui.toast({ title, variant });
}
