import {
  isAuthRetryableFetchError,
  type AuthResponse,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';

// Lógica del puente sin React: qué enlace ha llegado y qué se hace con él.
// Los tokens que llegan en la URL son secretos: aquí no se registran, no se
// guardan fuera de memoria y no aparecen en ningún mensaje de error.

export const ACTIVATION_CHECKOUT_URL = 'https://api.trazea.es/v1/billing/activation-checkout';
const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com';
const API_TIMEOUT_MS = 20_000;
const SIGN_OUT_TIMEOUT_MS = 3_000;

export type Interval = 'month' | 'year';
export type PasswordFlow = 'invite' | 'recovery';

// Lo que trae el enlace para abrir la sesión: la plantilla actual de Supabase
// ({{ .ConfirmationURL }}) redirige con la sesión ya emitida en el hash; una
// plantilla con {{ .TokenHash }} la trae sin verificar en la query.
export type Credentials =
  | { kind: 'session'; access_token: string; refresh_token: string }
  | { kind: 'token_hash'; token_hash: string };

export type Landing =
  | { flow: PasswordFlow; access_token: string; refresh_token: string }
  | { flow: 'signup'; credentials: Credentials }
  | { flow: 'activate'; interval: Interval; credentials: Credentials }
  // Supabase redirige con #error=… cuando el enlace ya se usó o caducó, sin
  // decir de qué tipo era. Solo `next=activate` en la query lo identifica.
  | { flow: 'link-error'; activation: boolean }
  | { flow: 'invalid'; activation: boolean };

export function parseHash(hash: string): Record<string, string> {
  return Object.fromEntries(
    hash
      .split('&')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
      })
  );
}

function single(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : null;
}

export function parseLanding(href: string): Landing {
  let url: URL;
  let hash: Record<string, string>;
  try {
    url = new URL(href);
    hash = parseHash(url.hash.slice(1));
  } catch {
    return { flow: 'invalid', activation: false };
  }
  const query = url.searchParams;
  // `next` es una etiqueta, nunca un destino: solo se compara con un literal.
  const wantsActivation = single(query, 'next') === 'activate';

  if (hash.error || hash.error_code || hash.error_description) {
    return { flow: 'link-error', activation: wantsActivation };
  }

  let type: string | undefined;
  let credentials: Credentials | undefined;
  if (hash.access_token && hash.refresh_token) {
    type = hash.type;
    credentials = {
      kind: 'session',
      access_token: hash.access_token,
      refresh_token: hash.refresh_token,
    };
  } else {
    const tokenHash = single(query, 'token_hash');
    if (tokenHash) {
      type = single(query, 'type') ?? undefined;
      credentials = { kind: 'token_hash', token_hash: tokenHash };
    }
  }

  if (!credentials) return { flow: 'invalid', activation: wantsActivation };

  if ((type === 'invite' || type === 'recovery') && credentials.kind === 'session') {
    return {
      flow: type,
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
    };
  }

  if (type === 'signup') return { flow: 'signup', credentials };

  if (type === 'magiclink') {
    // Un magiclink solo se acepta para activar, y con un intervalo conocido.
    if (!wantsActivation) return { flow: 'invalid', activation: false };
    const interval = single(query, 'interval');
    if (interval !== 'month' && interval !== 'year') {
      return { flow: 'invalid', activation: true };
    }
    return { flow: 'activate', interval, credentials };
  }

  return { flow: 'invalid', activation: wantsActivation };
}

// ---------------------------------------------------------------------------
// Sesión temporal (signup y activación)

export type BridgeAuth = Pick<SupabaseClient['auth'], 'setSession' | 'verifyOtp' | 'signOut'>;

async function openSession(
  auth: BridgeAuth,
  credentials: Credentials,
  type: 'signup' | 'magiclink'
): Promise<Session | null> {
  try {
    const { data, error } =
      credentials.kind === 'session'
        ? // setSession valida el access token contra /user antes de aceptarlo.
          await auth.setSession({
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token,
          })
        : await auth.verifyOtp({ token_hash: credentials.token_hash, type });
    if (error || !data.session) return null;
    return data.session;
  } catch {
    return null;
  }
}

// Cierra solo esta sesión (scope local): `global` también cerraría la del móvil.
// Nunca bloquea: si Supabase no responde, se sigue adelante.
export async function closeSession(auth: BridgeAuth): Promise<void> {
  try {
    await Promise.race([
      auth.signOut({ scope: 'local' }),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS)),
    ]);
  } catch {
    // La sesión solo vivía en memoria; no hay nada más que limpiar.
  }
}

