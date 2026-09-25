'use client';

import Image from 'next/image';
import { useEffect, useState, useCallback, useRef } from 'react';
import { createEphemeralSupabase, getSupabase } from '@/lib/supabase';
import { createBridgeRunner, type ActivationError, type PasswordFlow } from '@/lib/authBridge';

const STRENGTH = [
  { pct: 0, color: '', label: '' },
  { pct: 25, color: '#ef4444', label: 'Muy débil' },
  { pct: 50, color: '#f97316', label: 'Débil' },
  { pct: 75, color: '#eab308', label: 'Aceptable' },
  { pct: 100, color: '#1dba5d', label: 'Fuerte' },
];

type State = 'loading' | 'form' | 'success' | 'error' | 'signup-confirmed' | 'redirecting';

// Los dos flujos con contraseña que Supabase manda a este puente. El copy es lo
// único que cambia entre ellos: en ambos casos la sesión llega en el hash y se
// termina con updateUser({ password }).
type Flow = PasswordFlow;

// Una ejecución por carga de página (Strict Mode monta el efecto dos veces).
const runBridge = createBridgeRunner();

// Supabase redirige con #error=… sin decir de qué enlace se trataba.
const LINK_USED =
  'Este enlace ha caducado o ya se ha usado. Si ya completaste este paso, abre la app Trazea e inicia sesión. Si no, solicita un enlace nuevo.';

const SIGNUP_FAILED =
  'No hemos podido confirmar tu correo con este enlace: puede haber caducado o ya se ha usado. Si ya lo confirmaste, inicia sesión en la app; si no, pide que te reenvíe el email desde la pantalla de acceso.';

const ACTIVATION_LINK =
  'El enlace de activación ha caducado, ya se ha usado o no es válido. Vuelve a pedirlo desde la pantalla Activar de la app.';

// Ningún mensaje afirma que se haya pagado: aquí nunca se llega a pagar.
const ACTIVATION_ERRORS: Record<ActivationError, string> = {
  link: ACTIVATION_LINK,
  forbidden: 'Solo la persona administradora del negocio puede activar la suscripción.',
  'pending-deletion':
    'Tu cuenta tiene una baja programada. Cancélala desde la app antes de activar la suscripción.',
  'not-trial':
    'Esta cuenta no tiene una prueba pendiente de activar. Abre la app para ver el estado de tu suscripción.',
  'rate-limited':
    'Demasiados intentos seguidos. Espera unos minutos y vuelve a pedir el enlace desde la app.',
  unavailable:
    'No hemos podido abrir la página de pago y no se ha hecho ningún cobro. Vuelve a pedir el enlace desde la pantalla Activar de la app.',
};

const COPY: Record<Flow, { title: string; subtitle: string; expired: string; invalid: string; done: string }> = {
  invite: {
    title: 'Crea tu contraseña',
    subtitle: 'Has sido invitado a Trazea. Elige una contraseña para activar tu cuenta.',
    expired:
      'El enlace de invitación ha expirado. Contacta con el administrador para solicitar uno nuevo.',
    invalid:
      'El enlace de invitación ha expirado o no es válido. Contacta con el administrador para solicitar una nueva invitación.',
    done: 'Tu cuenta está lista. Abre la app Trazea en tu móvil para acceder.',
  },
  recovery: {
    title: 'Cambia tu contraseña',
    subtitle: 'Elige una contraseña nueva para tu cuenta de Trazea.',
    expired:
      'El enlace para restablecer la contraseña ha expirado. Pide uno nuevo desde la pantalla de acceso de la app.',
    invalid:
      'El enlace para restablecer la contraseña ha expirado o no es válido. Pide uno nuevo desde la pantalla de acceso de la app.',
    done: 'Tu contraseña se ha actualizado. Abre la app Trazea en tu móvil para entrar.',
  },
};

