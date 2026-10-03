# trazea-auth

Puente web entre los emails de Supabase Auth y la app Trazea. Acepta cuatro tipos de enlace y rechaza todo lo demás:

| Enlace | Qué hace |
|---|---|
| `type=invite` / `type=recovery` | Formulario para crear o cambiar la contraseña y botón a `trazea://` |
| `type=signup` | Comprueba el enlace y muestra "Email confirmado, vuelve a la app" con un botón a `trazea://login`. No pide contraseña ni crea negocio |
| `type=magiclink` **solo** con `?next=activate&interval=month\|year` | Muestra una confirmación con el plan y el botón **Continuar al pago**. Solo al pulsarlo verifica el enlace, pide el Checkout de activación a la API con el JWT de esa sesión y redirige a `https://checkout.stripe.com/…` |

**URL de producción:** `https://auth.trazea.es`

---

## Configuración

Copia `.env.example` a `.env.local` y rellena las variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://XXXXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxx
NEXT_PUBLIC_APP_SCHEME=trazea
```

> `NEXT_PUBLIC_SUPABASE_ANON_KEY` es la clave **pública** (anon/publishable). Es seguro incluirla en el frontend.  
> **Nunca** uses `SUPABASE_SERVICE_KEY` aquí.

---

## Desarrollo local

```bash
npm install
npm run dev
npm test      # Vitest: parseo, guardas y flujos con Supabase y fetch simulados
```

---

## Despliegue en Vercel

### 1. Subir a GitHub

```bash
git add .
git commit -m "Convert to Next.js"
git push
```

### 2. Crear/actualizar proyecto en Vercel

1. Ve a [vercel.com](https://vercel.com) → **Add New Project** (o actualiza el existente)
2. Importa el repositorio `trazea-auth`
3. Framework Preset: **Next.js** (auto-detectado)
4. **Variables de entorno**: Añade en Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_APP_SCHEME`
5. Haz clic en **Deploy**

### 3. Añadir dominio personalizado

1. En Vercel → Settings → Domains → añade `auth.trazea.es`
2. En tu DNS (donde gestiones `trazea.es`) añade:
   ```
   CNAME  auth  cname.vercel-dns.com
   ```
3. Vercel provisionará el certificado TLS automáticamente

---

## Configuración en Supabase

Una vez desplegado en `https://auth.trazea.es`:

**Authentication → URL Configuration:**

| Campo | Valor |
|-------|-------|
| Site URL | `https://auth.trazea.es` |
| Redirect URLs | `trazea://**`, `https://auth.trazea.es/**` |

La activación usa `emailRedirectTo: https://auth.trazea.es/?next=activate&interval=…`. Si Supabase no acepta esa URL, redirige al Site URL sin la query y el puente rechaza el enlace.

### Qué está en el código y qué es configuración externa

| | Dónde | Estado |
|---|---|---|
| `token_hash` para `signup` y para `magiclink` con `next=activate` | Código (`parseLanding`, `verifyOtp`) | Hecho |
| La sesión en el hash (`{{ .ConfirmationURL }}`) | Código | Se sigue aceptando: los emails antiguos funcionan mientras no estén consumidos |
| La activación espera al clic en **Continuar al pago** | Código (`authBridge.ts` → `activation-confirm`, `page.tsx`) | Hecho |
| La plantilla *Magic Link* manda `token_hash` en vez de `{{ .ConfirmationURL }}` | **Dashboard de Supabase** (manual, ver abajo) | Pendiente de aplicar a mano |
| La Redirect URL `https://auth.trazea.es/**` | Dashboard de Supabase | Ya funciona; no ampliarla |
| `CORS_ORIGINS` con `https://auth.trazea.es` | trazea-api (`render.yaml`, Render) | Hecho (preflight comprobado el 2-oct-2026); era un fallo independiente |

**Por qué hace falta el cambio manual.** Con `{{ .ConfirmationURL }}` el enlace del email apunta a Supabase, que verifica el token en el primer GET. Los escáneres y previsualizadores de correo hacen ese GET antes que la persona, así que cuando ella pulsa ya recibe `otp_expired`. Ningún cambio en este repo evita ese GET: hay que cambiar la plantilla para que el email apunte al puente con `token_hash`. Entonces el puente no gasta nada al cargar, y solo el clic en **Continuar al pago** llama a `verifyOtp`.

**Plantillas de email.** El puente acepta los dos formatos:

- `{{ .ConfirmationURL }}`: Supabase verifica el enlace y redirige con la sesión en el hash (`#access_token=…&refresh_token=…&type=…`). En signup, el email ya queda confirmado **antes** de llegar a esta página. Para la activación, el puente también espera al clic, pero el token ya lo ha gastado el primer GET.
- `token_hash` en la query, sin verificar:
  - *Confirm signup* (opcional): `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=signup`. Se verifica al cargar, como hasta ahora.
  - *Magic Link* (activación): `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=magiclink`. Se verifica **solo al pulsar**.

Si el enlace ya se usó o caducó, Supabase redirige con `#error=…&error_code=otp_expired`. La página lo dice sin mostrar un éxito falso y, si era de activación, ofrece volver a la pantalla Activar de la app (`trazea://activate`) para pedir otro. El puente nunca envía emails.

### Cambio manual en Supabase (plantilla Magic Link)

No lo aplica ningún deploy. Hazlo **después** de desplegar el puente nuevo y comprobar que funciona:

1. Abre el proyecto correcto de Trazea en Supabase → **Authentication → Email Templates → Magic Link**.
2. Conserva el asunto y el diseño. Sustituye el enlace de activación cuyo `href` usa `{{ .ConfirmationURL }}` por:
   ```html
   <a href="{{ .RedirectTo }}&amp;token_hash={{ .TokenHash }}&amp;type=magiclink">Continuar con la activación</a>
   ```
