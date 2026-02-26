'use client';

import Image from 'next/image';
import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';

const STRENGTH = [
  { pct: 0, color: '', label: '' },
  { pct: 25, color: '#ef4444', label: 'Muy débil' },
  { pct: 50, color: '#f97316', label: 'Débil' },
  { pct: 75, color: '#eab308', label: 'Aceptable' },
  { pct: 100, color: '#1dba5d', label: 'Fuerte' },
];

function parseHash(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const hash = window.location.hash.slice(1);
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

type State = 'loading' | 'form' | 'success' | 'error';

export default function AuthPage() {
  const [state, setState] = useState<State>('loading');
  const [errorMsg, setErrorMsg] = useState('');
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
    (async () => {
      const params = parseHash();

      if (!params.access_token || !params.refresh_token || params.type !== 'invite') {
        setState('error');
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
      });

      if (error) {
        setErrorMsg(
          'El enlace de invitación ha expirado. Contacta con el administrador para solicitar uno nuevo.'
        );
        setState('error');
        return;
      }

      setState('form');
    })();
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

    const { error } = await supabase.auth.updateUser({ password });

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
          <h1>Crea tu contraseña</h1>
          <p className="subtitle">
            Has sido invitado a Trazea. Elige una contraseña para activar tu cuenta.
          </p>

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
          <p className="subtitle">
            Tu cuenta está lista. Abre la app Trazea en tu iPhone para acceder.
          </p>

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
          <h1>Enlace inválido</h1>
          <p className="subtitle">
            {errorMsg ||
              'El enlace de invitación ha expirado o no es válido. Contacta con el administrador para solicitar una nueva invitación.'}
          </p>
        </div>
      )}

      <p className="page-footer">Trazea — Trazabilidad alimentaria</p>
    </>
  );
}