export async function confirmSignup(auth: BridgeAuth, credentials: Credentials): Promise<boolean> {
  const session = await openSession(auth, credentials, 'signup');
  if (!session) return false;
  const confirmed = Boolean(session.user?.email_confirmed_at);
  await closeSession(auth);
  return confirmed;
}

// ---------------------------------------------------------------------------
// Activación

export type ActivationError =
  | 'link'
  | 'forbidden'
  | 'pending-deletion'
  | 'not-trial'
  | 'rate-limited'
  | 'unavailable';

export function stripeCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== STRIPE_CHECKOUT_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  return url.href;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeApiFailure(status: number, errorCode: unknown): ActivationError {
  if (status === 403 && errorCode === 'AccountPendingDeletion') return 'pending-deletion';
  if (status === 403) return 'forbidden';
  if (status === 409 && errorCode === 'NotATrial') return 'not-trial';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

// Diagnóstico del POST a activation-checkout: distingue un fallo de transporte
// (el fetch ni siquiera devuelve respuesta: red, CORS, bloqueador… el navegador
// no dice cuál) de una respuesta HTTP. Nunca lleva el JWT, la URL de Stripe ni
// el cuerpo: solo la categoría, el status y un error_code con forma de código.
export type CheckoutDiagnostic =
  | { category: 'network' }
  | { category: 'timeout' }
  | { category: 'http'; status: number; error_code?: string }
  | { category: 'invalid-response'; status: number };

export type Diagnose = (diagnostic: CheckoutDiagnostic) => void;

const ERROR_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function safeErrorCode(raw: unknown): string | undefined {
  return typeof raw === 'string' && ERROR_CODE_SHAPE.test(raw) ? raw : undefined;
}

function report(diagnose: Diagnose | undefined, diagnostic: CheckoutDiagnostic): void {
  try {
    diagnose?.(diagnostic);
  } catch {
    // El diagnóstico nunca cambia el resultado de la activación.
  }
}

async function requestCheckout(
  fetchFn: typeof fetch,
  accessToken: string,
  interval: Interval,
  diagnose?: Diagnose
): Promise<{ url: string } | { error: ActivationError }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(ACTIVATION_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ interval }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    // Un fetch rechazado no trae status: no se inventa ninguno.
    report(diagnose, { category: timedOut ? 'timeout' : 'network' });
    return { error: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }

  const body = await readJson(res);
  if (!res.ok) {
    const errorCode = safeErrorCode(body?.error_code);
    report(diagnose, {
      category: 'http',
      status: res.status,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
    return { error: describeApiFailure(res.status, body?.error_code) };
  }
  const url = stripeCheckoutUrl(body?.url);
  if (!url) {
    report(diagnose, { category: 'invalid-response', status: res.status });
    return { error: 'unavailable' };
  }
  return { url };
}

/**
 * Verifica el enlace, pide el Checkout con el JWT de esa sesión, cierra la
 * sesión y solo entonces navega. El orden importa: el JWT no se revoca hasta
 * que la API ha respondido, y la navegación no espera más de lo necesario.
 */
export async function startActivation(
  auth: BridgeAuth,
  credentials: Credentials,
  interval: Interval,
  fetchFn: typeof fetch,
  navigate: (url: string) => void,
  diagnose?: Diagnose
): Promise<{ ok: true } | { ok: false; error: ActivationError }> {
  const session = await openSession(auth, credentials, 'magiclink');
  if (!session) return { ok: false, error: 'link' };

  const result = await requestCheckout(fetchFn, session.access_token, interval, diagnose);
  await closeSession(auth);

  if ('error' in result) return { ok: false, error: result.error };
  navigate(result.url);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orquestación de una carga de página

export type ActivationOutcome =
  | { view: 'redirecting' }
  | { view: 'activation-failed'; error: ActivationError };

export type Outcome =
  | { view: 'form'; flow: PasswordFlow }
  | { view: 'password-link-expired'; flow: PasswordFlow }
  // No se pudo comprobar el enlace (red, SDK…): puede seguir siendo válido, y
  // `retry` lo vuelve a intentar con los tokens en memoria.
  | { view: 'password-check-failed'; flow: PasswordFlow; retry: () => Promise<Outcome> }
  | { view: 'invalid'; activation: boolean }
  | { view: 'link-error'; activation: boolean }
  | { view: 'signup-confirmed' }
  | { view: 'signup-failed' }
  // Un enlace de activación válido no hace nada al cargar: los escáneres y
  // previsualizadores de correo abren la URL, y verificar aquí gastaría el
  // token. Solo `confirm()`, que llama el botón "Continuar al pago", lo usa.
  | { view: 'activation-confirm'; interval: Interval; confirm: () => Promise<ActivationOutcome> };

export interface BridgeEnv {
  href: string;
  // Quita de la barra de direcciones los datos del enlace.
  clearUrl: () => void;
  // Cliente persistente de invite/recovery (updateUser necesita la sesión).
  passwordAuth: () => Pick<SupabaseClient['auth'], 'setSession'>;
  // Cliente en memoria, sin persistencia ni autorefresco, para signup/activación.
  ephemeralAuth: () => BridgeAuth;
  fetch: typeof fetch;
  navigate: (url: string) => void;
  // Diagnóstico sin datos sensibles de la llamada a activation-checkout.
  diagnose?: Diagnose;
}

/**
 * La acción del botón "Continuar al pago". Las credenciales solo viven en este
 * closure (ni estado de React ni URL). Una sola ejecución aunque se pulse dos
 * veces: si falla no se reintenta, porque verificar ya ha gastado el enlace.
 */
function activationAction(
  env: BridgeEnv,
  credentials: Credentials,
  interval: Interval
): () => Promise<ActivationOutcome> {
  let pending: Promise<ActivationOutcome> | null = null;
  const attempt = async (): Promise<ActivationOutcome> => {
    try {
      const result = await startActivation(
        env.ephemeralAuth(),
        credentials,
        interval,
        env.fetch,
        env.navigate,
        env.diagnose
      );
      return result.ok ? { view: 'redirecting' } : { view: 'activation-failed', error: result.error };
    } catch {
      // Un fallo inesperado tampoco deja el botón cargando ni se reintenta.
      return { view: 'activation-failed', error: 'unavailable' };
    }
  };
  return () => (pending ??= attempt());
}

/**
 * Abre la sesión de invite/recovery en el cliente persistente. Reintentar no
 * recarga: con detectSessionInUrl, el SDK valida el hash al crearse y lo borra
 * si va bien, así que cuando falla setSession la URL puede no llevar ya el
 * enlace. Los tokens solo viven en este closure.
 */
async function openPasswordSession(
  env: BridgeEnv,
  flow: PasswordFlow,
  tokens: { access_token: string; refresh_token: string }
): Promise<Outcome> {
  const checkFailed = (): Outcome => ({
    view: 'password-check-failed',
    flow,
    retry: () => openPasswordSession(env, flow, tokens),
  });
  // El error no sale de aquí: su mensaje podría llevar datos del enlace.
  let result: AuthResponse;
  try {
    result = await env.passwordAuth().setSession(tokens);
  } catch {
    return checkFailed();
  }
  const { data, error } = result;
  // El formulario solo con una sesión real: updateUser la necesita.
  if (!error && data.session) return { view: 'form', flow };
  // Supabase devuelve (no lanza) los fallos de red y los 502/503/504.
  if (isAuthRetryableFetchError(error)) return checkFailed();
  return { view: 'password-link-expired', flow };
}

async function run(env: BridgeEnv): Promise<Outcome> {
  const landing = parseLanding(env.href);

  switch (landing.flow) {
    case 'invite':
    case 'recovery':
      return openPasswordSession(env, landing.flow, {
        access_token: landing.access_token,
        refresh_token: landing.refresh_token,
      });
    case 'signup': {
      env.clearUrl();
      const ok = await confirmSignup(env.ephemeralAuth(), landing.credentials);
      return { view: ok ? 'signup-confirmed' : 'signup-failed' };
    }
    case 'activate': {
      // La URL se limpia ya: recargar o volver atrás no la reutiliza, y lo
      // necesario para el clic queda solo en memoria.
      env.clearUrl();
      return {
        view: 'activation-confirm',
        interval: landing.interval,
        confirm: activationAction(env, landing.credentials, landing.interval),
      };
    }
    case 'link-error':
      return { view: 'link-error', activation: landing.activation };
    case 'invalid':
      // Un enlace rechazado puede traer una sesión válida (p. ej. un magiclink
      // sin next=activate): no se usa, pero tampoco se deja en la URL.
      env.clearUrl();
      return { view: 'invalid', activation: landing.activation };
  }
}

/**
 * Una sola ejecución por carga de página, aunque el efecto se monte dos veces
 * (Strict Mode) o el componente se vuelva a montar: todas las llamadas
 * comparten el mismo resultado. Para la activación ese resultado es la
 * pantalla de confirmación, así que montar no verifica ni pide el Checkout.
 */
export function createBridgeRunner(): (env: () => BridgeEnv) => Promise<Outcome> {
  let pending: Promise<Outcome> | null = null;
  return (env) => (pending ??= run(env()));
}