3. Guarda la plantilla. En este flujo `.RedirectTo` ya contiene `?next=activate&interval=month|year`, por eso los parámetros se añaden con `&amp;`.
   - Hoy el único emisor de esta plantilla es la pantalla Activar de trazea-app (`signInWithOtp` con `emailRedirectTo`, comprobado en app, API y web). Un magic link sin `redirectTo` con query, por ejemplo el que se envía desde el dashboard, quedaría como `https://auth.trazea.es&token_hash=…` y no funcionaría. Si algún día aparece otro uso, revisa sus redirects antes de dar esta concatenación por universal.
4. No toques *Confirm signup*, *Invite user* ni *Reset password*. La allowlist ya funciona; no la amplíes para este fix.
5. Pide un email **nuevo** desde la app: los emails anteriores no cambian y un token consumido no revive.

Referencia: <https://supabase.com/docs/guides/auth/auth-email-templates>

## Configuración en trazea-api

El navegador llama a `POST https://api.trazea.es/v1/billing/activation-checkout`: `CORS_ORIGINS` (Render) tiene que incluir `"https://auth.trazea.es"`. Si no, el preflight falla y la página muestra "No hemos podido abrir la página de pago", aunque el enlace funcione.

### Diagnóstico del Checkout

Cuando el POST falla, la página escribe en la consola del navegador `[trazea-auth] activation-checkout` con un objeto como este:

| `category` | Qué significa | Campos |
|---|---|---|
| `network` | El `fetch` se rechazó sin respuesta: CORS, red caída, bloqueador… El navegador no dice cuál y la página **no lo afirma**. Mira la pestaña Red: un preflight `OPTIONS` fallido apunta a CORS | ninguno |
| `timeout` | La API no respondió en 20 s | ninguno |
| `http` | La API respondió con error (4xx/5xx) | `status`, y `error_code` solo si tiene forma de código (`[A-Za-z][A-Za-z0-9_]*`, ≤64) |
| `invalid-response` | Un 2xx sin una URL `https://checkout.stripe.com/…` válida | `status` |

Nunca incluye el JWT, el `token_hash`, la URL de Stripe, el cuerpo de la respuesta ni datos personales.

### Lo que no se hace

- En iOS/Android la app **no** abre Stripe directamente (está descartado por política de tiendas): solo envía el email de activación. El pago ocurre en el navegador, a través de este puente.
- El acceso solo cambia cuando la API marca `paid` tras el webhook de Stripe. Volver de Stripe no prueba nada.

## Orden de despliegue

1. trazea-api: `CORS_ORIGINS` con `https://auth.trazea.es`. Ya hecho: el preflight desde `https://auth.trazea.es` responde 200 con ese origen.
2. trazea-auth: desplegar en Vercel y comprobar que un enlace antiguo (`#access_token=…&type=magiclink`) llega a la confirmación y que `invite`, `recovery` y `signup` siguen igual.
3. Supabase: el cambio manual de la plantilla Magic Link (arriba).
4. trazea-app: la release con "Usa solo el último email" y el cooldown. No bloquea el fix.
5. Prueba real con un email **nuevo**: abrir la URL sin pulsar no debe consumir el token (recargar el email y volver a abrir debe seguir mostrando la confirmación). Pulsar debe abrir un único Checkout con el intervalo elegido. No completes el pago.

---

## Estructura del proyecto

```
trazea-auth/
├── src/
│   ├── app/           # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx   # Página principal
│   │   ├── page.test.tsx  # npm test (jsdom): la página real, clic incluido
│   │   └── globals.css
│   └── lib/
│       ├── authBridge.ts       # Parseo del enlace, guardas y flujos (sin React)
│       ├── authBridge.test.ts  # npm test
│       ├── navigation.ts       # Salida a Stripe (location.replace)
│       └── supabase.ts
├── public/
│   └── logo.svg
├── next.config.ts
├── package.json
└── vercel.json
```

## Flujo de usuario

1. Admin invita a un usuario desde la app → Supabase envía email
2. Usuario hace clic en el enlace → llega a `https://auth.trazea.es/#access_token=...&type=invite`
3. La página establece la sesión con Supabase y muestra el formulario
4. Usuario introduce su contraseña y la guarda
5. Pantalla de éxito con botón **Abrir Trazea** (`trazea://`)

### Activación (trial → pago)

1. En la app, pantalla **Activar** → `signInWithOtp` con `emailRedirectTo: https://auth.trazea.es/?next=activate&interval=month`
2. El enlace del email llega aquí con `token_hash` en la query (o, en emails antiguos, con la sesión en el hash). La página borra la URL nada más cargar y guarda en memoria lo necesario para el clic. Muestra el plan y el botón **Continuar al pago**; cargar, previsualizar o montar dos veces (Strict Mode) no verifica nada
3. Al pulsar (una sola vez, aunque se pulse dos veces): `verifyOtp({ token_hash, type: 'magiclink' })`, `activation-checkout` con `Authorization: Bearer <JWT>` y comprobación de que la respuesta es una URL `https://checkout.stripe.com/…`. Si algo falla no se reintenta: el enlace ya está gastado y la página pide uno nuevo desde la app
4. Cierra solo esa sesión web (`signOut({ scope: 'local' })`, nunca `global`, que cerraría también la del móvil) y redirige con `location.replace`
5. Volver de Stripe no demuestra nada: la app consulta `GET /v1/billing/status` (trazea-api `docs/TRIALS.md` §5)
