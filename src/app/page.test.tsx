// @vitest-environment jsdom
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// La página real con sus dependencias externas simuladas: Supabase, la red y
// la salida a Stripe. Comprueba que solo el clic dispara la activación.
const auth = {
  verifyOtp: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
};
const passwordAuth = { setSession: vi.fn(), updateUser: vi.fn() };

vi.mock('@/lib/supabase', () => ({
  createEphemeralSupabase: vi.fn(() => ({ auth })),
  getSupabase: () => ({ auth: passwordAuth }),
}));
vi.mock('@/lib/navigation', () => ({ leavePage: vi.fn(), reloadPage: vi.fn() }));
// next/image necesita el runtime de Next; aquí basta con un <img>.
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import { leavePage, reloadPage } from '@/lib/navigation';
import { createEphemeralSupabase } from '@/lib/supabase';

const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3';
const AT = 'eyJhbGciOiJFUzI1NiJ9.payload.sig-SECRET';
const SESSION = { access_token: AT, refresh_token: 'refresh-SECRET', user: { id: 'u1' } };

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

function visit(path: string) {
  window.history.replaceState(null, '', path);
}

// El runner de la página es de módulo (una ejecución por carga): cada test
// necesita una "carga" nueva.
async function freshPage() {
  vi.resetModules();
  const mod = await import('./page');
  return render(
    <StrictMode>
      <mod.default />
    </StrictMode>
  );
}

