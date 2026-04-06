// Bridge between Tauri backend and web app
declare global {
  interface Window {
    __TAURI__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI__ !== undefined;
}

export async function showNativeNotification(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  await window.__TAURI__!.invoke("show_notification", { title, body });
}
