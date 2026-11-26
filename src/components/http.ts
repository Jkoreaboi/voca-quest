export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function request<T>(url: string, body?: unknown): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : data.error?.message || data.message || '요청을 처리하지 못했어요.', response.status);
    return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new Error('연결을 확인해 주세요. 기록은 서버에 보관되며 다시 시도할 수 있어요.'); }
  finally { clearTimeout(timeout); }
}