export default function AuthPage() {
  const [state, setState] = useState<State>('loading');
  const [flow, setFlow] = useState<Flow>('invite');
  const [errorMsg, setErrorMsg] = useState('');
  const [errorTitle, setErrorTitle] = useState('Enlace inválido');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showCf, setShowCf] = useState(false);
  const [strength, setStrength] = useState(STRENGTH[0]);
  const [formError, setFormError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const appScheme = process.env.NEXT_PUBLIC_APP_SCHEME || 'trazea';

  const calcStrength = useCallback((v: string) => {
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
    if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) score++;
    return STRENGTH[v.length === 0 ? 0 : Math.min(score + 1, 4)];
  }, []);

  useEffect(() => {
    setStrength(calcStrength(password));
  }, [password, calcStrength]);

  useEffect(() => {
    let active = true;
    runBridge(() => ({
      href: window.location.href,
      clearUrl: () => window.history.replaceState(null, '', window.location.pathname),
      passwordAuth: () => getSupabase().auth,
      ephemeralAuth: () => createEphemeralSupabase().auth,
      fetch: (...args) => window.fetch(...args),
      navigate: (url) => window.location.replace(url),
    })).then((outcome) => {
      if (!active) return;
      switch (outcome.view) {
        case 'form':
          setFlow(outcome.flow);
          setState('form');
          return;
        case 'password-link-expired':
          setFlow(outcome.flow);
          setErrorMsg(COPY[outcome.flow].expired);
          setState('error');
          return;
        case 'signup-confirmed':
          setState('signup-confirmed');
          return;
        case 'redirecting':
          setState('redirecting');
          return;
        case 'signup-failed':
          setErrorMsg(SIGNUP_FAILED);
          break;
        case 'link-error':
          setErrorMsg(outcome.activation ? ACTIVATION_LINK : LINK_USED);
          break;
        case 'invalid':
          if (outcome.activation) setErrorMsg(ACTIVATION_LINK);
          break;
        case 'activation-failed':
          if (outcome.error !== 'link') setErrorTitle('No se ha podido abrir el pago');
          setErrorMsg(ACTIVATION_ERRORS[outcome.error]);
          break;
      }
      setState('error');
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (state === 'form') passwordRef.current?.focus();
  }, [state]);

  const submitPassword = async () => {
    setFormError('');
    setConfirmError('');

    if (password.length < 8) {
      setFormError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setConfirmError('Las contraseñas no coinciden.');
      return;
    }

    setLoading(true);

    const { error } = await getSupabase().auth.updateUser({ password });

    if (error) {
      setLoading(false);
      setFormError('Error al guardar la contraseña. Inténtalo de nuevo.');
      return;
    }

    setState('success');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && state === 'form') submitPassword();
  };

  return (
    <>
      {/* LOADING */}
      {state === 'loading' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <div className="skeleton-line" style={{ width: '55%' }} />
          <div className="skeleton-line" style={{ width: '80%' }} />
          <div className="skeleton-line" style={{ width: '65%' }} />
        </div>
      )}

      {/* FORM */}
      {state === 'form' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <h1>{COPY[flow].title}</h1>
          <p className="subtitle">{COPY[flow].subtitle}</p>

          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <div className="input-wrapper">
              <input
                ref={passwordRef}
                type={showPw ? 'text' : 'password'}
                id="password"
                placeholder="Mínimo 8 caracteres"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={formError ? 'invalid' : ''}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="toggle-vis"
                aria-label="Mostrar contraseña"
                onClick={() => setShowPw(!showPw)}
              >
                {showPw ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <div className="strength-bar">
              <div
                className="strength-fill"
                style={{ width: `${strength.pct}%`, background: strength.color }}
              />
            </div>
            <div className="strength-label">{strength.label}</div>
          </div>

          <div className="field">
            <label htmlFor="confirm">Repite la contraseña</label>
            <div className="input-wrapper">
              <input
                type={showCf ? 'text' : 'password'}
                id="confirm"
                placeholder="Repite la contraseña"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={confirmError ? 'invalid' : ''}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="toggle-vis"
                aria-label="Mostrar contraseña"
                onClick={() => setShowCf(!showCf)}
              >
                {showCf ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {confirmError && <div className="field-error">{confirmError}</div>}
          </div>

          {formError && (
            <div className="alert alert-error">
              <svg
                className="alert-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {formError}
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={submitPassword}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="spinner" /> Guardando…
              </>
            ) : (
              'Guardar contraseña'
            )}
          </button>
        </div>
      )}

      {/* SUCCESS */}
      {state === 'success' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <div className="success-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16a34a"
              strokeWidth="2.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1>¡Contraseña guardada!</h1>
          <p className="subtitle">{COPY[flow].done}</p>

          <a href={`${appScheme}://`} className="btn btn-green">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            Abrir Trazea
          </a>

          <hr className="divider" />
          <p className="note">
            Si el botón no abre la app, busca &quot;Trazea&quot; en tu iPhone y ábrela
            directamente.
          </p>
        </div>
      )}

      {/* SIGNUP CONFIRMADO */}
      {state === 'signup-confirmed' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <div className="success-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16a34a"
              strokeWidth="2.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1>Email confirmado, vuelve a la app</h1>
          <p className="subtitle">
            Abre Trazea en tu móvil e inicia sesión con tu email y tu contraseña.
          </p>

          <a href={`${appScheme}://login`} className="btn btn-green">
            Volver a Trazea
          </a>

          <hr className="divider" />
          <p className="note">
            Si el botón no abre la app, busca &quot;Trazea&quot; en tu móvil y ábrela
            directamente.
          </p>
        </div>
      )}

      {/* ACTIVACIÓN: camino del Checkout */}
      {state === 'redirecting' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <h1>Abriendo la página de pago segura…</h1>
          <p className="subtitle">
            Te llevamos a Stripe para completar la activación. Cuando termines, vuelve a la app.
          </p>
        </div>
      )}

      {/* ERROR */}
      {state === 'error' && (
        <div className="card">
          <Image src="/logo.svg" alt="Trazea" width={120} height={32} className="logo" unoptimized />
          <div style={{ marginBottom: '1.25rem' }}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#dc2626"
              strokeWidth="1.75"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1>{errorTitle}</h1>
          <p className="subtitle">{errorMsg || COPY[flow].invalid}</p>
        </div>
      )}

      <p className="page-footer">Trazea — Trazabilidad alimentaria</p>
    </>
  );
}