beforeEach(() => {
  auth.verifyOtp.mockReset().mockResolvedValue({ data: { session: SESSION }, error: null });
  auth.setSession.mockReset().mockResolvedValue({ data: { session: SESSION }, error: null });
  auth.signOut.mockClear();
  passwordAuth.setSession.mockReset().mockResolvedValue({ data: { session: SESSION }, error: null });
  passwordAuth.updateUser.mockReset().mockResolvedValue({ data: { user: {} }, error: null });
  vi.mocked(createEphemeralSupabase).mockClear();
  vi.mocked(leavePage).mockClear();
  vi.mocked(reloadPage).mockClear();
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ url: CHECKOUT }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthPage — activación', () => {
  it.each(['month', 'year'] as const)(
    '%s: montar (Strict Mode) solo muestra la confirmación; el clic abre un único Checkout',
    async (interval) => {
      visit(`/?next=activate&interval=${interval}&token_hash=th_1&type=magiclink`);
      await freshPage();

      const button = await screen.findByRole('button', { name: 'Continuar al pago' });
      expect(screen.getByText(interval === 'month' ? 'Plan mensual' : 'Plan anual')).toBeTruthy();
      // La URL ya no lleva el token, pero el clic aún puede usarlo.
      expect(window.location.search).toBe('');
      expect(window.location.hash).toBe('');
      // Nada consumido al cargar.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(auth.verifyOtp).not.toHaveBeenCalled();
      expect(auth.setSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(leavePage).not.toHaveBeenCalled();

      // Doble clic seguido.
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(leavePage).toHaveBeenCalledWith(CHECKOUT));
      expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
      expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th_1', type: 'magiclink' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.trazea.es/v1/billing/activation-checkout');
      expect(JSON.parse(init.body as string)).toEqual({ interval });
      expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(leavePage).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Abriendo la página de pago segura…')).toBeTruthy();
    }
  );

  it('mientras carga el botón queda deshabilitado y anuncia el estado', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (release = r)));
    visit('/?next=activate&interval=month&token_hash=th_1&type=magiclink');
    await freshPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar al pago' }));
    const busy = await screen.findByRole('button', { name: /Abriendo el pago/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Abriendo la página de pago');
    await act(async () => {
      release(new Response(JSON.stringify({ url: CHECKOUT }), { status: 200 }));
    });
    await waitFor(() => expect(leavePage).toHaveBeenCalledTimes(1));
  });

  it('enlace antiguo con la sesión en el hash: también espera al clic', async () => {
    visit(`/?next=activate&interval=year#access_token=${AT}&refresh_token=r&type=magiclink`);
    await freshPage();
    const button = await screen.findByRole('button', { name: 'Continuar al pago' });
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(leavePage).toHaveBeenCalledTimes(1));
    expect(auth.setSession).toHaveBeenCalledTimes(1);
  });

  it('token caducado al pulsar: alerta y vuelta a Activar, sin POST', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { status: 403, code: 'otp_expired' },
    });
    visit('/?next=activate&interval=month&token_hash=th_1&type=magiclink');
    await freshPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar al pago' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vuelve a pedirlo desde la pantalla Activar');
    expect(screen.getByRole('link', { name: 'Volver a Activar en la app' }).getAttribute('href')).toBe(
      'trazea://activate'
    );
    expect(screen.getByText(/Si el botón no abre la app/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(leavePage).not.toHaveBeenCalled();
  });

  it('API 503: alerta, diagnóstico sin datos sensibles y sin navegar', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'BillingProviderUnavailable', detail: 'x' }), {
        status: 503,
      })
    );
    visit('/?next=activate&interval=month&token_hash=th_1&type=magiclink');
    await freshPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar al pago' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no se ha hecho ningún cobro');
    expect(screen.getByRole('heading', { name: 'No se ha podido abrir el pago' })).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[trazea-auth] activation-checkout', {
      category: 'http',
      status: 503,
      error_code: 'BillingProviderUnavailable',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('th_1');
    expect(leavePage).not.toHaveBeenCalled();
  });

  it('fetch rechazado (posible CORS): diagnóstico network sin status', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    visit('/?next=activate&interval=year&token_hash=th_1&type=magiclink');
    await freshPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar al pago' }));
    await screen.findByRole('alert');
    expect(warn).toHaveBeenCalledWith('[trazea-auth] activation-checkout', { category: 'network' });
  });

  it('hash otp_expired con next=activate: error de activación con acción para pedir otro', async () => {
    visit(
      '/?next=activate&interval=month#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    );
    await freshPage();
    expect((await screen.findByRole('alert')).textContent).toContain('pantalla Activar');
    expect(screen.getByRole('link', { name: 'Volver a Activar en la app' })).toBeTruthy();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fallo inesperado al pulsar: alerta sin cobro y el botón no se queda cargando', async () => {
    vi.mocked(createEphemeralSupabase).mockImplementation(() => {
      throw new Error(`supabaseUrl is required. ${AT}`);
    });
    visit('/?next=activate&interval=month&token_hash=th_1&type=magiclink');
    const { container } = await freshPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar al pago' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no se ha hecho ningún cobro');
    expect(container.querySelector('.spinner')).toBeNull();
    expect(screen.queryByRole('button', { name: /Abriendo el pago/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain('SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(leavePage).not.toHaveBeenCalled();
  });

  it('magiclink sin next=activate: enlace inválido, sin acción de activar', async () => {
    visit('/?token_hash=th_1&type=magiclink');
    await freshPage();
    expect(await screen.findByRole('heading', { name: 'Enlace inválido' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar al pago' })).toBeNull();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('AuthPage — regresiones', () => {
  it.each(['invite', 'recovery'] as const)('%s: formulario de contraseña', async (flow) => {
    visit(`/#access_token=${AT}&refresh_token=r&type=${flow}`);
    await freshPage();
    expect(await screen.findByLabelText('Contraseña')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signup con token_hash: confirma al cargar (su flujo no cambia)', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: { ...SESSION, user: { id: 'u1', email_confirmed_at: '2026-09-25' } } },
      error: null,
    });
    visit('/?token_hash=th_s&type=signup');
    await freshPage();
    expect(await screen.findByText('Email confirmado, vuelve a la app')).toBeTruthy();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th_s', type: 'signup' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updateUser lanza: error en el formulario y el botón vuelve a estar disponible', async () => {
    passwordAuth.updateUser.mockRejectedValue(new Error('Lock timeout'));
    visit(`/#access_token=${AT}&refresh_token=r&type=recovery`);
    await freshPage();
    fireEvent.change(await screen.findByLabelText('Contraseña'), { target: { value: 'Abcdefgh1' } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'Abcdefgh1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(await screen.findByText('Error al guardar la contraseña. Inténtalo de nuevo.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Guardar contraseña' }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.queryByText('¡Contraseña guardada!')).toBeNull();
  });
});

describe('AuthPage — fallos al comprobar el enlace', () => {
  // Nada sensible en pantalla ni en consola, y nada de skeleton ni formulario.
  function expectSafeErrorView(container: HTMLElement, consoleSpies: ReturnType<typeof vi.spyOn>[]) {
    expect(container.querySelector('.skeleton-line')).toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();
    expect(screen.queryByLabelText('Contraseña')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar contraseña' })).toBeNull();
    expect(document.body.innerHTML).not.toContain('SECRET');
    expect(JSON.stringify(consoleSpies.map((s) => s.mock.calls))).not.toContain('SECRET');
  }

  function spyConsole() {
    return (['log', 'info', 'error', 'debug'] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
      .concat(warn);
  }

  it.each([
    ['invite', 'contacta con el administrador'],
    ['recovery', 'pantalla de acceso de la app'],
  ] as const)('%s: setSession lanza → error útil con reintento y vuelta a la app', async (flow, hint) => {
    const spies = spyConsole();
    passwordAuth.setSession.mockRejectedValue(new Error(`fetch failed: ${AT}`));
    visit(`/#access_token=${AT}&refresh_token=refresh-SECRET&type=${flow}`);
    const { container } = await freshPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vuelve a intentarlo');
    expect(alert.textContent).toContain(hint);
    expect(screen.getByRole('heading', { name: 'No hemos podido comprobar el enlace' })).toBeTruthy();
    expect(screen.queryByText(/ha expirado/)).toBeNull();
    expectSafeErrorView(container, spies);

    expect(screen.getByRole('link', { name: 'Abrir Trazea' }).getAttribute('href')).toBe('trazea://');

    // Reintentar vuelve a comprobar con los tokens en memoria, sin recargar.
    passwordAuth.setSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Contraseña')).toBeTruthy();
    expect(passwordAuth.setSession).toHaveBeenCalledTimes(2);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('error de red devuelto por Supabase: reintento, no "enlace caducado"', async () => {
    const spies = spyConsole();
    passwordAuth.setSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });
    visit(`/#access_token=${AT}&refresh_token=r&type=invite`);
    const { container } = await freshPage();
    expect((await screen.findByRole('alert')).textContent).toContain('Vuelve a intentarlo');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    expectSafeErrorView(container, spies);
  });

  it('setSession sin error ni sesión: enlace caducado, nunca el formulario', async () => {
    const spies = spyConsole();
    passwordAuth.setSession.mockResolvedValue({ data: { session: null, user: null }, error: null });
    visit(`/#access_token=${AT}&refresh_token=r&type=recovery`);
    const { container } = await freshPage();
    expect(await screen.findByText(/ha expirado/)).toBeTruthy();
    expectSafeErrorView(container, spies);
  });

  it('última barrera: si runBridge rechaza, sale del estado de carga con un error genérico', async () => {
    const spies = spyConsole();
    visit(`/?token_hash=th_1&type=magiclink#access_token=${AT}`);
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error(`SecurityError ${AT}`);
    });
    const { container } = await freshPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('pide un enlace nuevo');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir Trazea' })).toBeTruthy();
    expectSafeErrorView(container, spies);
    // Sin reintento propio: no se sabe qué enlace era, así que recarga.
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});
