import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_CHECKOUT_URL,
  confirmSignup,
  createBridgeRunner,
  parseLanding,
  startActivation,
  stripeCheckoutUrl,
  type BridgeAuth,
  type BridgeEnv,
  type Credentials,
} from './authBridge';

const BASE = 'https://auth.trazea.es/';
const AT = 'eyJhbGciOiJFUzI1NiJ9.payload.sig-SECRET';
const RT = 'refresh-SECRET';
const HASH_SESSION = `access_token=${AT}&expires_in=3600&refresh_token=${RT}&token_type=bearer`;
const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0';

const hashCreds: Credentials = { kind: 'session', access_token: AT, refresh_token: RT };

function session(confirmed = true) {
  return {
    access_token: AT,
    refresh_token: RT,
    user: { id: 'u1', email_confirmed_at: confirmed ? '2026-09-25T10:00:00Z' : null },
  };
}

type AuthResult = { data: { session: unknown; user?: unknown }; error: unknown };

function fakeAuth(opts: { open?: AuthResult | Error; signOut?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const open = async (): Promise<AuthResult> => {
    if (opts.open instanceof Error) throw opts.open;
    return opts.open ?? { data: { session: session() }, error: null };
  };
  const auth = {
    setSession: vi.fn(async () => {
      calls.push('setSession');
      return open();
    }),
    verifyOtp: vi.fn(async () => {
      calls.push('verifyOtp');
      return open();
    }),
    signOut: vi.fn(async () => {
      calls.push('signOut');
      return opts.signOut ? opts.signOut() : { error: null };
    }),
  };
  return { auth, calls, typed: auth as unknown as BridgeAuth };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(calls: string[], response: () => Response | Promise<Response>) {
  return vi.fn(async () => {
    calls.push('fetch');
    return response();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});
afterEach(() => {
  // Los tokens nunca se escriben en la consola.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('parseLanding', () => {
  it('invite y recovery siguen leyendo la sesión del hash', () => {
    expect(parseLanding(`${BASE}#${HASH_SESSION}&type=invite`)).toEqual({
      flow: 'invite',
      access_token: AT,
      refresh_token: RT,
    });
    expect(parseLanding(`${BASE}#${HASH_SESSION}&type=recovery`)).toEqual({
      flow: 'recovery',
      access_token: AT,
      refresh_token: RT,
    });
  });

  it('invite/recovery con token_hash no se aceptan (no se amplían esos flujos)', () => {
    expect(parseLanding(`${BASE}?token_hash=abc&type=invite`).flow).toBe('invalid');
    expect(parseLanding(`${BASE}?token_hash=abc&type=recovery`).flow).toBe('invalid');
  });

  it('signup con la plantilla actual (hash) y con token_hash', () => {
    expect(parseLanding(`${BASE}#${HASH_SESSION}&type=signup`)).toEqual({
      flow: 'signup',
      credentials: hashCreds,
    });
    expect(parseLanding(`${BASE}?token_hash=pkce_abc&type=signup`)).toEqual({
      flow: 'signup',
      credentials: { kind: 'token_hash', token_hash: 'pkce_abc' },
    });
  });

  it.each(['month', 'year'] as const)('magiclink con next=activate&interval=%s', (interval) => {
    expect(
      parseLanding(`${BASE}?next=activate&interval=${interval}#${HASH_SESSION}&type=magiclink`)
    ).toEqual({ flow: 'activate', interval, credentials: hashCreds });
    expect(
      parseLanding(`${BASE}?next=activate&interval=${interval}&token_hash=h1&type=magiclink`)
    ).toEqual({ flow: 'activate', interval, credentials: { kind: 'token_hash', token_hash: 'h1' } });
  });

  it.each([
    ['sin next', `${BASE}?interval=month#${HASH_SESSION}&type=magiclink`],
    ['sin query', `${BASE}#${HASH_SESSION}&type=magiclink`],
    ['next distinto', `${BASE}?next=login&interval=month#${HASH_SESSION}&type=magiclink`],
    ['next como URL', `${BASE}?next=https://evil.example/activate&interval=month#${HASH_SESSION}&type=magiclink`],
    ['next con mayúsculas', `${BASE}?next=Activate&interval=month#${HASH_SESSION}&type=magiclink`],
    ['next repetido', `${BASE}?next=activate&next=https://evil.example&interval=month#${HASH_SESSION}&type=magiclink`],
    ['next en el hash', `${BASE}?interval=month#${HASH_SESSION}&type=magiclink&next=activate`],
  ])('magiclink rechazado: %s', (_, href) => {
    expect(parseLanding(href)).toEqual({ flow: 'invalid', activation: false });
  });

  it.each([
    ['sin interval', `${BASE}?next=activate#${HASH_SESSION}&type=magiclink`],
    ['interval desconocido', `${BASE}?next=activate&interval=week#${HASH_SESSION}&type=magiclink`],
    ['interval repetido', `${BASE}?next=activate&interval=month&interval=year#${HASH_SESSION}&type=magiclink`],
    ['interval vacío', `${BASE}?next=activate&interval=#${HASH_SESSION}&type=magiclink`],
  ])('activación con intervalo inválido: %s', (_, href) => {
    expect(parseLanding(href)).toEqual({ flow: 'invalid', activation: true });
  });

  it('el hash de error de Supabase (enlace usado o caducado)', () => {
    const err = 'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
    expect(parseLanding(`${BASE}#${err}`)).toEqual({ flow: 'link-error', activation: false });
    expect(parseLanding(`${BASE}?next=activate&interval=year#${err}`)).toEqual({
      flow: 'link-error',
      activation: true,
    });
  });

  it.each([
    ['sin nada', BASE],
    ['tipo desconocido', `${BASE}#${HASH_SESSION}&type=email_change`],
    ['sin tipo', `${BASE}#${HASH_SESSION}`],
    ['sin refresh_token', `${BASE}#access_token=${AT}&type=invite`],
    ['hash mal codificado', `${BASE}#access_token=%E0%A4%A&refresh_token=x&type=invite`],
    ['token_hash sin tipo', `${BASE}?token_hash=abc`],
  ])('inválido: %s', (_, href) => {
    expect(parseLanding(href).flow).toBe('invalid');
  });
});

describe('stripeCheckoutUrl', () => {
  it('acepta el Checkout HTTPS de Stripe', () => {
    expect(stripeCheckoutUrl(CHECKOUT)).toBe(CHECKOUT);
  });

  it.each([
    'http://checkout.stripe.com/c/pay/cs_1',
    'https://checkout.stripe.com.evil.example/c/pay/cs_1',
    'https://evil.example/checkout.stripe.com',
    'https://evilcheckout.stripe.com/c/pay/cs_1',
    'https://stripe.com/c/pay/cs_1',
    'https://user:pass@checkout.stripe.com/c/pay/cs_1',
    'https://checkout.stripe.com@evil.example/',
    'https://checkout.stripe.com:8443/c/pay/cs_1',
    'javascript:alert(1)//checkout.stripe.com',
    '//checkout.stripe.com/c/pay/cs_1',
    '/c/pay/cs_1',
    '',
    `https://checkout.stripe.com/${'a'.repeat(2100)}`,
  ])('rechaza %s', (url) => {
    expect(stripeCheckoutUrl(url)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ['https://checkout.stripe.com/x']])('rechaza %j', (v) => {
    expect(stripeCheckoutUrl(v)).toBeNull();
  });
});

describe('confirmSignup', () => {
  it('hash válido: valida la sesión, exige email confirmado y cierra solo esa sesión', async () => {
    const { auth, calls, typed } = fakeAuth();
    await expect(confirmSignup(typed, hashCreds)).resolves.toBe(true);
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: AT, refresh_token: RT });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(calls).toEqual(['setSession', 'signOut']);
  });

  it('token_hash válido: usa verifyOtp y nunca setSession', async () => {
    const { auth, typed } = fakeAuth();
    await expect(confirmSignup(typed, { kind: 'token_hash', token_hash: 'h' })).resolves.toBe(true);
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('token_hash caducado o ya usado: sin falso éxito', async () => {
    const { auth, typed } = fakeAuth({
      open: { data: { session: null, user: null }, error: { status: 403, code: 'otp_expired' } },
    });
    await expect(confirmSignup(typed, { kind: 'token_hash', token_hash: 'h' })).resolves.toBe(false);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('sesión del hash rechazada por Supabase: sin falso éxito', async () => {
    const { typed } = fakeAuth({ open: { data: { session: null }, error: { status: 401 } } });
    await expect(confirmSignup(typed, hashCreds)).resolves.toBe(false);
  });

  it('error de red al verificar: sin falso éxito', async () => {
    const { typed } = fakeAuth({ open: new Error('network down') });
    await expect(confirmSignup(typed, hashCreds)).resolves.toBe(false);
  });

  it('sesión válida pero email sin confirmar: no dice que esté confirmado', async () => {
    const { auth, typed } = fakeAuth({ open: { data: { session: session(false) }, error: null } });
    await expect(confirmSignup(typed, hashCreds)).resolves.toBe(false);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});

describe('startActivation', () => {
  it.each(['month', 'year'] as const)(
    '%s: verifica, POST con el JWT, cierra la sesión y después navega a Stripe',
    async (interval) => {
      const { auth, calls, typed } = fakeAuth();
      const fetchFn = fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT }));
      const navigate = vi.fn((url: string) => calls.push(`navigate:${url}`));

      await expect(startActivation(typed, hashCreds, interval, fetchFn, navigate)).resolves.toEqual({
        ok: true,
      });

      expect(calls).toEqual(['setSession', 'fetch', 'signOut', `navigate:${CHECKOUT}`]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(ACTIVATION_CHECKOUT_URL);
      expect(url).toBe('https://api.trazea.es/v1/billing/activation-checkout');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: `Bearer ${AT}`,
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({ interval });
      expect(init.credentials).toBe('omit');
      expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    }
  );

  it('con token_hash verifica con verifyOtp tipo magiclink', async () => {
    const { auth, calls, typed } = fakeAuth();
    const fetchFn = fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT }));
    const navigate = vi.fn();
    await startActivation(typed, { kind: 'token_hash', token_hash: 'h' }, 'year', fetchFn, navigate);
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'magiclink' });
    expect(navigate).toHaveBeenCalledWith(CHECKOUT);
  });

  it('el signOut solo empieza cuando la API ya ha respondido', async () => {
    let resolveFetch!: (r: Response) => void;
    const { auth, calls, typed } = fakeAuth();
    const fetchFn = fakeFetch(calls, () => new Promise<Response>((r) => (resolveFetch = r)));
    const navigate = vi.fn();
    const done = startActivation(typed, hashCreds, 'month', fetchFn, navigate);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(auth.signOut).not.toHaveBeenCalled();
    resolveFetch(jsonResponse(200, { url: CHECKOUT }));
    await done;
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(CHECKOUT);
  });

  it('si el signOut falla, se navega igual', async () => {
    const { calls, typed } = fakeAuth({ signOut: () => Promise.reject(new Error('offline')) });
    const fetchFn = fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT }));
    const navigate = vi.fn();
    await expect(startActivation(typed, hashCreds, 'month', fetchFn, navigate)).resolves.toEqual({
      ok: true,
    });
    expect(navigate).toHaveBeenCalledWith(CHECKOUT);
  });

  it('si el signOut no responde, se navega al vencer su plazo', async () => {
    vi.useFakeTimers();
    const { calls, typed } = fakeAuth({ signOut: () => new Promise(() => {}) });
    const fetchFn = fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT }));
    const navigate = vi.fn();
    const done = startActivation(typed, hashCreds, 'month', fetchFn, navigate);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(done).resolves.toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledWith(CHECKOUT);
  });

  it('enlace no verificado: ni POST ni navegación', async () => {
    const { calls, typed } = fakeAuth({
      open: { data: { session: null }, error: { status: 403, code: 'otp_expired' } },
    });
    const fetchFn = fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT }));
    const navigate = vi.fn();
    await expect(startActivation(typed, hashCreds, 'month', fetchFn, navigate)).resolves.toEqual({
      ok: false,
      error: 'link',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error_code: 'AuthorizationError', detail: 'x' }, 'forbidden'],
    [403, { error_code: 'AccountPendingDeletion', detail: 'x' }, 'pending-deletion'],
    [409, { error_code: 'NotATrial', detail: 'x' }, 'not-trial'],
    [409, { error_code: 'ConflictError', detail: 'x' }, 'unavailable'],
    [429, { detail: 'x' }, 'rate-limited'],
    [503, { error_code: 'BillingProviderUnavailable' }, 'unavailable'],
    [500, '<html>oops</html>', 'unavailable'],
    [401, { detail: 'Invalid token' }, 'unavailable'],
  ])('API %i → %s, sin navegar y cerrando la sesión', async (status, body, error) => {
    const { auth, calls, typed } = fakeAuth();
    const fetchFn = fakeFetch(calls, () => jsonResponse(status, body));
    const navigate = vi.fn();
    const result = await startActivation(typed, hashCreds, 'month', fetchFn, navigate);
    expect(result).toEqual({ ok: false, error });
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('fallo de red: sin navegar', async () => {
    const { calls, typed } = fakeAuth();
    const fetchFn = fakeFetch(calls, () => Promise.reject(new TypeError('Failed to fetch')));
    const navigate = vi.fn();
    await expect(startActivation(typed, hashCreds, 'month', fetchFn, navigate)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    { url: 'https://evil.example/c/pay/cs_1' },
    { url: 'http://checkout.stripe.com/c/pay/cs_1' },
    { url: 'javascript:alert(document.cookie)' },
    { url: 'https://checkout.stripe.com.evil.example/' },
    { redirect: CHECKOUT },
    {},
    'not json',
    [CHECKOUT],
  ])('respuesta 200 maliciosa o rara %j: nunca se navega', async (body) => {
    const { auth, calls, typed } = fakeAuth();
    const fetchFn = fakeFetch(calls, () => jsonResponse(200, body));
    const navigate = vi.fn();
    await expect(startActivation(typed, hashCreds, 'month', fetchFn, navigate)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});

describe('diagnóstico de activation-checkout', () => {
  async function diagnoseWith(fetchFn: typeof fetch) {
    const { typed } = fakeAuth();
    const diagnose = vi.fn();
    const result = await startActivation(typed, hashCreds, 'month', fetchFn, vi.fn(), diagnose);
    const sent = JSON.stringify(diagnose.mock.calls);
    expect(sent).not.toContain('SECRET');
    expect(sent).not.toContain(ACTIVATION_CHECKOUT_URL);
    expect(sent).not.toContain('checkout.stripe.com');
    return { result, diagnose };
  }

  it('fetch rechazado (red, CORS…): categoría network, sin status ni causa inventados', async () => {
    const { result, diagnose } = await diagnoseWith(
      fakeFetch([], () => Promise.reject(new TypeError('Failed to fetch')))
    );
    expect(result).toEqual({ ok: false, error: 'unavailable' });
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({ category: 'network' });
  });

  it('la API no responde en plazo: categoría timeout', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        )
    ) as unknown as typeof fetch;
    const { typed } = fakeAuth();
    const diagnose = vi.fn();
    const done = startActivation(typed, hashCreds, 'month', fetchFn, vi.fn(), diagnose);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(done).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(diagnose).toHaveBeenCalledWith({ category: 'timeout' });
  });

  it.each([
    [500, '<html>Internal Server Error SECRET</html>', { category: 'http', status: 500 }],
    [503, { error_code: 'BillingProviderUnavailable', detail: 'stripe down SECRET' }, {
      category: 'http',
      status: 503,
      error_code: 'BillingProviderUnavailable',
    }],
    [502, { error_code: '<script>alert(1)</script>' }, { category: 'http', status: 502 }],
    [500, { error_code: `user@example.com ${AT}` }, { category: 'http', status: 500 }],
    [500, { error_code: 42 }, { category: 'http', status: 500 }],
    [403, { error_code: 'AccountPendingDeletion' }, {
      category: 'http',
      status: 403,
      error_code: 'AccountPendingDeletion',
    }],
  ])('respuesta HTTP %i: status y error_code saneado, nunca el cuerpo', async (status, body, expected) => {
    const { diagnose } = await diagnoseWith(fakeFetch([], () => jsonResponse(status, body)));
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith(expected);
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain('detail');
  });

  it('200 sin Checkout válido: invalid-response, sin la URL recibida', async () => {
    const { result, diagnose } = await diagnoseWith(
      fakeFetch([], () => jsonResponse(200, { url: 'https://evil.example/c/pay/cs_SECRET' }))
    );
    expect(result).toEqual({ ok: false, error: 'unavailable' });
    expect(diagnose).toHaveBeenCalledWith({ category: 'invalid-response', status: 200 });
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain('evil');
  });

  it('éxito: sin diagnóstico', async () => {
    const { result, diagnose } = await diagnoseWith(
      fakeFetch([], () => jsonResponse(200, { url: CHECKOUT }))
    );
    expect(result).toEqual({ ok: true });
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('un diagnóstico que lanza no cambia el resultado', async () => {
    const { typed } = fakeAuth();
    const result = await startActivation(
      typed,
      hashCreds,
      'month',
      fakeFetch([], () => jsonResponse(500, {})),
      vi.fn(),
      () => {
        throw new Error('boom');
      }
    );
    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('createBridgeRunner', () => {
  function env(href: string, overrides: Partial<BridgeEnv> = {}) {
    const calls: string[] = [];
    const password = fakeAuth();
    const ephemeral = fakeAuth();
    const e: BridgeEnv = {
      href,
      clearUrl: vi.fn(() => calls.push('clearUrl')),
      passwordAuth: vi.fn(() => password.typed),
      ephemeralAuth: vi.fn(() => {
        calls.push('ephemeralAuth');
        return ephemeral.typed;
      }),
      fetch: fakeFetch(calls, () => jsonResponse(200, { url: CHECKOUT })),
      navigate: vi.fn((url: string) => calls.push(`navigate:${url}`)),
      ...overrides,
    };
    return { e, calls, password, ephemeral };
  }

  const ACTIVATE = `${BASE}?next=activate&interval=month#${HASH_SESSION}&type=magiclink`;
  const activateHash = (interval: string) =>
    `${BASE}?next=activate&interval=${interval}#${HASH_SESSION}&type=magiclink`;
  const activateTokenHash = (interval: string) =>
    `${BASE}?next=activate&interval=${interval}&token_hash=h1&type=magiclink`;

  async function confirmView(e: BridgeEnv, run = createBridgeRunner()) {
    const outcome = await run(() => e);
    if (outcome.view !== 'activation-confirm') throw new Error(`vista inesperada: ${outcome.view}`);
    return outcome;
  }

  function expectUntouched(e: BridgeEnv, ephemeral: ReturnType<typeof fakeAuth>) {
    expect(e.ephemeralAuth).not.toHaveBeenCalled();
    expect(ephemeral.auth.verifyOtp).not.toHaveBeenCalled();
    expect(ephemeral.auth.setSession).not.toHaveBeenCalled();
    expect(ephemeral.auth.signOut).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
    expect(e.navigate).not.toHaveBeenCalled();
  }

  describe.each([
    ['token_hash', activateTokenHash],
    ['sesión en el hash (enlace antiguo)', activateHash],
  ])('activación con %s', (_, href) => {
    it.each(['month', 'year'] as const)(
      '%s: cargar solo muestra la confirmación, sin consumir el enlace',
      async (interval) => {
        const { e, ephemeral, password } = env(href(interval));
        const outcome = await confirmView(e);
        expect(outcome.interval).toBe(interval);
        expect(e.clearUrl).toHaveBeenCalledTimes(1);
        expectUntouched(e, ephemeral);
        expect(e.passwordAuth).not.toHaveBeenCalled();
        expect(password.auth.setSession).not.toHaveBeenCalled();
        // Las credenciales no viajan en el resultado serializable.
        expect(JSON.stringify(outcome)).not.toContain('SECRET');
        expect(JSON.stringify(outcome)).not.toContain('h1');
      }
    );

    it.each(['month', 'year'] as const)(
      '%s: el clic verifica, pide el Checkout de ese intervalo, cierra y navega',
      async (interval) => {
        const { e, calls, ephemeral } = env(href(interval));
        const { confirm } = await confirmView(e);
        await expect(confirm()).resolves.toEqual({ view: 'redirecting' });
        const open =
          href === activateTokenHash ? ephemeral.auth.verifyOtp : ephemeral.auth.setSession;
        // Orden: verificar → API → cerrar la sesión → navegar.
        const order = [
          e.ephemeralAuth,
          open,
          e.fetch,
          ephemeral.auth.signOut,
          e.navigate,
        ].map((fn) => (fn as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
        expect(order.every((n) => n !== undefined)).toBe(true);
        expect([...order].sort((x, y) => x - y)).toEqual(order);
        expect(calls).toEqual(['clearUrl', 'ephemeralAuth', 'fetch', `navigate:${CHECKOUT}`]);
        const [, init] = (e.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
          string,
          RequestInit,
        ];
        expect(JSON.parse(init.body as string)).toEqual({ interval });
        expect(ephemeral.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
      }
    );
  });

  it('el clic con token_hash usa verifyOtp tipo magiclink y nunca setSession', async () => {
    const { e, ephemeral } = env(activateTokenHash('year'));
    await (await confirmView(e)).confirm();
    expect(ephemeral.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h1', type: 'magiclink' });
    expect(ephemeral.auth.setSession).not.toHaveBeenCalled();
  });

  it('Strict Mode + doble clic: una sola verificación, un POST y una navegación', async () => {
    const run = createBridgeRunner();
    const { e, ephemeral } = env(activateTokenHash('month'));
    const factory = vi.fn(() => e);
    const [a, b] = await Promise.all([run(factory), run(factory)]);
    expect(b).toBe(a);
    expect(factory).toHaveBeenCalledTimes(1);
    expectUntouched(e, ephemeral);
    if (a.view !== 'activation-confirm') throw new Error(a.view);

    const [r1, r2] = await Promise.all([a.confirm(), a.confirm()]);
    const r3 = await a.confirm();
    expect(r1).toEqual({ view: 'redirecting' });
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(e.ephemeralAuth).toHaveBeenCalledTimes(1);
    expect(ephemeral.auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(e.fetch).toHaveBeenCalledTimes(1);
    expect(e.navigate).toHaveBeenCalledTimes(1);
  });

  it('un fallo tampoco se reintenta en el segundo clic (el enlace ya está gastado)', async () => {
    const { e } = env(activateTokenHash('month'), {
      fetch: fakeFetch([], () => jsonResponse(503, {})),
    });
    const { confirm } = await confirmView(e);
    await expect(confirm()).resolves.toEqual({ view: 'activation-failed', error: 'unavailable' });
    await confirm();
    expect(e.fetch).toHaveBeenCalledTimes(1);
  });

  it('token caducado o ya usado al pulsar: error de enlace, sin POST ni navegación', async () => {
    const ephemeral = fakeAuth({
      open: { data: { session: null }, error: { status: 403, code: 'otp_expired' } },
    });
    const { e } = env(activateTokenHash('year'), { ephemeralAuth: vi.fn(() => ephemeral.typed) });
    const { confirm } = await confirmView(e);
    await expect(confirm()).resolves.toEqual({ view: 'activation-failed', error: 'link' });
    expect(e.fetch).not.toHaveBeenCalled();
    expect(e.navigate).not.toHaveBeenCalled();
  });

  it('hash otp_expired con next=activate: error de activación, sin Supabase ni API', async () => {
    const { e, ephemeral } = env(
      `${BASE}?next=activate&interval=month#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`
    );
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({
      view: 'link-error',
      activation: true,
    });
    expectUntouched(e, ephemeral);
  });

  it('activación: borra la URL al cargar y no toca el cliente persistente', async () => {
    const { e, calls } = env(ACTIVATE);
    await confirmView(e);
    expect(calls).toEqual(['clearUrl']);
    expect(e.passwordAuth).not.toHaveBeenCalled();
  });

  it('activación fallida en la API: resultado de error sin tokens', async () => {
    const { e } = env(ACTIVATE, { fetch: fakeFetch([], () => jsonResponse(503, {})) });
    const outcome = await (await confirmView(e)).confirm();
    expect(outcome).toEqual({ view: 'activation-failed', error: 'unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
    expect(e.navigate).not.toHaveBeenCalled();
  });

  it('el diagnóstico llega desde el entorno de la página', async () => {
    const diagnose = vi.fn();
    const { e } = env(ACTIVATE, {
      fetch: fakeFetch([], () => jsonResponse(502, { error_code: 'BillingProviderUnavailable' })),
      diagnose,
    });
    await (await confirmView(e)).confirm();
    expect(diagnose).toHaveBeenCalledWith({
      category: 'http',
      status: 502,
      error_code: 'BillingProviderUnavailable',
    });
  });

  it('magiclink sin next=activate: rechazado sin llamar a Supabase ni a la API', async () => {
    const { e, password, ephemeral } = env(`${BASE}#${HASH_SESSION}&type=magiclink`);
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'invalid', activation: false });
    expect(e.clearUrl).toHaveBeenCalled();
    expect(e.ephemeralAuth).not.toHaveBeenCalled();
    expect(e.passwordAuth).not.toHaveBeenCalled();
    expect(password.auth.setSession).not.toHaveBeenCalled();
    expect(ephemeral.auth.setSession).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
  });

  it('activación con intervalo inválido: sin Supabase ni API', async () => {
    const { e } = env(`${BASE}?next=activate&interval=lifetime#${HASH_SESSION}&type=magiclink`);
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'invalid', activation: true });
    expect(e.ephemeralAuth).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
  });

  it('signup válido: confirmado, sin API ni formulario', async () => {
    const { e, ephemeral } = env(`${BASE}#${HASH_SESSION}&type=signup`);
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'signup-confirmed' });
    expect(e.clearUrl).toHaveBeenCalled();
    expect(ephemeral.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(e.passwordAuth).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
    expect(e.navigate).not.toHaveBeenCalled();
  });

  it('signup caducado (hash de error de Supabase): error, no éxito', async () => {
    const { e } = env(`${BASE}#error=access_denied&error_code=otp_expired&error_description=x`);
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'link-error', activation: false });
    expect(e.ephemeralAuth).not.toHaveBeenCalled();
  });

  it('signup con token_hash caducado: signup-failed', async () => {
    const ephemeral = fakeAuth({
      open: { data: { session: null }, error: { status: 403, code: 'otp_expired' } },
    });
    const { e } = env(`${BASE}?token_hash=h&type=signup`, { ephemeralAuth: () => ephemeral.typed });
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'signup-failed' });
  });

  it.each(['invite', 'recovery'] as const)(
    'regresión %s: setSession en el cliente persistente y formulario',
    async (flow) => {
      const { e, password } = env(`${BASE}#${HASH_SESSION}&type=${flow}`);
      await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'form', flow });
      expect(password.auth.setSession).toHaveBeenCalledWith({ access_token: AT, refresh_token: RT });
      expect(password.auth.signOut).not.toHaveBeenCalled();
      // Igual que antes: ni se borra la URL a mano ni se usa el cliente efímero.
      expect(e.clearUrl).not.toHaveBeenCalled();
      expect(e.ephemeralAuth).not.toHaveBeenCalled();
      expect(e.fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['invite', 'recovery'] as const)('regresión %s caducado: mensaje de su flujo', async (flow) => {
    const password = fakeAuth({ open: { data: { session: null }, error: { status: 401 } } });
    const { e } = env(`${BASE}#${HASH_SESSION}&type=${flow}`, { passwordAuth: () => password.typed });
    await expect(createBridgeRunner()(() => e)).resolves.toEqual({ view: 'password-link-expired', flow });
  });
});
