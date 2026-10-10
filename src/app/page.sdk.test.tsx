// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// La página con el cliente de Supabase real (detectSessionInUrl incluido): solo
// se simulan la red, next/image y la navegación.
vi.mock('@/lib/navigation', () => ({ leavePage: vi.fn(), reloadPage: vi.fn() }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

const SUPABASE_URL = 'https://proyecto.supabase.co';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
// Un JWT con forma válida: el SDK lo decodifica antes de llamar a /user.
const AT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: now + 3600, role: 'authenticated' })}.c2lnLVNFQ1JFVA`;
const RT = 'rt-SECRET';

type UserReply = 'ok' | 'network-error';

let userReplies: UserReply[];
let fetchMock: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
let stopAutoRefresh: (() => Promise<void>) | null = null;

function userCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/v1/user')).length;
}

// Todo lo que llegó a la consola, Errors incluidos (JSON.stringify los deja en {}).
function consoleText() {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) =>
      arg instanceof Error
        ? [arg.name, arg.message, arg.stack, String((arg as { cause?: unknown }).cause)].join('\n')
        : typeof arg === 'string'
          ? arg
          : JSON.stringify(arg)
    )
    .join('\n');
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}

async function freshPage() {
  vi.resetModules();
  const mod = await import('./page');
  const view = render(
    <StrictMode>
      <mod.default />
    </StrictMode>
  );
  // El mismo módulo que usa la página (mismo registro tras resetModules).
  const { getSupabase } = await import('@/lib/supabase');
  stopAutoRefresh = () => getSupabase().auth.stopAutoRefresh();
  return view;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('BroadcastChannel', undefined);
  // El localStorage experimental de Node tapa el de jsdom: uno en memoria por test.
  vi.stubGlobal('localStorage', memoryStorage());
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/auth/v1/user')) throw new Error(`petición inesperada: ${url}`);
    const reply = userReplies.shift();
    if (reply === 'network-error') {
      // Lo que se registra de un fetch rechazado puede llevar la petición entera.
      throw new TypeError(`fetch failed: GET ${url} Authorization: Bearer ${AT}`);
    }
    return new Response(JSON.stringify({ id: 'u1', aud: 'authenticated', email: 'ana@example.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});

afterEach(async () => {
  await stopAutoRefresh?.();
  stopAutoRefresh = null;
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthPage con el SDK real', () => {
  it.each(['invite', 'recovery'] as const)(
    '%s: primer /user OK, segundo falla → el reintento sigue teniendo un camino válido',
    async (flow) => {
      const { reloadPage } = await import('@/lib/navigation');
      userReplies = ['ok', 'network-error', 'ok'];
      window.history.replaceState(
        null,
        '',
        `/#access_token=${AT}&expires_at=${now + 3600}&expires_in=3600&refresh_token=${RT}&token_type=bearer&type=${flow}`
      );
      const { container } = await freshPage();

      // detectSessionInUrl validó el hash (1.º /user) y lo borró; setSession (2.º) falló.
      expect((await screen.findByRole('alert')).textContent).toContain('Vuelve a intentarlo');
      expect(userCalls()).toBe(2);
      expect(window.location.hash).toBe('');
      expect(screen.queryByLabelText('Contraseña')).toBeNull();
      expect(container.querySelector('.skeleton-line')).toBeNull();

      // El SDK registró el fallo de red, pero sin el token.
      expect(vi.mocked(console.error)).toHaveBeenCalled();
      expect(consoleText()).not.toContain(AT);
      expect(consoleText()).not.toContain(RT);
      expect(document.body.innerHTML).not.toContain(AT);

      // Recargar ya no serviría (la URL no lleva el enlace): el reintento usa la memoria.
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
      expect(await screen.findByLabelText('Contraseña')).toBeTruthy();
      expect(userCalls()).toBe(3);
      expect(reloadPage).not.toHaveBeenCalled();
      await waitFor(() => expect(consoleText()).not.toContain(AT));
    }
  );
});
